import { PROFILE_MANAGED_ENV_KEYS, type ProfileManagedEnvKey } from './profileEnvKeys.js'
import type { ModelProfile } from '../customApiStorage.js'

export type ModelSwitchPhase = 'apply' | 'persist' | 'commit'

export class ModelSwitchError extends Error {
  readonly phase: ModelSwitchPhase
  constructor(phase: ModelSwitchPhase, cause: unknown) {
    super(
      `Model switch failed at ${phase}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'ModelSwitchError'
    this.phase = phase
  }
}

/**
 * Delete all profile-managed env vars unconditionally.
 *
 * MUST be called as step 2 of switchModelProfileAtomic (after snapshot,
 * before applyModelProfile). Safe to call repeatedly; `delete` on an
 * undefined key is a no-op.
 */
export function clearProfileEnvVars(): void {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    delete process.env[key]
  }
}

/**
 * Capture current values of all profile-managed env vars for rollback.
 */
export function captureEnvSnapshot(): Record<ProfileManagedEnvKey, string | undefined> {
  const snapshot = {} as Record<ProfileManagedEnvKey, string | undefined>
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    snapshot[key] = process.env[key]
  }
  return snapshot
}

/**
 * Restore env vars from a snapshot. Deletes keys that were undefined in
 * the snapshot rather than setting them to the string "undefined".
 */
export function restoreEnvSnapshot(snapshot: Record<ProfileManagedEnvKey, string | undefined>): void {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    const value = snapshot[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

/**
 * Env vars that `applyModelProfile` mutates but that are NOT in
 * PROFILE_MANAGED_ENV_KEYS (and therefore not covered by captureEnvSnapshot).
 * The atomic transaction must snapshot + restore these too so a failed
 * switch leaves env exactly as it was before the transaction.
 *
 * Note: DOGE_API_KEY and ANTHROPIC_AUTH_TOKEN are mutually exclusive — the
 * active profile writes one or the other depending on authTokenType. We
 * snapshot both; restore deletes whichever was undefined in the snapshot.
 */
const APPLY_EXTRA_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BASE_URL',
  'DOGE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_COMPATIBLE_API_PROVIDER',
] as const

/**
 * Snapshot the non-whitelisted env vars that `applyModelProfile` writes
 * (model, base URL, API key, provider). Required because the white-list
 * snapshot alone does not cover these, so a failed apply/persist/commit
 * would leak the new profile's endpoint/key/provider.
 */
export function captureApplyEnvSnapshot(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {}
  for (const key of APPLY_EXTRA_ENV_KEYS) {
    snap[key] = process.env[key]
  }
  return snap
}

/**
 * Restore the non-whitelisted apply-env vars from a snapshot. Keys that
 * were undefined in the snapshot are deleted rather than set to the
 * string "undefined".
 */
export function restoreApplyEnvSnapshot(snap: Record<string, string | undefined>): void {
  for (const key of APPLY_EXTRA_ENV_KEYS) {
    const value = snap[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

// ── Task 3: Atomic switch + Tier switch ────────────────────────────

/**
 * Dependencies are injected for testability. The default-bound versions live in
 * `./switchModelProfile.bindings.ts` (created later); the /model command imports
 * from there to get a pre-wired API. Test files inject mocks directly.
 */
export interface SwitchProfileDeps {
  applyProfile: (profile: ModelProfile) => void
  syncToDisk: (model: string, clearCredentials: boolean) => void
  commitAppState: (updater: (prev: AppStateSlice) => AppStateSlice) => void
}

export interface SwitchTierDeps {
  syncToDisk: (model: string, clearCredentials: boolean) => void
  commitAppState: (updater: (prev: AppStateSlice) => AppStateSlice) => void
}

export interface AppStateSlice {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
}

export type TierAlias = 'opus' | 'sonnet' | 'haiku' | null

/**
 * Atomically switch to a new ModelProfile. See design §1.2 / §4.A.
 *
 * Steps:
 *  1. Snapshot all profile-managed env vars (white-list) PLUS the
 *     non-whitelisted env vars `applyModelProfile` writes (model, base URL,
 *     API key, provider). Both snapshots are needed: the white-list covers
 *     tier/subagent/behavior vars; the apply-extra snapshot covers the
 *     endpoint/key/provider that would otherwise leak on rollback.
 *  2. Clear the white-list env vars (white-list reset; see profileEnvKeys.ts).
 *  3. applyProfile(profile) → writes new env vars + persists customApiStorage.
 *  4. syncToDisk(profile.model, true) → updates .claude.json + settings.json.
 *  5. commitAppState → mainLoopModel := profile.model, mainLoopModelForSession := null.
 *
 * On failure at step 3/4/5 BOTH snapshots are restored (so env is exactly as
 * before the transaction) and a ModelSwitchError (phase 'apply' | 'persist' |
 * 'commit') is thrown. Step 5 failure additionally re-runs syncToDisk with
 * the old model id (from the apply snapshot) to revert disk; if that also
 * fails the error is rethrown (phase 'commit') and the caller surfaces a
 * "manual restart recommended" toast.
 */
export async function switchModelProfileAtomic(
  profile: ModelProfile,
  deps: SwitchProfileDeps,
): Promise<void> {
  const snapshot = captureEnvSnapshot()
  const applySnapshot = captureApplyEnvSnapshot()

  clearProfileEnvVars()

  // Step 3: applyProfile
  try {
    deps.applyProfile(profile)
  } catch (cause) {
    restoreEnvSnapshot(snapshot)
    restoreApplyEnvSnapshot(applySnapshot)
    throw new ModelSwitchError('apply', cause)
  }

  // Step 4: syncToDisk
  try {
    deps.syncToDisk(profile.model, true)
  } catch (cause) {
    restoreEnvSnapshot(snapshot)
    restoreApplyEnvSnapshot(applySnapshot)
    throw new ModelSwitchError('persist', cause)
  }

  // Step 5: commit AppState
  try {
    deps.commitAppState((prev) => ({
      ...prev,
      mainLoopModel: profile.model,
      mainLoopModelForSession: null,
    }))
  } catch (cause) {
    restoreEnvSnapshot(snapshot)
    restoreApplyEnvSnapshot(applySnapshot)
    // Best-effort disk revert. If oldModel was undefined (running on default)
    // persist empty string so disk does not retain the failed profile's model.
    const oldModel = applySnapshot.ANTHROPIC_MODEL
    try {
      deps.syncToDisk(oldModel ?? '', true)
    } catch (rollbackCause) {
      // Best-effort; surface to console so the swallowed failure is observable.
      try {
        ;(globalThis as any)?.console?.warn?.(
          'modelSwitch: best-effort disk rollback failed:',
          rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause),
        )
      } catch {
        /* truly best-effort */
      }
    }
    throw new ModelSwitchError('commit', cause)
  }
}

/**
 * Switch to a tier alias (opus/sonnet/haiku) or back to default (null).
 * Does NOT touch any env vars — relies on the invariant that env vars
 * reflect ONLY the currently active ModelProfile (guaranteed by atomic).
 *
 * - tier = 'opus' | 'sonnet' | 'haiku': commits the alias string as mainLoopModel
 * - tier = null: clears mainLoopModel so it falls back to ANTHROPIC_MODEL default
 */
export function switchTier(tier: TierAlias, deps: SwitchTierDeps): void {
  const modelString = tier
  deps.syncToDisk(modelString ?? '', true)
  deps.commitAppState((prev) => ({
    ...prev,
    mainLoopModel: modelString,
    mainLoopModelForSession: null,
  }))
}

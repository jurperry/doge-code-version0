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
  syncToDisk: (
    model: string,
    clearCredentials: boolean,
    credentialSourceProfile?: ModelProfile,
  ) => void
  commitAppState: (updater: (prev: AppStateSlice) => AppStateSlice) => void
  /** Session-scoped switch (multi-terminal isolation): commit writes
   *  `mainLoopModelForSession` only and the commit-phase disk rollback is
   *  skipped. The caller is expected to pass a no-op syncToDisk and a
   *  non-persisting applyProfile alongside this flag. */
  sessionScoped?: boolean
}

export interface SwitchTierDeps {
  syncToDisk: (
    model: string,
    clearCredentials: boolean,
    credentialSourceProfile?: ModelProfile,
  ) => void
  commitAppState: (updater: (prev: AppStateSlice) => AppStateSlice) => void
  /** Resolve a tier alias ('opus'|'sonnet'|'haiku') to the real model ID
   *  the active profile maps it to (e.g. 'haiku' → 'deepseek-v4-flash').
   *  Real binding: parseUserSpecifiedModel(tier). */
  resolveTierModel: (tier: 'opus' | 'sonnet' | 'haiku') => string
  /** Persist the tier selection (activeTier + tier mapping snapshot) to disk.
   *  Real binding: persistTierSelection. */
  persistTier: (tier: TierAlias) => void
  /** Return the persisted main model id (custom API users), or undefined for
   *  first-party users with no custom API config.
   *  Real binding: () => readCustomApiStorage().model */
  getStoredMainModel: () => string | undefined
  /** Session-scoped switch: commit targets `mainLoopModelForSession` and a
   *  `null` tier simply clears the session override (back to baseline).
   *  Callers pass a no-op persistTier / syncToDisk alongside this flag. */
  sessionScoped?: boolean
}

export interface AppStateSlice {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
}

export type TierAlias = 'opus' | 'sonnet' | 'haiku' | null

/**
 * Commit-fields factory shared by the atomic profile switch and the tier
 * switch. Global scope (legacy) writes the main-model slot and clears any
 * session override; session scope writes only `mainLoopModelForSession`
 * so `mainLoopModel` (and everything persisted from it) stays untouched.
 */
function commitFields(
  model: string | null,
  sessionScoped?: boolean,
): (prev: AppStateSlice) => AppStateSlice {
  if (sessionScoped) {
    return prev => ({ ...prev, mainLoopModelForSession: model })
  }
  return prev => ({
    ...prev,
    mainLoopModel: model,
    mainLoopModelForSession: null,
  })
}

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
 *  4. syncToDisk(profile.model, false, profile) → updates .claude.json +
 *     settings.json AND persists the target profile's credentials as the
 *     top-level credentials. clearCredentials MUST be false here: wiping
 *     top-level credentials on every profile switch left a bare `doge`
 *     relaunch with no key at all ("Not logged in"). That wipe used to be
 *     masked because the tier-switch path re-persisted credentials as a
 *     side effect; it must not come back. (Session-scoped switches pass a
 *     no-op syncToDisk here — disk keeps the global baseline.)
 *  5. commitAppState → global scope: mainLoopModel := profile.model,
 *     mainLoopModelForSession := null; session scope:
 *     mainLoopModelForSession := profile.model (mainLoopModel untouched).
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

  // Step 4: syncToDisk — persist the new model together with ITS OWN
  // credentials so a bare restart (no start-script env) can authenticate.
  try {
    deps.syncToDisk(profile.model, false, profile)
  } catch (cause) {
    restoreEnvSnapshot(snapshot)
    restoreApplyEnvSnapshot(applySnapshot)
    throw new ModelSwitchError('persist', cause)
  }

  // Step 5: commit AppState
  try {
    deps.commitAppState(commitFields(profile.model, deps.sessionScoped))
  } catch (cause) {
    restoreEnvSnapshot(snapshot)
    restoreApplyEnvSnapshot(applySnapshot)
    // Best-effort disk revert. If oldModel was undefined (running on default)
    // persist empty string so disk does not retain the failed profile's model.
    // Session-scoped switches never wrote disk, so nothing to revert.
    if (!deps.sessionScoped) {
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
    }
    throw new ModelSwitchError('commit', cause)
  }
}

/**
 * Switch to a tier alias (opus/sonnet/haiku) or back to default (null).
 *
 * Tier path (opus/sonnet/haiku) — resolves the tier's REAL model id from env
 * (start scripts / applied profile) and commits it as the session's
 * mainLoopModel, but does NOT write it into the main-model slot on disk.
 * The old implementation persisted the resolved tier model as the main model
 * (.claude.json customApiEndpoint.model / settings.json model / storage),
 * which polluted the main model identity: after a restart the stored tier
 * mapping no longer matched any profile (profiles are keyed by main model),
 * so Opus/Sonnet/Haiku ALL fell back to that one model in /model — the
 * "switched to haiku, now every tier shows haiku" bug.
 *
 * Instead the tier selection is persisted separately (activeTier + a tier→model
 * snapshot, via persistTierSelection) and restored at startup by
 * restoreTierState.ts, which injects the env vars a start script would have.
 *
 * Default path (tier = null) —
 *  - custom API users (stored main model exists): clear the tier selection
 *    and return to the stored main model. Credentials are untouched: tier
 *    switches run against the same provider, so clearing them would break
 *    the next launch.
 *  - first-party users: clear model + stored credentials (legacy semantics).
 */
export function switchTier(tier: TierAlias, deps: SwitchTierDeps): void {
  // Session scope: tier switches and "default" only move the session
  // override; disk (persistTier/syncToDisk) is expected to be no-oped by
  // the caller, keeping other terminals on the global baseline.
  if (deps.sessionScoped) {
    if (tier === null) {
      // Revert to baseline by clearing the session override.
      deps.commitAppState(commitFields(null, true))
      return
    }
    const realTierModel = deps.resolveTierModel(tier)
    deps.commitAppState(commitFields(realTierModel, true))
    return
  }
  if (tier === null) {
    const storedMainModel = deps.getStoredMainModel()
    if (storedMainModel) {
      // 自定义 API 用户：清层级选择，主循环模型回到持久化的主模型
      deps.persistTier(null)
      deps.commitAppState(commitFields(storedMainModel, false))
      return
    }
    // 官方用户：清 model + 凭证（保持原有语义）
    deps.syncToDisk('', true, undefined)
    deps.commitAppState(commitFields(null, false))
    return
  }
  // tier 路径：解析真实 tier 模型 ID，仅持久化层级选择，不改写主模型槽位
  const realTierModel = deps.resolveTierModel(tier)
  deps.persistTier(tier)
  deps.commitAppState(commitFields(realTierModel, false))
}

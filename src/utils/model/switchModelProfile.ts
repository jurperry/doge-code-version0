import { PROFILE_MANAGED_ENV_KEYS, type ProfileManagedEnvKey } from './profileEnvKeys.js'
import type { ModelProfile } from '../customApiStorage.js'
import { clearModelCapabilityOverrideCache } from './modelSupportOverrides.js'

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
  clearModelCapabilityOverrideCache()
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
  clearModelCapabilityOverrideCache()
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
   *  the ACTIVE provider maps it to (e.g. 'haiku' → 'deepseek-v4-flash').
   *  Real binding reads the tier env vars, then the active/stored profile. */
  resolveTierModel: (tier: 'opus' | 'sonnet' | 'haiku') => string
  /** Resolve what "Default (recommended)" means RIGHT NOW: the active
   *  provider's Sonnet-tier model, falling back to its main model when the
   *  Sonnet tier is not configured. Returns null when neither is knowable
   *  (first-party user with no custom API config) — the session override is
   *  then simply cleared. */
  resolveDefaultModel: () => string | null
  /** Scrub deprecated global tier state (activeTier/tierModels) from disk.
   *  Real binding: clearLegacyTierState. Called on the global-scope default
   *  path as the migration hook. */
  clearLegacyTier?: () => void
  /** Return the persisted main model id (custom API users), or undefined for
   *  first-party users with no custom API config.
   *  Real binding: () => readCustomApiStorage().model */
  getStoredMainModel: () => string | undefined
  /** Session-scoped switch: commit targets `mainLoopModelForSession` and a
   *  `null` tier resolves the provider default rather than persisting.
   *  Callers pass a no-op syncToDisk alongside this flag. */
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
 * Since the 2026-09-07 provider refactor tier selections are ALWAYS
 * session-scoped: Opus/Sonnet/Haiku are views over the ACTIVE provider's
 * tier slots, and committing one only moves `mainLoopModelForSession` in
 * this process. Nothing is persisted — the previous design (activeTier +
 * tierModels snapshot, restored into env/ANTHROPIC_MODEL at every launch)
 * leaked one terminal's tier choice into every other terminal and into the
 * /model "custom model" list, breaking multi-terminal isolation.
 *
 * Tier path (opus/sonnet/haiku) — resolves the tier's REAL model id (env
 * first, then the active profile) and commits it as the session main loop
 * model. Never touches the persisted main-model slot, env, or disk.
 *
 * Default path (tier = null) —
 *  - session scope (the normal path): "Default (recommended)" means the
 *    active provider's Sonnet-tier model, falling back to its main model
 *    when no Sonnet tier is configured (resolveDefaultModel). Commits that
 *    as the session override so the picker's Default row and the actually
 *    used model stay identical even after a session-scoped provider switch.
 *  - global scope (legacy / DOGE_MODEL_SCOPE=global):
 *      · custom API users (stored main model exists): scrub deprecated
 *        global tier state and return the persisted main model; credentials
 *        untouched.
 *      · first-party users: clear model + stored credentials (legacy
 *        semantics).
 */
export function switchTier(tier: TierAlias, deps: SwitchTierDeps): void {
  if (tier !== null) {
    // Tier alias: always session-scoped — a persisted tier would decide the
    // main model of every other terminal and every future launch.
    const realTierModel = deps.resolveTierModel(tier)
    deps.commitAppState(commitFields(realTierModel, true))
    return
  }
  // Default path.
  if (deps.sessionScoped) {
    const defaultModel = deps.resolveDefaultModel()
    deps.commitAppState(commitFields(defaultModel, true))
    return
  }
  const storedMainModel = deps.getStoredMainModel()
  if (storedMainModel) {
    // 自定义 API 用户：清掉废弃的全局层级状态，主循环模型回到持久化的主模型
    deps.clearLegacyTier?.()
    deps.commitAppState(commitFields(storedMainModel, false))
    return
  }
  // 官方用户：清 model + 凭证（保持原有语义）
  deps.clearLegacyTier?.()
  deps.syncToDisk('', true, undefined)
  deps.commitAppState(commitFields(null, false))
}

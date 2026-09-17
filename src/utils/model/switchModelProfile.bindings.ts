/**
 * Pre-wired bindings for switchModelProfile transactions. UI/command code
 * imports from here; tests import the dep-injected functions directly.
 *
 * Both `syncToDisk` and `setAppState` are injected by the caller (the
 * /model command). `syncToDisk` lives inside the compiled artifact
 * `src/commands/model/model.tsx`; `setAppState` is the value returned by
 * the `useSetAppState()` hook from `src/state/AppState.tsx`, which can
 * only be resolved inside a React component context (and `.tsx` re-exports
 * drag React into a model util). Passing both at call time keeps the
 * dependency direction clean (model utils → lower layers, not → commands
 * or React) and leaves the test path fully dep-injected.
 *
 * `sessionScoped` (default true) is the multi-terminal isolation switch:
 * when set, profile/tier switches mutate env + AppState only — applyModelProfile
 * skips its storage write, syncToDisk is replaced by a no-op, and the commit
 * targets `mainLoopModelForSession`. Pass false to restore the legacy
 * persist-to-disk behavior (e.g. /model <name> --save). Tier aliases are
 * session-scoped in BOTH modes (they never persist — see switchTier).
 */
import { logForDebugging } from '../debug.js'
import { applyModelProfile, clearLegacyTierState, getModelProfile, normalizeModelName, readCustomApiStorage, type ModelProfile } from '../customApiStorage.js'
import {
  switchModelProfileAtomic as switchModelProfileAtomicCore,
  switchTier as switchTierCore,
  type AppStateSlice,
  type TierAlias,
} from './switchModelProfile.js'
import { noopSyncToDisk } from './modelSwitchScope.js'

type SyncToDisk = (
  model: string,
  clearCredentials: boolean,
  credentialSourceProfile?: ModelProfile,
) => void

/**
 * Bridge the core's slice-typed updater to the real `setAppState` hook
 * (`(prev: AppState) => AppState`). `any` is used because the core's updater
 * returns `{...prev, mainLoopModel, mainLoopModelForSession}` — a full
 * AppState by spread — but TypeScript can't see that without importing the
 * full AppState type into this model-util layer, which would couple the
 * utils to the state store and pull React-adjacent code into a pure util.
 */
function bindCommit(setAppState: (f: (prev: any) => any) => void) {
  return (updater: (prev: AppStateSlice) => AppStateSlice) =>
    setAppState((prev: any) => updater(prev))
}

/**
 * Look up a ModelProfile for a model string the user picked. Identity is the
 * model id (the pickers only carry model strings); when SEVERAL stored
 * profiles share that id — allowed, since provider identity is providerName —
 * prefer the profile whose endpoint the ACTIVE env points at
 * (ANTHROPIC_BASE_URL / key are written by applyModelProfile on every
 * switch), so re-picking the already-active provider is a no-op re-apply
 * instead of silently switching to an arbitrary same-model provider. Falls
 * back to the first match (historic behavior).
 */
export function findProfileByModel(
  model: string | null | undefined,
): ModelProfile | null {
  if (!model) return null
  const target = normalizeModelName(model)
  const matches = (readCustomApiStorage().modelProfiles ?? []).filter(
    p => normalizeModelName(p.model) === target,
  )
  if (matches.length === 0) return null
  if (matches.length > 1) {
    const envBase = process.env.ANTHROPIC_BASE_URL?.trim()
    const envKey = process.env.DOGE_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN
    if (envBase) {
      const sameEndpoint =
        matches.find(
          p =>
            p.baseURL?.trim() === envBase &&
            (!p.apiKey || p.apiKey === envKey),
        ) ?? matches.find(p => p.baseURL?.trim() === envBase)
      if (sameEndpoint) {
        logForDebugging(
          `[modelSwitch] ${matches.length} profiles share model '${model}' — using the active endpoint's profile '${sameEndpoint.providerName ?? sameEndpoint.model}'`,
        )
        return sameEndpoint
      }
    }
  }
  return matches[0]
}

/**
 * Apply the stored profile matching `model` to process env (session-scoped:
 * no disk writes), for switch paths that resolve the model via
 * setMainLoopModelOverride rather than the AppState session slot — i.e. the
 * headless/SDK entry points in print.ts (set_model control request,
 * set_settings.model, SDK onSetModel, CCR metadata restore). Those used to
 * write only the override, so picking a stored provider's model string sent
 * it to whatever endpoint env still pointed at (wrong-endpoint requests).
 *
 * Returns true when a profile was found and applied. Failures roll env back
 * (switchModelProfileAtomic) and return false — the caller still sets the
 * override, matching the previous behavior.
 */
export async function applyProfileForModelIfMatch(model: string): Promise<boolean> {
  const profile = findProfileByModel(model)
  if (!profile) return false
  try {
    await switchModelProfileAtomicCore(profile, {
      applyProfile: p => applyModelProfile(p, { persist: false }),
      syncToDisk: noopSyncToDisk,
      // Headless resolves the main loop model via setMainLoopModelOverride;
      // there is no interactive AppState session slot to commit.
      commitAppState: () => {},
      sessionScoped: true,
    })
    return true
  } catch (e) {
    logForDebugging(
      `[modelSwitch] Headless profile application for '${model}' failed: ${e instanceof Error ? e.message : String(e)}`,
      { level: 'error' },
    )
    return false
  }
}

export interface BoundSwitchDeps {
  syncToDisk: SyncToDisk
  setAppState: (f: (prev: any) => any) => void
  /** true (default) = session-scoped switch, no disk writes. */
  sessionScoped?: boolean
}

export async function switchModelProfileAtomicBound(
  profile: ModelProfile,
  deps: BoundSwitchDeps,
): Promise<void> {
  const sessionScoped = deps.sessionScoped ?? true
  return switchModelProfileAtomicCore(profile, {
    applyProfile: (p) => applyModelProfile(p, { persist: !sessionScoped }),
    syncToDisk: sessionScoped ? noopSyncToDisk : deps.syncToDisk,
    commitAppState: bindCommit(deps.setAppState),
    sessionScoped,
  })
}

/**
 * The profile persisted as the DISK baseline (storage.model's own profile).
 * After a session-scoped provider switch env already carries the new
 * provider's tiers, so this storage fallback only matters at launch when
 * the session and the disk baseline coincide.
 */
function storedMainProfile() {
  const storedMain = readCustomApiStorage().model?.trim()
  return storedMain ? { storedMain, profile: getModelProfile(storedMain) } : { storedMain: undefined, profile: undefined }
}

function storedProfileTierField(
  profile: ModelProfile | undefined,
  tier: 'opus' | 'sonnet' | 'haiku',
): string | undefined {
  return tier === 'opus'
    ? profile?.defaultOpusModel
    : tier === 'sonnet'
      ? profile?.defaultSonnetModel
      : profile?.defaultHaikuModel
}

/** The profile the ACTIVE env describes: env.ANTHROPIC_MODEL is written by
 *  applyModelProfile on every (session or global) provider switch, so when
 *  it is set this is the provider actually in effect — which after a
 *  session-scoped switch may differ from the disk baseline profile. */
function activeEnvProfile() {
  const activeMain = process.env.ANTHROPIC_MODEL?.trim()
  return {
    activeMain,
    profile: activeMain ? getModelProfile(activeMain) : undefined,
  }
}

/**
 * Resolve what "Default (recommended)" maps to RIGHT NOW: the ACTIVE
 * provider's Sonnet-tier model, falling back to its main model when the
 * Sonnet tier is not configured. Returns null when neither is knowable
 * (first-party user with no custom API config).
 *
 * Priority: env sonnet tier → ACTIVE provider's sonnet field / main model
 * → disk-baseline profile's sonnet field → disk-baseline main model. The
 * active provider (env) outranks the disk baseline: after a session-scoped
 * switch the baseline's tier model id must NOT win, or Default would hand
 * one provider's model name to another provider's endpoint. The baseline
 * branch only runs at launch, when env and baseline coincide.
 *
 * Single source of truth for the Default semantics: switchTier(null)
 * commits the result of this chain, and the /model command renders the
 * same value in its "Set model to …" message. Reading the persisted disk
 * model instead showed a STALE provider's model after a session-scoped
 * switch (disk baseline ≠ active provider).
 */
export function resolveSessionDefaultModel(): string | null {
  const { activeMain, profile: activeProfile } = activeEnvProfile()
  if (activeMain || activeProfile) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      || storedProfileTierField(activeProfile, 'sonnet')
      || activeMain
      || null
  }
  const { storedMain, profile: baselineProfile } = storedMainProfile()
  return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || storedProfileTierField(baselineProfile, 'sonnet')
    || storedMain
    || null
}

export function switchTierBound(
  tier: TierAlias,
  deps: BoundSwitchDeps,
): void {
  const sessionScoped = deps.sessionScoped ?? true
  switchTierCore(tier, {
    syncToDisk: sessionScoped ? noopSyncToDisk : deps.syncToDisk,
    commitAppState: bindCommit(deps.setAppState),
    sessionScoped,
    resolveTierModel: (t) => {
      // Direct env lookup first: env reflects the ACTIVE provider (start
      // script or a just-applied profile) and bypasses
      // parseUserSpecifiedModel's fallback chain, which consults
      // getUserSpecifiedModelSetting() and can be polluted by a previous
      // tier switch's mainLoopModelOverride (e.g. after switching to Haiku,
      // getDefaultOpusModel would fallback to Haiku's real model).
      // When env lacks the tier var (profile has none configured —
      // applyModelProfile deletes it), fall back within the ACTIVE
      // provider (its profile field, then its main model) before ever
      // consulting the disk baseline: a baseline tier model id sent to the
      // active provider's endpoint is a wrong-model request.
      const envKey =
        t === 'opus' ? 'ANTHROPIC_DEFAULT_OPUS_MODEL'
        : t === 'sonnet' ? 'ANTHROPIC_DEFAULT_SONNET_MODEL'
        : 'ANTHROPIC_DEFAULT_HAIKU_MODEL'
      const { activeMain, profile: activeProfile } = activeEnvProfile()
      if (activeMain || activeProfile) {
        return process.env[envKey]
          || storedProfileTierField(activeProfile, t)
          || activeMain
          || t
      }
      const { storedMain, profile } = storedMainProfile()
      return process.env[envKey]
        || storedProfileTierField(profile, t)
        || storedMain
        || t
    },
    resolveDefaultModel: resolveSessionDefaultModel,
    clearLegacyTier: clearLegacyTierState,
    getStoredMainModel: () => {
      // Persisted main model from custom API storage; trimmed, may be ''.
      const stored = readCustomApiStorage().model?.trim()
      return stored ? stored : undefined
    },
  })
}

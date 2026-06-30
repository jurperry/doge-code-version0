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
 */
import { applyModelProfile, getModelProfile, type ModelProfile } from '../customApiStorage.js'
import {
  switchModelProfileAtomic as switchModelProfileAtomicCore,
  switchTier as switchTierCore,
  type AppStateSlice,
  type TierAlias,
} from './switchModelProfile.js'
import { getUserSpecifiedModelSetting } from './model.js'

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

export async function switchModelProfileAtomicBound(
  profile: ModelProfile,
  deps: { syncToDisk: SyncToDisk; setAppState: (f: (prev: any) => any) => void },
): Promise<void> {
  return switchModelProfileAtomicCore(profile, {
    applyProfile: applyModelProfile,
    syncToDisk: deps.syncToDisk,
    commitAppState: bindCommit(deps.setAppState),
  })
}

export function switchTierBound(
  tier: TierAlias,
  deps: { syncToDisk: SyncToDisk; setAppState: (f: (prev: any) => any) => void },
): void {
  switchTierCore(tier, {
    syncToDisk: deps.syncToDisk,
    commitAppState: bindCommit(deps.setAppState),
    resolveTierModel: (t) => {
      // Direct env lookup: bypass parseUserSpecifiedModel's fallback chain
      // which consults getUserSpecifiedModelSetting() and can be polluted by
      // a previous tier switch's mainLoopModelOverride (e.g. after switching
      // to Haiku, getDefaultOpusModel would fallback to Haiku's real model).
      const envKey =
        t === 'opus' ? 'ANTHROPIC_DEFAULT_OPUS_MODEL'
        : t === 'sonnet' ? 'ANTHROPIC_DEFAULT_SONNET_MODEL'
        : 'ANTHROPIC_DEFAULT_HAIKU_MODEL'
      return process.env[envKey] || process.env.ANTHROPIC_MODEL || t
    },
    getActiveProfile: () => {
      // Use getUserSpecifiedModelSetting() to track the current AppState model
      // (including P3 bare-model switches that don't update env), falling back
      // to env when AppState hasn't been set yet.
      const activeModel = getUserSpecifiedModelSetting() || process.env.ANTHROPIC_MODEL
      return activeModel ? getModelProfile(activeModel) : undefined
    },
  })
}
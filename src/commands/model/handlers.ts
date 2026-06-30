import { MODEL_FAMILY_ALIASES } from '../../utils/model/aliases.js'
import type { ModelProfile } from '../../utils/customApiStorage.js'
import type { TierAlias } from '../../utils/model/switchModelProfile.js'

export type ModelInput = string | null

type SyncModelConfigToDisk = (
  model: string,
  clearCredentials: boolean,
  credentialSourceProfile?: ModelProfile,
) => void

export interface DecideContext {
  /** Look up a ModelProfile by its `model` field. Returns null if no match. */
  findProfile: (model: ModelInput) => ModelProfile | null
  switchModelProfileAtomicBound: (
    profile: ModelProfile,
    deps: { syncToDisk: SyncModelConfigToDisk; setAppState: (f: (prev: any) => any) => void },
  ) => Promise<void>
  switchTierBound: (
    tier: TierAlias,
    deps: { syncToDisk: SyncModelConfigToDisk; setAppState: (f: (prev: any) => any) => void },
  ) => void
  syncModelConfigToDisk: SyncModelConfigToDisk
  setAppState: (f: (prev: any) => any) => void
}

const TIER_ALIASES = new Set<ModelInput>(MODEL_FAMILY_ALIASES)

/**
 * Dispatch /model input to the correct path:
 *   P1 — matched ModelProfile → atomic profile switch (switchModelProfileAtomicBound)
 *   P2 — tier alias / null / "default" → switchTier(null or alias)
 *   P3 — bare unknown string → AppState + sync only (no env mutation)
 *
 * This function is pure (effects only via injected ctx). model.tsx wires it
 * to the live bindings; tests pass mocks.
 */
export async function decideAndSwitch(input: ModelInput, ctx: DecideContext): Promise<void> {
  // P2: explicit default / null revert
  if (input === null || input === 'default') {
    ctx.switchTierBound(null, { syncToDisk: ctx.syncModelConfigToDisk, setAppState: ctx.setAppState })
    return
  }
  // P2: tier alias
  if (TIER_ALIASES.has(input)) {
    ctx.switchTierBound(input as 'opus' | 'sonnet' | 'haiku', { syncToDisk: ctx.syncModelConfigToDisk, setAppState: ctx.setAppState })
    return
  }
  // P1: matching profile
  const profile = ctx.findProfile(input)
  if (profile) {
    await ctx.switchModelProfileAtomicBound(profile, { syncToDisk: ctx.syncModelConfigToDisk, setAppState: ctx.setAppState })
    return
  }
  // P3: bare unknown model string — write AppState + persist, no env mutation.
  ctx.syncModelConfigToDisk(input, false)
  ctx.setAppState((prev) => ({
    ...prev,
    mainLoopModel: input,
    mainLoopModelForSession: null,
  }))
}
import { MODEL_FAMILY_ALIASES } from '../../utils/model/aliases.js'
import type { ModelProfile } from '../../utils/customApiStorage.js'
import { noopSyncToDisk, type ModelSwitchScope } from '../../utils/model/modelSwitchScope.js'
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
    deps: { syncToDisk: SyncModelConfigToDisk; setAppState: (f: (prev: any) => any) => void; sessionScoped?: boolean },
  ) => Promise<void>
  switchTierBound: (
    tier: TierAlias,
    deps: { syncToDisk: SyncModelConfigToDisk; setAppState: (f: (prev: any) => any) => void; sessionScoped?: boolean },
  ) => void
  syncModelConfigToDisk: SyncModelConfigToDisk
  setAppState: (f: (prev: any) => any) => void
  /** 'session' (default) — the switch only affects this process: no disk
   *  writes, commit lands in `mainLoopModelForSession`. Multi-terminal
   *  isolation. 'global' — legacy behavior, persists to all config files. */
  scope?: ModelSwitchScope
}

const TIER_ALIASES = new Set<ModelInput>(MODEL_FAMILY_ALIASES)

/**
 * Dispatch /model input to the correct path:
 *   P1 — matched ModelProfile → atomic profile switch (switchModelProfileAtomicBound)
 *   P2 — tier alias / null / "default" → switchTier(null or alias)
 *   P3 — bare unknown string → AppState + sync only (no env mutation)
 *
 * Scope: 'session' (default) keeps every switch in-process (no disk writes
 * — concurrent terminals are unaffected); 'global' restores the legacy
 * persist-everywhere behavior (also reachable via `/model <name> --save`).
 * Tier aliases (opus/sonnet/haiku) are session-scoped in BOTH modes — see
 * switchTier: a persisted tier would decide the main model of every other
 * terminal and every future launch.
 *
 * This function is pure (effects only via injected ctx). model.tsx wires it
 * to the live bindings; tests pass mocks.
 */
export async function decideAndSwitch(input: ModelInput, ctx: DecideContext): Promise<void> {
  const sessionScoped = ctx.scope !== 'global'
  const syncToDisk = sessionScoped ? noopSyncToDisk : ctx.syncModelConfigToDisk
  // P2: explicit default / null revert
  if (input === null || input === 'default') {
    ctx.switchTierBound(null, { syncToDisk, setAppState: ctx.setAppState, sessionScoped })
    return
  }
  // P2: tier alias
  if (TIER_ALIASES.has(input)) {
    ctx.switchTierBound(input as 'opus' | 'sonnet' | 'haiku', { syncToDisk, setAppState: ctx.setAppState, sessionScoped })
    return
  }
  // P1: matching profile
  const profile = ctx.findProfile(input)
  if (profile) {
    await ctx.switchModelProfileAtomicBound(profile, { syncToDisk, setAppState: ctx.setAppState, sessionScoped })
    return
  }
  // P3: bare unknown model string — AppState only, no env mutation.
  // Global scope additionally persists; session scope keeps it in-process.
  if (!sessionScoped) {
    ctx.syncModelConfigToDisk(input, false)
  }
  ctx.setAppState(sessionScoped
    ? (prev) => ({ ...prev, mainLoopModelForSession: input })
    : (prev) => ({ ...prev, mainLoopModel: input, mainLoopModelForSession: null }))
}

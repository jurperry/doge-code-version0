import {
  getModelProfile,
  healStoredCredentials,
  readCustomApiStorage,
  writeCustomApiStorage,
  type TierAliasName,
} from '../customApiStorage.js'
import { clearModelCapabilityOverrideCache } from './modelSupportOverrides.js'

const TIER_ENV_KEYS: Record<TierAliasName, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
}

/**
 * Resolve a tier's configured model from the MAIN MODEL'S OWN PROFILE only.
 *
 * Since the 2026-09-07 provider refactor the deprecated global tierModels
 * snapshot is deliberately ignored: it was captured from whichever terminal
 * last switched tiers/profiles and could describe a DIFFERENT provider,
 * polluting every other terminal's tier env (and via the picker, their
 * "custom model" list). Tier mappings are per-profile configuration.
 * Deliberately does NOT fall back to the main model: injecting the main
 * model as a tier env var would make every tier look "explicitly
 * configured" with the same model, recreating the all-tiers-show-one-model
 * confusion. Returns undefined when the tier has no explicit configuration.
 */
function resolveTierModel(
  tier: TierAliasName,
  mainModel: string,
): string | undefined {
  const profile = getModelProfile(mainModel)
  const profileField =
    tier === 'opus'
      ? profile?.defaultOpusModel
      : tier === 'sonnet'
        ? profile?.defaultSonnetModel
        : profile?.defaultHaikuModel
  return profileField
}

/**
 * Restore tier configuration from persisted storage into process env.
 *
 * Start scripts (start_deepseek.ps1 etc.) inject ANTHROPIC_MODEL and the
 * ANTHROPIC_DEFAULT_*_MODEL tier vars at launch. A bare `doge` launch has
 * none of those, so before this restore every tier fell back to the main
 * model in /model and in sub-agent resolution — Opus/Sonnet/Haiku all showed
 * (and used) the same model.
 *
 * This runs once at startup (see entrypoints/cli.tsx) and only fills in env
 * vars that are NOT already set, so a start script's explicit configuration
 * always wins.
 *
 * Restored state (per-provider, session-isolated):
 *  - tier→model mapping from the STORED MAIN MODEL'S OWN profile
 *    (defaultOpusModel/defaultSonnetModel/defaultHaikuModel) →
 *    ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL
 *
 * Deliberately NOT restored:
 *  - the deprecated global activeTier → ANTHROPIC_MODEL injection. Tier
 *    selections are session-scoped; a tier picked in another terminal (or a
 *    previous run) must not decide this terminal's main model. Every launch
 *    starts on the provider default (sonnet tier, falling back to the main
 *    model). Legacy activeTier/tierModels fields are scrubbed from secure
 *    storage here as a one-time migration.
 */
export function restoreTierStateFromStorage(): void {
  const storage = readCustomApiStorage()
  const mainModel = storage.model?.trim()
  // First-party users have no custom API config to restore.
  if (!mainModel) return

  // One-time migration: scrub deprecated global tier state (secure storage
  // only — saveGlobalConfig is not safe before enableConfigs() at startup).
  // Runs BEFORE the credential heal so the heal reads the post-scrub state.
  if (storage.activeTier !== undefined || storage.tierModels !== undefined) {
    writeCustomApiStorage({
      ...storage,
      activeTier: undefined,
      tierModels: undefined,
    })
  }

  // Self-heal first: repair top-level credentials wiped by profile switches
  // (pre-clearCredentials behavior) from the intact modelProfiles entry, so a
  // bare `doge` launch can authenticate again without manual re-setup.
  healStoredCredentials()

  // Restore the tier→model mapping for all three tiers from the active
  // profile's own tier slots.
  for (const tier of ['opus', 'sonnet', 'haiku'] as const) {
    const envKey = TIER_ENV_KEYS[tier]
    if (process.env[envKey]) continue
    const model = resolveTierModel(tier, mainModel)
    if (model) process.env[envKey] = model
  }
  // Tier env (re)populated — drop any memoized capability overrides.
  clearModelCapabilityOverrideCache()
}

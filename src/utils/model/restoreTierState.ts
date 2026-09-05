import {
  getModelProfile,
  healStoredCredentials,
  readCustomApiStorage,
  type TierAliasName,
} from '../customApiStorage.js'

const TIER_ENV_KEYS: Record<TierAliasName, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
}

/**
 * Resolve a tier's configured model from persisted state ONLY — snapshot
 * first, then the main model's profile. Deliberately does NOT fall back to
 * the main model: injecting the main model as a tier env var would make
 * every tier look "explicitly configured" with the same model, recreating
 * the all-tiers-show-one-model confusion this restore exists to fix.
 * Returns undefined when the tier has no explicit configuration.
 */
function resolveTierModel(
  tier: TierAliasName,
  mainModel: string,
): string | undefined {
  const snapshot = readCustomApiStorage().tierModels
  const profile = getModelProfile(mainModel)
  const profileField =
    tier === 'opus'
      ? profile?.defaultOpusModel
      : tier === 'sonnet'
        ? profile?.defaultSonnetModel
        : profile?.defaultHaikuModel
  return snapshot?.[tier] ?? profileField
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
 * Restored state:
 *  - tier→model mapping (tierModels snapshot, falling back to the main
 *    model's profile) → ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL
 *  - tier selection (activeTier) → ANTHROPIC_MODEL = that tier's model
 */
export function restoreTierStateFromStorage(): void {
  const storage = readCustomApiStorage()
  const mainModel = storage.model?.trim()
  // First-party users have no custom API config to restore.
  if (!mainModel) return

  // Self-heal first: repair top-level credentials wiped by profile switches
  // (pre-clearCredentials behavior) from the intact modelProfiles entry, so a
  // bare `doge` launch can authenticate again without manual re-setup.
  healStoredCredentials()

  // 1. Restore the tier→model mapping for all three tiers.
  for (const tier of ['opus', 'sonnet', 'haiku'] as const) {
    const envKey = TIER_ENV_KEYS[tier]
    if (process.env[envKey]) continue
    const model = resolveTierModel(tier, mainModel)
    if (model) process.env[envKey] = model
  }

  // 2. If a tier was selected via /model, the main loop model follows it.
  // Falls back to the main model only here (a persisted tier selection with
  // a lost mapping must not degrade to the bare alias string).
  const activeTier = storage.activeTier
  if (activeTier && !process.env.ANTHROPIC_MODEL) {
    const tierModel = resolveTierModel(activeTier, mainModel) ?? mainModel
    if (tierModel) process.env.ANTHROPIC_MODEL = tierModel
  }
}

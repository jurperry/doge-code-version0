import type { ModelProfile, TierAliasName } from '../customApiStorage.js'

export const TIER_MODEL_ENV_KEYS = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
} as const

/** Mechanism only: callers retain their own inherit/default/override policies. */
export function resolveTierModel(input: {
  tier: TierAliasName
  env: Readonly<NodeJS.ProcessEnv>
  profile?: ModelProfile
  mainModel?: string
  fallback?: string
}): string | undefined {
  const { tier, env, profile, mainModel, fallback } = input
  const field = tier === 'opus' ? profile?.defaultOpusModel
    : tier === 'sonnet' ? profile?.defaultSonnetModel : profile?.defaultHaikuModel
  return env[TIER_MODEL_ENV_KEYS[tier]] || field || mainModel || fallback
}

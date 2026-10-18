/**
 * Environment variables fully owned by the active ModelProfile.
 *
 * Contract: when switching to a new ModelProfile, ALL keys in this list must
 * be cleared first (so a tier value the new profile does not provide cannot
 * survive from the old profile). `applyModelProfile` then writes back only
 * the keys the new profile actually defines.
 *
 * This list is the single source of truth — clear + apply both reference it.
 *
 * Note: CLAUDE_CODE_EFFORT_LEVEL is intentionally NOT included; effort is a
 * runtime preference orthogonal to the profile (see customApiStorage.ts).
 */
export const PROFILE_MANAGED_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_DISABLE_EFFORT',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
] as const

export type ProfileManagedEnvKey = (typeof PROFILE_MANAGED_ENV_KEYS)[number]

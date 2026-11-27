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
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
  'DOGE_ACTIVE_CONNECTION_ID',
  'DOGE_ACTIVE_MODEL_ID',
] as const

export type ProfileManagedEnvKey = (typeof PROFILE_MANAGED_ENV_KEYS)[number]

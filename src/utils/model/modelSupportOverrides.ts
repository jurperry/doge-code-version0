import { getModelEnvironment } from './runtimeModelContext.js'
import memoize from 'lodash-es/memoize.js'
import { getAPIProvider } from './providers.js'

/** Check if a model string matches any of the pinned ANTHROPIC_DEFAULT_*_MODEL
 *  env vars (Opus/Sonnet/Haiku tiers). Used to determine whether a model is
 *  part of the current provider's tier configuration. */
export function matchesTierModel(model: string): boolean {
  const normalized = model.toLowerCase().replace(/\[.*?\]$/i, '')
  for (const tier of TIERS) {
    const pinned = getModelEnvironment()[tier.modelEnvVar]
    if (pinned && normalized === pinned.toLowerCase().replace(/\[.*?\]$/i, '')) {
      return true
    }
  }
  return false
}

export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

const TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

/**
 * Check whether a 3p model capability override is set for a model that matches one of
 * the pinned ANTHROPIC_DEFAULT_*_MODEL env vars.
 */
export const get3PModelCapabilityOverride = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    const provider = getAPIProvider()
    // Allow capability overrides for OpenAI-compatible APIs (custom base URL)
    const isCustomApi = getModelEnvironment().ANTHROPIC_BASE_URL && provider === 'firstParty'

    if (provider === 'firstParty' && !isCustomApi) {
      return undefined
    }
    const m = model.toLowerCase().replace(/\[.*?\]$/, '')
    for (const tier of TIERS) {
      const pinned = getModelEnvironment()[tier.modelEnvVar]
      const capabilities = getModelEnvironment()[tier.capabilitiesEnvVar]
      if (!pinned || capabilities === undefined) continue
      if (m !== pinned.toLowerCase().replace(/\[.*?\]$/, '')) continue
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    return undefined
  },
  (model, capability) => JSON.stringify([
    model.toLowerCase(), capability, getAPIProvider(), getModelEnvironment().ANTHROPIC_BASE_URL,
    TIERS.map(t => [getModelEnvironment()[t.modelEnvVar], getModelEnvironment()[t.capabilitiesEnvVar]]),
  ]),
)

/**
 * Bound cache lifetime when root profile configuration changes. Scoped
 * workers include their tier configuration in the key and remain independent.
 */
export function clearModelCapabilityOverrideCache(): void {
  get3PModelCapabilityOverride.cache.clear()
}

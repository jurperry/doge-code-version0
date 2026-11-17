import {
  getModelProfile,
  readCustomApiStorage,
  type ModelProfile,
} from '../../utils/customApiStorage.js'
import { getProfileId } from '../../utils/model/profileIdentity.js'
import { maskSecret } from './provider-storage.js'

export type ProviderEntry = {
  model: string
  profile: ModelProfile
  isCurrent: boolean
}

/** A provider row represents a connection and its default model. */
export function getProviderEntries(): ProviderEntry[] {
  const stored = readCustomApiStorage()
  const model = process.env.ANTHROPIC_MODEL || stored.model
  const activeId = process.env.DOGE_ACTIVE_CONNECTION_ID || process.env.DOGE_ACTIVE_MODEL_PROFILE
    || (model ? getModelProfile(model)?.id : undefined) || stored.activeProfileId
  return (stored.modelProfiles ?? []).map(profile => ({
    model: profile.model,
    profile,
    isCurrent: getProfileId(profile) === activeId,
  }))
}

/** One-line description for menu entries. */
export function describeProviderEntry(entry: ProviderEntry): string {
  const p = entry.profile
  const format = p.provider ?? 'anthropic'
  const endpoint = p.baseURL || (format === 'anthropic' ? 'official API' : 'Base URL required')
  const name = p.providerName
  return name ? `${name} · ${format} · ${endpoint}` : `${format} · ${endpoint}`
}

/** Multi-line summary block for /provider list (secrets masked). */
export function formatProviderEntry(entry: ProviderEntry): string {
  const p = entry.profile
  const authTokenType = p.authTokenType ?? 'DOGE_API_KEY'
  const lines = [
    `${entry.model || p.providerName}${entry.isCurrent ? ' (current)' : ''}`,
  ]
  if (p?.providerName) lines.push(`  name:    ${p.providerName}`)
  lines.push(
    `  format:  ${p?.provider ?? 'anthropic'}`,
    `  base:    ${p?.baseURL || '(official API)'}`,
    `  API key: ${maskSecret(p?.apiKey)}`,
    `  key type: ${authTokenType} (${authTokenType === 'ANTHROPIC_AUTH_TOKEN' ? 'Authorization: Bearer' : 'x-api-key'})`,
  )
  if (p?.defaultOpusModel) lines.push(`  opus:    ${p.defaultOpusModel}`)
  if (p?.defaultSonnetModel) lines.push(`  sonnet:  ${p.defaultSonnetModel}`)
  if (p?.defaultHaikuModel) lines.push(`  haiku:   ${p.defaultHaikuModel}`)
  if (p?.contextWindow !== undefined) lines.push(`  context: ${p.contextWindow} tokens`)
  return lines.join('\n')
}

import { createHash } from 'node:crypto'
import type { CatalogModel } from './modelCatalog.js'
import type { ModelProfile } from '../customApiStorage.js'

export const ACTIVE_PROFILE_ENV = 'DOGE_ACTIVE_MODEL_PROFILE'
const PREFIX = 'profile:'

/** Legacy IDs contain only non-secret identity; explicit saves preserve them. */
export function getProfileId(profile: ModelProfile): string {
  if (profile.id) return profile.id
  const identity = profile.providerName?.trim().toLowerCase()
    || `${profile.provider ?? 'anthropic'}|${profile.baseURL ?? ''}|${profile.model.trim().toLowerCase()}`
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

export function profileSelection(profile: ModelProfile, modelId = profile.catalogModelId): string {
  const id = getProfileId(profile)
  return modelId ? `${PREFIX}${encodeURIComponent(id)}:${encodeURIComponent(modelId)}` : PREFIX + id
}

export function isProfileSelection(value: string): boolean {
  return value.startsWith(PREFIX)
}

export function resolveProfileReference(
  profiles: ModelProfile[], reference: string,
): ModelProfile | undefined {
  const id = isProfileSelection(reference) ? reference.slice(PREFIX.length) : reference
  const connection = profiles.find(profile => getProfileId(profile) === id)
  if (connection || !isProfileSelection(reference)) return connection
  const parts = id.split(':')
  if (parts.length !== 2) return undefined
  try {
    const [connectionId, modelId] = parts.map(decodeURIComponent)
    const profile = profiles.find(p => getProfileId(p) === connectionId)
    const model = profile?.models?.find(m => m.id === modelId)
    return profile && model ? selectProfileModel(profile, model) : undefined
  } catch {
    return undefined
  }
}

function selectProfileModel(profile: ModelProfile, model: CatalogModel): ModelProfile {
  return { ...profile, model: model.upstreamModel, catalogModelId: model.id, contextWindow: model.contextWindow }
}

export function matchModelProfile(
  profiles: ModelProfile[], model: string, env: Readonly<NodeJS.ProcessEnv>,
): ModelProfile | undefined {
  if (isProfileSelection(model)) return resolveProfileReference(profiles, model)
  const normalized = (name: string) => name.toLowerCase().trim().replace(/\[[12]m\]$/i, '')
  const wanted = normalized(model)
  const modelOf = (profile: ModelProfile) => profile.models?.find(m => normalized(m.upstreamModel) === wanted)
    ?? profile.models?.find(m => normalized(m.displayName) === wanted)
  const matches = profiles.filter(profile => normalized(profile.model) === wanted || Boolean(modelOf(profile)))
  const active = env.DOGE_ACTIVE_CONNECTION_ID || env[ACTIVE_PROFILE_ENV]
  const key = env.DOGE_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN
  const candidate = (active ? resolveProfileReference(matches, active) : undefined)
    ?? matches.find(p => env.ANTHROPIC_BASE_URL && p.baseURL?.trim() === env.ANTHROPIC_BASE_URL.trim() && (!p.apiKey || p.apiKey === key))
    ?? matches.find(p => env.ANTHROPIC_BASE_URL && p.baseURL?.trim() === env.ANTHROPIC_BASE_URL.trim())
    ?? matches[0]
  if (!candidate) return undefined
  const selected = modelOf(candidate)
  return selected
    ? selectProfileModel(candidate, selected)
    : candidate
}

import { createHash } from 'node:crypto'
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

export function profileSelection(profile: ModelProfile): string {
  return PREFIX + getProfileId(profile)
}

export function isProfileSelection(value: string): boolean {
  return value.startsWith(PREFIX)
}

export function resolveProfileReference(
  profiles: ModelProfile[], reference: string,
): ModelProfile | undefined {
  const id = isProfileSelection(reference) ? reference.slice(PREFIX.length) : reference
  return profiles.find(profile => getProfileId(profile) === id)
}

export function matchModelProfile(
  profiles: ModelProfile[], model: string, env: Readonly<NodeJS.ProcessEnv>,
): ModelProfile | undefined {
  if (isProfileSelection(model)) return resolveProfileReference(profiles, model)
  const normalized = (name: string) => name.toLowerCase().trim().replace(/\[[12]m\]$/i, '')
  const wanted = normalized(model)
  const modelOf = (profile: ModelProfile) => profile.models?.find(
    m => normalized(m.upstreamModel) === wanted || normalized(m.displayName) === wanted,
  )
  const matches = profiles.filter(profile => normalized(profile.model) === wanted || Boolean(modelOf(profile)))
  const active = env[ACTIVE_PROFILE_ENV]
  const key = env.DOGE_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN
  const candidate = (active ? resolveProfileReference(matches, active) : undefined)
    ?? matches.find(p => env.ANTHROPIC_BASE_URL && p.baseURL?.trim() === env.ANTHROPIC_BASE_URL.trim() && (!p.apiKey || p.apiKey === key))
    ?? matches.find(p => env.ANTHROPIC_BASE_URL && p.baseURL?.trim() === env.ANTHROPIC_BASE_URL.trim())
    ?? matches[0]
  if (!candidate) return undefined
  const selected = modelOf(candidate)
  return selected
    ? { ...candidate, model: selected.upstreamModel, catalogModelId: selected.id }
    : candidate
}

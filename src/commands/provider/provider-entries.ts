import { getGlobalConfig } from '../../utils/config.js'
import {
  getModelProfile,
  normalizeModelName,
  readCustomApiStorage,
  type CustomApiStorageData,
  type ModelProfile,
} from '../../utils/customApiStorage.js'
import { maskSecret } from './provider-storage.js'

export type ProviderEntry = {
  model: string
  profile?: ModelProfile
  isCurrent: boolean
}

/**
 * Build a map from sub-model normalized key → its owning main model normalized key,
 * scanning all stored modelProfiles. Only profile-based tier overrides are used
 * (not env vars, which are session-scoped).
 */
export function buildSubToMainMap(storage: CustomApiStorageData): Map<string, string> {
  const subToMain = new Map<string, string>()
  for (const p of storage.modelProfiles ?? []) {
    const ownerKey = normalizeModelName(p.model)
    if (p.defaultOpusModel) subToMain.set(normalizeModelName(p.defaultOpusModel), ownerKey)
    if (p.defaultSonnetModel) subToMain.set(normalizeModelName(p.defaultSonnetModel), ownerKey)
    if (p.defaultHaikuModel) subToMain.set(normalizeModelName(p.defaultHaikuModel), ownerKey)
  }
  return subToMain
}

/**
 * Gather MAIN models only (not tier sub-models like Opus/Sonnet/Haiku).
 * A model in savedModels is only excluded if it's a tier override owned by a
 * DIFFERENT main model's profile (not itself).
 */
export function getMainModels(): string[] {
  const envModel = process.env.ANTHROPIC_MODEL?.trim()
  let configModel: string | undefined
  let configSaved: string[] = []
  let storageSaved: string[] = []
  let storage: CustomApiStorageData = {}
  try {
    const config = getGlobalConfig()
    configModel = config.customApiEndpoint?.model?.trim()
    configSaved = config.customApiEndpoint?.savedModels ?? []
  } catch { /* ignore */ }
  try {
    storage = readCustomApiStorage()
    storageSaved = storage.savedModels ?? []
  } catch { /* ignore */ }

  const activeModel = envModel || configModel

  // Build set of normalized keys that are "must include" (in savedModels or active)
  const mustInclude = new Set<string>()
  if (activeModel) mustInclude.add(normalizeModelName(activeModel))
  for (const m of [...configSaved, ...storageSaved]) {
    if (m) mustInclude.add(normalizeModelName(m))
  }

  // Build sub→main ownership map from stored profiles
  const subToMain = buildSubToMainMap(storage)

  const modelMap = new Map<string, string>()
  const addModel = (name: string | undefined) => {
    if (!name) return
    const key = normalizeModelName(name)
    if (!modelMap.has(key)) modelMap.set(key, name)
  }

  // Active model always included
  if (activeModel) addModel(activeModel)

  // savedModels: only exclude if it's a tier override of a DIFFERENT main model
  for (const m of [...configSaved, ...storageSaved]) {
    if (!m) continue
    const key = normalizeModelName(m)
    const ownerKey = subToMain.get(key)
    // Exclude only if: owned by another model that is also in savedModels/active,
    // AND the owner is different from this model itself.
    if (ownerKey && ownerKey !== key && mustInclude.has(ownerKey)) continue
    addModel(m)
  }

  return [...modelMap.values()]
}

/** Entries for the /provider menu and /provider list. */
export function getProviderEntries(): ProviderEntry[] {
  let current: string | undefined
  try {
    current = readCustomApiStorage().model ?? getGlobalConfig().customApiEndpoint?.model
  } catch { /* ignore */ }
  const currentKey = normalizeModelName(current ?? '')
  return getMainModels().map(model => ({
    model,
    profile: getModelProfile(model),
    isCurrent: normalizeModelName(model) === currentKey,
  }))
}

/** One-line description for menu entries. */
export function describeProviderEntry(entry: ProviderEntry): string {
  const p = entry.profile
  const format = p?.provider ?? 'anthropic'
  const endpoint = p?.baseURL || 'official API'
  return `${format} · ${endpoint}`
}

/** Multi-line summary block for /provider list (secrets masked). */
export function formatProviderEntry(entry: ProviderEntry): string {
  const p = entry.profile
  const lines = [
    `${entry.model}${entry.isCurrent ? ' (current)' : ''}`,
    `  format:  ${p?.provider ?? 'anthropic'}`,
    `  base:    ${p?.baseURL || '(official API)'}`,
    `  API key: ${maskSecret(p?.apiKey)}`,
  ]
  if (p?.defaultOpusModel) lines.push(`  opus:    ${p.defaultOpusModel}`)
  if (p?.defaultSonnetModel) lines.push(`  sonnet:  ${p.defaultSonnetModel}`)
  if (p?.defaultHaikuModel) lines.push(`  haiku:   ${p.defaultHaikuModel}`)
  return lines.join('\n')
}

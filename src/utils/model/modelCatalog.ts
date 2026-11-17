/**
 * Unified Model Catalog (CLI side).
 *
 * Single source of truth shared with the App: `~/.doge/model-catalog.json`.
 * The catalog owns connections, models, roles, default selection and reasoning
 * policies. `.credentials.json` / `.claude.json` must not persist model config.
 *
 * This module is deliberately dependency-light (fs + config dir only) so
 * `config.ts` can overlay the catalog without an import cycle.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { getDogeConfigDir } from '../dogeConfigDir.js'
import { isEnvTruthy } from '../envUtils.js'

export type ModelProtocol = 'anthropic' | 'openai' | 'responses'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ReasoningPresetId =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'glm'
  | 'kimi'
  | 'qwen'
  | 'xai'
  | 'generic'
export type ReasoningDisplay = 'full' | 'summary' | 'none'

export type ThinkingPolicy =
  | { mode: 'none' }
  | { mode: 'always' }
  | { mode: 'value'; field: string; value: unknown }
  | { mode: 'toggle'; field: string; on: unknown; off: unknown }
  | { mode: 'budget'; field: string; budgetTokens?: number }

export type EffortPolicy =
  | { mode: 'none' }
  | {
      mode: 'named'
      field: string
      levels: EffortLevel[]
      defaultLevel?: EffortLevel
      wireMap?: Partial<Record<EffortLevel, string>>
      appliedMap?: Partial<Record<EffortLevel, EffortLevel>>
    }
  | {
      mode: 'budget'
      field: string
      levels: EffortLevel[]
      defaultLevel?: EffortLevel
      budgets: Partial<Record<EffortLevel, number>>
      maxBudget?: number
      reserveOutputTokens?: number
    }

export interface ResponsePolicy {
  openaiFields: string[]
  display: ReasoningDisplay
}

export interface ReasoningPolicy {
  preset: ReasoningPresetId
  thinking: ThinkingPolicy
  effort: EffortPolicy
  response: ResponsePolicy
  extraBody?: Record<string, unknown>
}

export interface CatalogModel {
  id: string
  upstreamModel: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoning?: ReasoningPolicy
}

export interface CatalogConnection {
  id: string
  name: string
  protocol: ModelProtocol
  baseURL?: string
  apiKey?: string
  authTokenType?: 'DOGE_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'
  models: CatalogModel[]
  defaultModelId?: string
  roles?: Partial<Record<'opus' | 'sonnet' | 'haiku' | 'subagent', string>>
}

export interface ModelCatalog {
  version: 2
  connections: CatalogConnection[]
  defaultModel?: { connectionId: string; modelId: string }
}

/** Structural copy of the old CustomApiStorageData; never persisted. */
export interface CatalogProfile {
  id?: string
  connectionId?: string
  catalogModelId?: string
  model: string
  providerName?: string
  provider?: ModelProtocol
  baseURL?: string
  apiKey?: string
  authTokenType?: 'DOGE_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'
  contextWindow?: number
  maxOutputTokens?: number
  defaultOpusModel?: string
  defaultSonnetModel?: string
  defaultHaikuModel?: string
  subagentModel?: string
  models?: CatalogModel[]
  roles?: CatalogConnection['roles']
}

export interface CatalogEndpoint {
  activeProfileId?: string
  provider?: ModelProtocol
  baseURL?: string
  apiKey?: string
  authTokenType?: 'DOGE_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'
  model?: string
  savedModels?: string[]
  modelProfiles?: CatalogProfile[]
}

const CATALOG_FILE = 'model-catalog.json'
const CATALOG_KEY = 'modelCatalog'

export function catalogFilePath(): string {
  return join(getDogeConfigDir(), CATALOG_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeModelName(name: string): string {
  return name.toLowerCase().trim().replace(/\[[12]m\]$/i, '')
}

function hashId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

function normalizeCatalog(raw: unknown): ModelCatalog | undefined {
  if (!isRecord(raw) || raw.version !== 2 || !Array.isArray(raw.connections)) return undefined
  const connections: CatalogConnection[] = []
  const usedIds = new Set<string>()
  const usedNames = new Set<string>()
  for (const rawConnection of raw.connections) {
    if (!isRecord(rawConnection)) continue
    const protocol = rawConnection.protocol
    if (protocol !== 'anthropic' && protocol !== 'openai' && protocol !== 'responses') continue
    let id = typeof rawConnection.id === 'string' && rawConnection.id.trim()
      ? rawConnection.id.trim()
      : hashId('c', `${rawConnection.name ?? ''}|${rawConnection.baseURL ?? ''}|${protocol}`)
    while (usedIds.has(id)) id = hashId('c', `${id}|${usedIds.size}`)
    usedIds.add(id)
    const baseName = typeof rawConnection.name === 'string' && rawConnection.name.trim()
      ? rawConnection.name.trim()
      : id
    let name = baseName
    let suffix = 2
    while (usedNames.has(name.toLowerCase())) name = `${baseName} (${suffix++})`
    usedNames.add(name.toLowerCase())
    const models: CatalogModel[] = []
    if (Array.isArray(rawConnection.models)) {
      for (const rawModel of rawConnection.models) {
        if (!isRecord(rawModel)) continue
        const upstreamModel = typeof rawModel.upstreamModel === 'string' ? rawModel.upstreamModel.trim() : ''
        if (!upstreamModel) continue
        if (models.some(m => normalizeModelName(m.upstreamModel) === normalizeModelName(upstreamModel))) continue
        const modelId = typeof rawModel.id === 'string' && rawModel.id.trim()
          ? rawModel.id.trim()
          : hashId('m', `${id}|${normalizeModelName(upstreamModel)}`)
        models.push({
          id: modelId,
          upstreamModel,
          displayName: typeof rawModel.displayName === 'string' && rawModel.displayName.trim()
            ? rawModel.displayName.trim()
            : upstreamModel,
          ...(typeof rawModel.contextWindow === 'number' ? { contextWindow: rawModel.contextWindow } : {}),
          ...(typeof rawModel.maxOutputTokens === 'number' && Number.isSafeInteger(rawModel.maxOutputTokens) && rawModel.maxOutputTokens > 0 ? { maxOutputTokens: rawModel.maxOutputTokens } : {}),
          ...(isRecord(rawModel.reasoning) ? { reasoning: rawModel.reasoning as unknown as ReasoningPolicy } : {}),
        })
      }
    }
    if (!models.length) {
      connections.push({
        id,
        name,
        protocol,
        ...(typeof rawConnection.baseURL === 'string' ? { baseURL: rawConnection.baseURL } : {}),
        ...(typeof rawConnection.apiKey === 'string' ? { apiKey: rawConnection.apiKey } : {}),
        ...(rawConnection.authTokenType === 'ANTHROPIC_AUTH_TOKEN' || rawConnection.authTokenType === 'DOGE_API_KEY'
          ? { authTokenType: rawConnection.authTokenType }
          : {}),
        models: [],
      })
      continue
    }
    const defaultModelId = typeof rawConnection.defaultModelId === 'string'
      && models.some(m => m.id === rawConnection.defaultModelId)
      ? rawConnection.defaultModelId
      : models[0].id
    const roles: CatalogConnection['roles'] = {}
    if (isRecord(rawConnection.roles)) {
      for (const role of ['opus', 'sonnet', 'haiku', 'subagent'] as const) {
        const value = rawConnection.roles[role]
        if (typeof value === 'string' && models.some(m => m.id === value)) roles[role] = value
      }
    }
    connections.push({
      id,
      name,
      protocol,
      ...(typeof rawConnection.baseURL === 'string' ? { baseURL: rawConnection.baseURL } : {}),
      ...(typeof rawConnection.apiKey === 'string' ? { apiKey: rawConnection.apiKey } : {}),
      ...(rawConnection.authTokenType === 'ANTHROPIC_AUTH_TOKEN' || rawConnection.authTokenType === 'DOGE_API_KEY'
        ? { authTokenType: rawConnection.authTokenType }
        : {}),
      models,
      defaultModelId,
      ...(Object.keys(roles).length ? { roles } : {}),
    })
  }
  const defaultModel = isRecord(raw.defaultModel)
    && typeof raw.defaultModel.connectionId === 'string'
    && typeof raw.defaultModel.modelId === 'string'
    && connections.some(c => c.id === raw.defaultModel!.connectionId
      && c.models.some(m => m.id === raw.defaultModel!.modelId))
    ? { connectionId: raw.defaultModel.connectionId, modelId: raw.defaultModel.modelId }
    : undefined
  return { version: 2, connections, ...(defaultModel ? { defaultModel } : {}) }
}

let catalogCache: { path: string; mtimeMs: number; size: number; catalog: ModelCatalog | undefined } | undefined

export function readModelCatalog(): ModelCatalog | undefined {
  const path = catalogFilePath()
  return readCatalogFile(path) ?? readCatalogFile(`${path}.bak`)
}

function readCatalogFile(path: string): ModelCatalog | undefined {
  try {
    const stats = statSync(path)
    if (catalogCache && catalogCache.path === path
      && catalogCache.mtimeMs === stats.mtimeMs && catalogCache.size === stats.size) {
      return catalogCache.catalog
    }
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const catalog = normalizeCatalog(isRecord(raw) ? raw[CATALOG_KEY] : undefined)
    catalogCache = { path, mtimeMs: stats.mtimeMs, size: stats.size, catalog }
    return catalog
  } catch {
    return undefined
  }
}

export function writeModelCatalog(catalog: ModelCatalog): void {
  const normalized = normalizeCatalog(catalog)
  if (!normalized) throw new Error('无效的 model-catalog.json')
  const path = catalogFilePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.doge-tmp`
  writeFileSync(tmp, `${JSON.stringify({ [CATALOG_KEY]: normalized }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows maps chmod to the read-only bit; mode is already owner-only.
  }
  catalogCache = undefined
}

export function defaultCatalogSelection(catalog: ModelCatalog | undefined): {
  connection?: CatalogConnection
  model?: CatalogModel
} {
  if (!catalog || !catalog.connections.length) return {}
  const preferred = catalog.defaultModel
    ? catalog.connections.find(c => c.id === catalog.defaultModel!.connectionId)
    : undefined
  const connection = preferred ?? catalog.connections[0]
  const model = connection.models.find(m => m.id === (preferred ? catalog.defaultModel!.modelId : connection.defaultModelId))
    ?? connection.models[0]
  return { connection, model }
}

function envSelection(catalog: ModelCatalog): { connection?: CatalogConnection; model?: CatalogModel } {
  const connectionId = process.env.DOGE_ACTIVE_CONNECTION_ID?.trim()
  const modelId = process.env.DOGE_ACTIVE_MODEL_ID?.trim()
  const profile = process.env.DOGE_ACTIVE_MODEL_PROFILE?.trim()
  if (connectionId) {
    const connection = catalog.connections.find(c => c.id === connectionId)
    if (connection) {
      const model = connection.models.find(m => m.id === modelId)
        ?? connection.models.find(m => m.id === connection.defaultModelId)
        ?? connection.models[0]
      return { connection, model }
    }
  }
  if (profile) {
    const [candidateConnection, candidateModel] = profile.split(':')
    const connection = catalog.connections.find(c => c.id === candidateConnection)
    if (connection) {
      const model = connection.models.find(m => m.id === candidateModel)
        ?? connection.models[0]
      return { connection, model }
    }
  }
  return defaultCatalogSelection(catalog)
}

export function resolveCatalogSelection(catalog: ModelCatalog | undefined): {
  connection?: CatalogConnection
  model?: CatalogModel
} {
  if (!catalog) return {}
  return envSelection(catalog)
}

export function catalogPolicyForModel(
  model: string,
  connectionId?: string,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): ReasoningPolicy | undefined {
  return catalogModelForRequest(model, env, connectionId)?.reasoning
}

export function catalogModelForRequest(
  model: string,
  env: Readonly<NodeJS.ProcessEnv>,
  connectionId?: string,
): CatalogModel | undefined {
  const catalog = readModelCatalog()
  if (!catalog) return undefined
  const id = connectionId || env.DOGE_ACTIVE_CONNECTION_ID || env.DOGE_ACTIVE_MODEL_PROFILE?.split(':')[0]
  const hosted = isEnvTruthy(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)
  const baseURL = env.ANTHROPIC_BASE_URL || (hosted ? 'https://api.anthropic.com' : undefined)
  const endpoint = baseURL?.trim().replace(/\/+$/, '')
  const protocol = env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER || (hosted ? 'anthropic' : undefined)
  const selected = defaultCatalogSelection(catalog)
  const matches = (connection: CatalogConnection): boolean =>
    (!endpoint || endpoint === (connection.baseURL || 'https://api.anthropic.com').trim().replace(/\/+$/, '')) &&
    (!protocol || protocol === connection.protocol)
  let connection: CatalogConnection | undefined
  if (id) {
    connection = catalog.connections.find(c => c.id === id && matches(c))
  } else if (!hosted && (endpoint || protocol)) {
    const candidates = catalog.connections.filter(matches)
    if (candidates.length === 1) connection = candidates[0]
  } else if (!hosted) {
    connection = selected.connection
  }
  if (!connection) return undefined
  const active = connection.models.find(m => m.id === env.DOGE_ACTIVE_MODEL_ID)
    ?? (connection === selected.connection ? selected.model : undefined)
    ?? connection.models.find(m => m.id === connection.defaultModelId)
  const normalized = model === 'default'
    ? normalizeModelName(env.ANTHROPIC_MODEL || active?.upstreamModel || '')
    : normalizeModelName(model)
  const aliases: Record<string, 'opus' | 'sonnet' | 'haiku'> = {
    opus: 'opus', sonnet: 'sonnet', haiku: 'haiku',
  }
  const role = aliases[normalized]
  const aliasModel = role ? env[`ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`] || roleUpstream(connection, role) : undefined
  const wanted = aliasModel ? normalizeModelName(aliasModel) : normalized
  return connection.models.find(m => normalizeModelName(m.upstreamModel) === wanted)
}

function roleUpstream(connection: CatalogConnection, role: 'opus' | 'sonnet' | 'haiku' | 'subagent'): string | undefined {
  const modelId = connection.roles?.[role]
  return connection.models.find(m => m.id === modelId)?.upstreamModel
}

function profileConnectionKey(profile: CatalogProfile): string {
  return profile.connectionId?.trim()
    || profile.id?.trim()
    || profile.providerName?.trim().toLowerCase()
    || `${profile.provider ?? 'anthropic'}|${profile.baseURL ?? ''}`
}

function mergeCatalogModel(
  existing: CatalogModel | undefined,
  incoming: CatalogModel,
  connectionId: string,
): CatalogModel {
  const upstreamModel = incoming.upstreamModel?.trim()
  return {
    ...(existing ?? {}),
    ...incoming,
    id: existing?.id ?? incoming.id ?? hashId('m', `${connectionId}|${normalizeModelName(upstreamModel)}`),
    upstreamModel,
    displayName: incoming.displayName?.trim() || existing?.displayName || upstreamModel,
    ...(incoming.reasoning ?? existing?.reasoning ? { reasoning: incoming.reasoning ?? existing!.reasoning } : {}),
  }
}

function findExistingModel(connection: CatalogConnection | undefined, upstream: string): CatalogModel | undefined {
  if (!connection) return undefined
  const wanted = normalizeModelName(upstream)
  return connection.models.find(m => normalizeModelName(m.upstreamModel) === wanted)
}

function ensureConnectionModel(connection: CatalogConnection, upstream: string): string {
  const trimmed = upstream.trim()
  const existing = findExistingModel(connection, trimmed)
  if (existing) return existing.id
  const model: CatalogModel = {
    id: hashId('m', `${connection.id}|${normalizeModelName(trimmed)}`),
    upstreamModel: trimmed,
    displayName: trimmed,
  }
  connection.models.push(model)
  return model.id
}

/** Catalog → one in-memory profile per connection (never per model). */
export function catalogToEndpoint(catalog: ModelCatalog | undefined): CatalogEndpoint {
  if (!catalog || !catalog.connections.length) return { modelProfiles: [], savedModels: [] }
  const selection = resolveCatalogSelection(catalog)
  const profiles: CatalogProfile[] = []
  const savedModels: string[] = []
  for (const connection of catalog.connections) {
    const main = connection.models.find(m => m.id === connection.defaultModelId) ?? connection.models[0]
    const profile: CatalogProfile = {
      id: connection.id,
      connectionId: connection.id,
      providerName: connection.name,
      model: main?.upstreamModel ?? '',
      provider: connection.protocol,
      ...(connection.baseURL !== undefined ? { baseURL: connection.baseURL } : {}),
      ...(connection.apiKey !== undefined ? { apiKey: connection.apiKey } : {}),
      ...(connection.authTokenType !== undefined ? { authTokenType: connection.authTokenType } : {}),
      ...(main?.contextWindow !== undefined ? { contextWindow: main.contextWindow } : {}),
      ...(main?.maxOutputTokens !== undefined ? { maxOutputTokens: main.maxOutputTokens } : {}),
      ...(roleUpstream(connection, 'opus') ? { defaultOpusModel: roleUpstream(connection, 'opus') } : {}),
      ...(roleUpstream(connection, 'sonnet') ? { defaultSonnetModel: roleUpstream(connection, 'sonnet') } : {}),
      ...(roleUpstream(connection, 'haiku') ? { defaultHaikuModel: roleUpstream(connection, 'haiku') } : {}),
      ...(roleUpstream(connection, 'subagent') ? { subagentModel: roleUpstream(connection, 'subagent') } : {}),
      models: connection.models.map(m => ({ ...m })),
      ...(connection.roles ? { roles: { ...connection.roles } } : {}),
    }
    profiles.push(profile)
    for (const model of connection.models) {
      if (!savedModels.some(m => normalizeModelName(m) === normalizeModelName(model.upstreamModel))) {
        savedModels.push(model.upstreamModel)
      }
    }
  }
  const activeConnection = selection.connection
  const activeModel = selection.model
  return {
    ...(activeConnection ? { activeProfileId: activeConnection.id } : {}),
    ...(activeConnection?.protocol ? { provider: activeConnection.protocol } : {}),
    ...(activeConnection?.baseURL !== undefined ? { baseURL: activeConnection.baseURL } : {}),
    ...(activeConnection?.apiKey !== undefined ? { apiKey: activeConnection.apiKey } : {}),
    ...(activeConnection?.authTokenType !== undefined ? { authTokenType: activeConnection.authTokenType } : {}),
    ...(activeModel?.upstreamModel ? { model: activeModel.upstreamModel } : {}),
    savedModels,
    modelProfiles: profiles,
  }
}

export function readCatalogEndpoint(): CatalogEndpoint | undefined {
  const catalog = readModelCatalog()
  if (!catalog) return undefined
  return catalogToEndpoint(catalog)
}

/**
 * In-memory endpoint → catalog. When profiles carry `models[]` they are the
 * complete model list for that connection (so deletion/rename works); when
 * they do not (provider form), existing models are preserved and only the
 * main-model slot is updated. Missing roles are never fabricated.
 */
export function endpointToCatalog(endpoint: CatalogEndpoint, existing?: ModelCatalog): ModelCatalog {
  const base: ModelCatalog = existing ?? { version: 2, connections: [] }
  const connections = base.connections.map(connection => ({
    ...connection,
    models: connection.models.map(model => ({ ...model })),
    ...(connection.roles ? { roles: { ...connection.roles } } : {}),
  }))
  const profiles = endpoint.modelProfiles ?? []

  if (!profiles.length) {
    const target = connections.find(c => c.id === endpoint.activeProfileId)
      ?? connections.find(c => c.baseURL && c.baseURL === endpoint.baseURL)
      ?? defaultCatalogSelection(base).connection
    if (!target && endpoint.model?.trim()) {
      const model: CatalogModel = {
        id: hashId('m', endpoint.model),
        upstreamModel: endpoint.model.trim(),
        displayName: endpoint.model.trim(),
      }
      const connection: CatalogConnection = {
        id: hashId('c', `${endpoint.provider ?? 'provider'}|${endpoint.baseURL ?? ''}`),
        name: endpoint.provider ? `provider (${endpoint.provider})` : 'provider',
        protocol: endpoint.provider ?? 'anthropic',
        ...(endpoint.baseURL !== undefined ? { baseURL: endpoint.baseURL } : {}),
        ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
        ...(endpoint.authTokenType !== undefined ? { authTokenType: endpoint.authTokenType } : {}),
        models: [model],
        defaultModelId: model.id,
      }
      return { version: 2, connections: [connection], defaultModel: { connectionId: connection.id, modelId: model.id } }
    }
    if (target) {
      const endpointChanged = Boolean(
        (endpoint.provider && endpoint.provider !== target.protocol)
        || (endpoint.baseURL !== undefined && endpoint.baseURL !== target.baseURL)
      )
      if (endpoint.provider) target.protocol = endpoint.provider
      if (endpoint.baseURL !== undefined) target.baseURL = endpoint.baseURL
      if (endpoint.apiKey !== undefined) target.apiKey = endpoint.apiKey
      if (endpoint.authTokenType !== undefined) target.authTokenType = endpoint.authTokenType
      if (endpoint.model?.trim()) {
        target.defaultModelId = ensureConnectionModel(target, endpoint.model)
      }
      if (endpointChanged) for (const item of target.models) delete item.reasoning
      for (const item of target.models) {
        item.reasoning ??= inferCatalogReasoningPolicy(target.protocol, target.baseURL, item.upstreamModel)
      }
      const model = target.models.find(m => m.id === target.defaultModelId) ?? target.models[0]
      return {
        version: 2,
        connections,
        ...(model ? { defaultModel: { connectionId: target.id, modelId: model.id } } : {}),
      }
    }
    return { version: 2, connections }
  }

  const groups = new Map<string, CatalogProfile[]>()
  for (const profile of profiles) {
    const key = profileConnectionKey(profile)
    const list = groups.get(key) ?? []
    list.push(profile)
    groups.set(key, list)
  }

  const nextConnections: CatalogConnection[] = []
  const connectionByProfileId = new Map<string, CatalogConnection>()
  for (const [key, group] of groups) {
    const activeFirst = [...group].sort((a, b) => Number(b.id === endpoint.activeProfileId) - Number(a.id === endpoint.activeProfileId))
    const first = activeFirst[0]!
    const existingConnection = connections.find(c => c.id === (first.connectionId ?? first.id))
      ?? connections.find(c => normalizeModelName(c.name) === normalizeModelName(first.providerName ?? ''))
      ?? connections.find(c => c.baseURL && c.baseURL === first.baseURL && c.protocol === first.provider)
    const connection: CatalogConnection = existingConnection ?? {
      id: first.connectionId ?? hashId('c', key),
      name: first.providerName?.trim() || first.baseURL?.trim() || 'provider',
      protocol: first.provider ?? 'anthropic',
      ...(first.baseURL !== undefined ? { baseURL: first.baseURL } : {}),
      ...(first.apiKey !== undefined ? { apiKey: first.apiKey } : {}),
      ...(first.authTokenType !== undefined ? { authTokenType: first.authTokenType } : {}),
      models: [],
    }
    const endpointChanged = Boolean(existingConnection && (
      (first.provider && first.provider !== existingConnection.protocol)
      || (first.baseURL !== undefined && first.baseURL !== existingConnection.baseURL)
    ))
    connection.name = first.providerName?.trim() || connection.name
    connection.protocol = first.provider ?? connection.protocol
    if (first.baseURL !== undefined) connection.baseURL = first.baseURL
    if (first.apiKey !== undefined) connection.apiKey = first.apiKey
    if (first.authTokenType !== undefined) connection.authTokenType = first.authTokenType

    const carriesModelList = group.some(profile => Array.isArray(profile.models))
    if (carriesModelList) {
      const nextModels: CatalogModel[] = []
      for (const profile of group) {
        for (const model of profile.models ?? []) {
          const existingModel = findExistingModel(connection, model.upstreamModel)
          const merged = mergeCatalogModel(existingModel, model, connection.id)
          if (!nextModels.some(m => normalizeModelName(m.upstreamModel) === normalizeModelName(merged.upstreamModel))) {
            nextModels.push(merged)
          }
        }
      }
      connection.models = nextModels
      if (!connection.models.some(m => m.id === connection.defaultModelId)) {
        connection.defaultModelId = connection.models[0]?.id
      }
    }

    for (const profile of group) {
      if (profile.model?.trim()) {
        const modelId = ensureConnectionModel(connection, profile.model)
        if (!connection.defaultModelId || profile.id === endpoint.activeProfileId) {
          connection.defaultModelId = modelId
        }
      }
    }

    const roles = { ...(connection.roles ?? {}) }
    const roleSources = [
      ['opus', first.defaultOpusModel],
      ['sonnet', first.defaultSonnetModel],
      ['haiku', first.defaultHaikuModel],
      ['subagent', first.subagentModel],
    ] as const
    for (const [role, upstream] of roleSources) {
      if (upstream?.trim()) roles[role] = ensureConnectionModel(connection, upstream)
    }
    if (Object.keys(roles).length) connection.roles = roles
    else delete connection.roles
    if (endpointChanged) {
      // Wire fields changed protocol/baseURL: old materialized policy is invalid.
      for (const model of connection.models) delete model.reasoning
    }

    for (const profile of group) {
      if (profile.id) connectionByProfileId.set(profile.id, connection)
    }
    if (connection.models.length > 0 || connection.name) nextConnections.push(connection)
  }

  const activeProfile = profiles.find(p => p.id === endpoint.activeProfileId)
    ?? profiles.find(p => normalizeModelName(p.model) === normalizeModelName(endpoint.model ?? ''))
  const activeConnection = (activeProfile?.id ? connectionByProfileId.get(activeProfile.id) : undefined)
    ?? (activeProfile?.connectionId ? nextConnections.find(c => c.id === activeProfile.connectionId) : undefined)
    ?? (endpoint.activeProfileId ? nextConnections.find(c => c.id === endpoint.activeProfileId) : undefined)
  // Never fall back to the first connection: a new provider's profile id is
  // not a connection id yet, and applying its credentials to connection[0]
  // would overwrite an unrelated provider.
  if (!activeConnection) return { version: 2, connections: nextConnections }
  const activeModel = activeConnection.models.find(m => normalizeModelName(m.upstreamModel) === normalizeModelName(endpoint.model ?? ''))
    ?? activeConnection.models.find(m => m.id === activeConnection.defaultModelId)
    ?? activeConnection.models[0]
  // Top-level edits from /config and ConsoleOAuthFlow target the active
  // connection; apply them here instead of silently dropping them.
  const topLevelEndpointChanged = Boolean(
    (endpoint.provider && endpoint.provider !== activeConnection.protocol)
    || (endpoint.baseURL !== undefined && endpoint.baseURL !== activeConnection.baseURL)
  )
  if (endpoint.provider) activeConnection.protocol = endpoint.provider
  if (endpoint.baseURL !== undefined) activeConnection.baseURL = endpoint.baseURL
  if (endpoint.apiKey !== undefined) activeConnection.apiKey = endpoint.apiKey
  if (endpoint.authTokenType !== undefined) activeConnection.authTokenType = endpoint.authTokenType
  if (topLevelEndpointChanged) {
    for (const model of activeConnection.models) delete model.reasoning
  }
  for (const model of activeConnection.models) {
    model.reasoning ??= inferCatalogReasoningPolicy(activeConnection.protocol, activeConnection.baseURL, model.upstreamModel)
  }
  let finalModel = activeConnection.models.find(m => normalizeModelName(m.upstreamModel) === normalizeModelName(endpoint.model ?? ''))
  if (endpoint.model?.trim()) {
    const modelId = ensureConnectionModel(activeConnection, endpoint.model)
    finalModel = activeConnection.models.find(model => model.id === modelId) ?? finalModel
    activeConnection.defaultModelId = modelId
  } else if (activeModel) {
    activeConnection.defaultModelId = activeModel.id
  }
  finalModel ??= activeConnection.models.find(m => m.id === activeConnection.defaultModelId) ?? activeConnection.models[0]
  for (const connection of nextConnections) {
    for (const model of connection.models) {
      if (!model.reasoning) {
        model.reasoning = inferCatalogReasoningPolicy(connection.protocol, connection.baseURL, model.upstreamModel)
      }
    }
  }
  return {
    version: 2,
    connections: nextConnections,
    ...(finalModel ? { defaultModel: { connectionId: activeConnection.id, modelId: finalModel.id } } : {}),
  }
}

export function writeCatalogFromEndpoint(endpoint: CatalogEndpoint): void {
  const current = readModelCatalog()
  const next = endpointToCatalog(endpoint, current)
  if (current && JSON.stringify(current) === JSON.stringify(next)) return
  writeModelCatalog(next)
}
// ---- Migration-time reasoning inference -------------------------------------
// App materializes these policies on save; CLI does the same for legacy
// profiles / providers created from the terminal, so thinking never silently
// disappears when the App has not been opened yet.

const ALL_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const BASE_LEVELS: EffortLevel[] = ['low', 'medium', 'high']

function inferNamed(
  field: string,
  levels: EffortLevel[],
  wireMap?: Partial<Record<EffortLevel, string>>,
  appliedMap?: Partial<Record<EffortLevel, EffortLevel>>,
): EffortPolicy {
  return {
    mode: 'named',
    field,
    levels: [...levels],
    ...(wireMap ? { wireMap } : {}),
    ...(appliedMap ? { appliedMap } : {}),
  }
}

function inferPolicy(
  preset: ReasoningPresetId,
  thinking: ThinkingPolicy,
  effort: EffortPolicy,
): ReasoningPolicy {
  return {
    preset,
    thinking,
    effort,
    response: { openaiFields: ['reasoning_content', 'reasoning'], display: 'full' },
  }
}

function inferEffortField(protocol: ModelProtocol): string {
  return protocol === 'anthropic' ? 'output_config.effort' : protocol === 'responses' ? 'reasoning.effort' : 'reasoning_effort'
}

function isOfficialAnthropic(baseURL?: string): boolean {
  if (!baseURL?.trim()) return true
  try {
    const host = new URL(baseURL.trim()).host.toLowerCase()
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com')
  } catch {
    return false
  }
}

function isClaude45(id: string): boolean {
  return /^claude-(?:opus|sonnet|haiku)-4-5(?:$|[-.])/.test(id)
}

function isClaudeModern(id: string): boolean {
  return (
    /^claude-(?:fable|mythos)-(?:5|5-1)(?:$|[-.])/.test(id)
    || /^claude-opus-(?:5|5-5|4-[678])(?:$|[-.])/.test(id)
    || /^claude-sonnet-(?:5|4-6)(?:$|[-.])/.test(id)
  )
}

function claudeLevels(id: string): EffortLevel[] {
  if (/^claude-opus-4-8(?:$|[-.])/.test(id)) return [...ALL_LEVELS]
  if (isClaudeModern(id) || /^claude-opus-4-5(?:$|[-.])/.test(id) || /^claude-sonnet-4-5(?:$|[-.])/.test(id)) {
    return [...BASE_LEVELS]
  }
  return []
}

function anthropicThinking(id: string): ThinkingPolicy {
  if (isClaudeModern(id)) {
    return { mode: 'value', field: 'thinking', value: { type: 'adaptive', display: 'summarized' } }
  }
  if (isClaude45(id)) {
    return { mode: 'budget', field: 'thinking', budgetTokens: 4096 }
  }
  return { mode: 'none' }
}

function anthropicInference(id: string, baseURL: string | undefined): ReasoningPolicy {
  const official = isOfficialAnthropic(baseURL)
  if (!official) {
    return inferPolicy(
      'anthropic',
      { mode: 'none' },
      /^claude-/.test(id) ? inferNamed('output_config.effort', BASE_LEVELS) : { mode: 'none' },
    )
  }
  const levels = claudeLevels(id)
  return inferPolicy(
    'anthropic',
    anthropicThinking(id),
    levels.length ? inferNamed('output_config.effort', levels) : { mode: 'none' },
  )
}

/** Conservative mirror of App inferReasoningPolicy for migrated models. */
export function inferCatalogReasoningPolicy(
  protocol: ModelProtocol,
  baseURL: string | undefined,
  model: string,
): ReasoningPolicy {
  const id = normalizeModelName(model)
  const field = inferEffortField(protocol)
  if (/^claude-/.test(id)) return anthropicInference(id, baseURL)
  if (/deepseek/.test(id)) {
    return inferPolicy('deepseek', { mode: 'always' }, inferNamed(field, ALL_LEVELS, { medium: 'high', xhigh: 'high' }, { medium: 'high', xhigh: 'high' }))
  }
  if (/glm-|flashx/.test(id)) {
    if (/glm-5\.3|flashx/.test(id)) {
      return inferPolicy('glm', { mode: 'always' }, inferNamed(field, ALL_LEVELS, { medium: 'high', xhigh: 'max' }, { medium: 'high', xhigh: 'max' }))
    }
    if (/glm-5\.2/.test(id)) {
      return inferPolicy('glm', { mode: 'always' }, inferNamed(field, ALL_LEVELS, undefined, { low: 'high', medium: 'high', xhigh: 'max' }))
    }
    return inferPolicy('glm', { mode: 'always' }, inferNamed(field, ALL_LEVELS))
  }
  if (/kimi|moonshot/.test(id)) {
    if (/k2\.6|k2\.7/.test(id)) return inferPolicy('kimi', { mode: 'always' }, { mode: 'none' })
    return inferPolicy('kimi', { mode: 'always' }, inferNamed(field, ALL_LEVELS, { medium: 'high', xhigh: 'high' }, { medium: 'high', xhigh: 'high' }))
  }
  if (/qwen/.test(id)) {
    if (protocol === 'openai') {
      return inferPolicy('qwen', { mode: 'toggle', field: 'enable_thinking', on: true, off: false }, {
        mode: 'budget',
        field: 'thinking_budget',
        levels: ALL_LEVELS,
        budgets: { low: 1024, medium: 4096, high: 16384, xhigh: 24576, max: 32768 },
        maxBudget: 32768,
        reserveOutputTokens: 1024,
      })
    }
    if (protocol === 'responses') {
      return inferPolicy('qwen', { mode: 'always' }, { mode: 'none' })
    }
    return inferPolicy('qwen', { mode: 'always' }, inferNamed('output_config.effort', ALL_LEVELS, { low: 'high', medium: 'high', xhigh: 'max', max: 'max' }, { low: 'high', medium: 'high', xhigh: 'max' }))
  }
  if (/grok/.test(id)) {
    return inferPolicy('xai', { mode: 'always' }, inferNamed(field, ALL_LEVELS, undefined, /grok-(?:4\.6|5)/.test(id) ? { max: 'xhigh' } : { xhigh: 'high', max: 'high' }))
  }
  if (/^(?:o[1-9](?:$|[-.])|gpt-5(?:$|[-.]))/.test(id)) {
    return protocol === 'responses'
      ? inferPolicy('openai', { mode: 'value', field: 'reasoning.summary', value: 'auto' }, inferNamed(field, BASE_LEVELS))
      : inferPolicy('openai', { mode: 'none' }, inferNamed(field, BASE_LEVELS))
  }
  return inferPolicy('generic', { mode: 'none' }, { mode: 'none' })
}

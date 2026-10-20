import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import { getApiKeyFromConfigOrMacOSKeychain, type ApiKeySource } from '../auth.js'
import { getGlobalConfig } from '../config.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { OAuthTokens } from '../../services/oauth/types.js'
import { readMergedCustomApiStorage, modelProfileEnvPatch, type CustomApiStorageData } from '../customApiStorage.js'
import { getOAuthTokenFromFileDescriptor } from '../authFileDescriptor.js'
import { isBareMode, isEnvTruthy } from '../envUtils.js'
import { getSecureStorage } from '../secureStorage/index.js'
import { matchModelProfile, resolveProfileReference } from './profileIdentity.js'

export type ModelEnvironment = {
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly stored: Readonly<CustomApiStorageData>
  readonly oauth: OAuthTokens | null
  readonly oauthAccountId?: string
  readonly mainLoopModelOverride?: string | null
  readonly settingsModel?: string
  readonly oauthSource: 'external' | 'storage'
  readonly loginApiKey: { key: string; source: ApiKeySource } | null
}

const contexts = new AsyncLocalStorage<ModelEnvironment>()
type OAuthSession = { tokens: OAuthTokens }
const oauthSessions = new WeakMap<ModelEnvironment, OAuthSession>()
const oauthLineages = new Map<string, WeakRef<OAuthSession>>()
function tokenKey(tokens?: OAuthTokens | null): string | undefined {
  return tokens?.accessToken ? `${getModelEnvironment().CLAUDE_CONFIG_DIR ?? ''}:${tokens.accessToken}` : undefined
}
function registerOAuthSession(snapshot: ModelEnvironment): void {
  if (!snapshot.oauth?.accessToken) return
  for (const [key, ref] of oauthLineages) if (!ref.deref()) oauthLineages.delete(key)
  const key = tokenKey(snapshot.oauth)!
  const session = oauthLineages.get(key)?.deref() ?? { tokens: snapshot.oauth }
  oauthLineages.set(key, new WeakRef(session))
  oauthSessions.set(snapshot, session)
}
export function getModelMainLoopOverride(): string | null | undefined {
  const context = contexts.getStore()
  return context ? context.mainLoopModelOverride : getMainLoopModelOverride()
}
export function getModelSettingsModel(): string | undefined {
  const context = contexts.getStore()
  return context ? context.settingsModel : getSettings_DEPRECATED()?.model
}

export function hasModelEnvironment(): boolean { return contexts.getStore() !== undefined }
export function getModelEnvironment(): NodeJS.ProcessEnv { return contexts.getStore()?.env ?? process.env }
export function readModelApiStorage(): CustomApiStorageData {
  return contexts.getStore()?.stored ?? (isBareMode() ? {} : readMergedCustomApiStorage())
}
export function getModelOAuthTokens(): OAuthTokens | null | undefined {
  const context = contexts.getStore()
  return context ? oauthSessions.get(context)?.tokens ?? context.oauth : undefined
}
export function getModelLoginApiKey(): ModelEnvironment['loginApiKey'] | undefined {
  return contexts.getStore()?.loginApiKey
}
export function updateModelOAuthTokens(tokens: OAuthTokens, previous?: OAuthTokens | null): void {
  const context = contexts.getStore()
  const oldKey = tokenKey(previous)
  const session = (context ? oauthSessions.get(context) : undefined) ?? (oldKey ? oauthLineages.get(oldKey)?.deref() : undefined)
  if (!session) return
  session.tokens = Object.freeze({ ...tokens })
  const nextKey = tokenKey(tokens)
  if (nextKey) oauthLineages.set(nextKey, new WeakRef(session))
}

export function canUpdateModelOAuthAccount(): boolean {
  const context = contexts.getStore()
  return !context || context.oauthAccountId === getGlobalConfig().oauthAccount?.accountUuid
}

export function canPersistModelOAuthTokens(persisted?: OAuthTokens | null): boolean {
  const context = contexts.getStore()
  if (!context) return true
  if (context.oauthSource === 'external' || !canUpdateModelOAuthAccount()) return false
  const key = tokenKey(persisted)
  return !!key && oauthLineages.get(key)?.deref() === oauthSessions.get(context)
}

/** Accept cross-process rotation only while the selected OAuth account is unchanged. */
export async function readUpdatedModelOAuthTokens(): Promise<OAuthTokens | null | undefined> {
  const context = contexts.getStore()
  if (!context) return undefined
  const current = getModelOAuthTokens()
  if (context.oauthSource === 'external' || !context.oauthAccountId || !canUpdateModelOAuthAccount()) return current
  const storage = getSecureStorage() as { readAsync?: () => Promise<Record<string, unknown> | null> }
  let next: OAuthTokens | undefined
  try { next = (await storage.readAsync?.())?.claudeAiOauth as OAuthTokens | undefined }
  catch { return current }
  // Login can change during readAsync; never adopt a different account's token.
  if (next?.accessToken && canUpdateModelOAuthAccount()) updateModelOAuthTokens(next, current)
  return getModelOAuthTokens()
}

/** Resolve protocol, endpoint and authentication together, including explicit anthropic. */
export function getModelConnection() {
  const env = getModelEnvironment()
  const stored: CustomApiStorageData = isEnvTruthy(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) ? {} : readModelApiStorage()
  const profiles = stored.modelProfiles ?? []
  const profile = (env.DOGE_ACTIVE_MODEL_PROFILE ? resolveProfileReference(profiles, env.DOGE_ACTIVE_MODEL_PROFILE) : undefined)
    ?? (env.ANTHROPIC_MODEL ? matchModelProfile(profiles, env.ANTHROPIC_MODEL, env) : undefined)
  const fallback = profile ?? stored
  const rawProvider = env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER ?? fallback.provider
  return {
    provider: rawProvider === 'openai' || rawProvider === 'responses' ? rawProvider : 'anthropic' as const,
    baseURL: env.ANTHROPIC_BASE_URL || fallback.baseURL || 'https://api.anthropic.com',
    apiKey: env.DOGE_API_KEY || env.ANTHROPIC_AUTH_TOKEN || fallback.apiKey || null,
    authTokenType: env.DOGE_API_KEY ? 'DOGE_API_KEY' : env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN'
      : fallback.authTokenType ?? 'DOGE_API_KEY',
  }
}

/** Capture at worker creation, not at its first request/yield. Never serialize this object. */
export function captureModelEnvironment(env: NodeJS.ProcessEnv = getModelEnvironment()): ModelEnvironment {
  const parent = contexts.getStore()
  if (parent && env === parent.env) return parent
  const snapshot = Object.freeze({ ...env })
  const stored = Object.freeze(structuredClone(readModelApiStorage()))
  const storage = getSecureStorage() as { read?: () => Record<string, unknown> | null }
  const token = isBareMode() ? undefined : snapshot.CLAUDE_CODE_OAUTH_TOKEN || getOAuthTokenFromFileDescriptor()
  const oauth = parent?.oauth ?? (isBareMode() ? null : token
    ? { accessToken: token, scopes: ['user:inference'] }
    : storage.read?.()?.claudeAiOauth as OAuthTokens | undefined) ?? null
  const context = Object.freeze({ env: snapshot, stored, oauth: oauth ? Object.freeze(structuredClone(oauth)) : null,
    loginApiKey: parent ? parent.loginApiKey : getApiKeyFromConfigOrMacOSKeychain(),
    oauthAccountId: parent?.oauthAccountId ?? getGlobalConfig().oauthAccount?.accountUuid,
    oauthSource: parent?.oauthSource ?? (token ? 'external' as const : 'storage' as const),
    mainLoopModelOverride: getModelMainLoopOverride(), settingsModel: getModelSettingsModel() })
  registerOAuthSession(context)
  return context
}

export function runWithModelEnvironment<T>(snapshot: ModelEnvironment, callback: () => T): T {
  return contexts.run(snapshot, callback)
}

/** Each generator operation owns its async chain; callers never inherit worker secrets. */
export function iterateWithModelEnvironment<T, R = void, N = unknown>(
  factory: () => AsyncGenerator<T, R, N>, snapshot = captureModelEnvironment(),
): AsyncGenerator<T, R, N> {
  let iterator: AsyncGenerator<T, R, N> | undefined
  const getIterator = () => iterator ??= factory()
  return {
    next: (...args: [] | [N]) => runWithModelEnvironment(snapshot, () => getIterator().next(...args)),
    return: value => runWithModelEnvironment(snapshot, () => getIterator().return(value)),
    throw: error => runWithModelEnvironment(snapshot, () => getIterator().throw(error)),
    [Symbol.asyncIterator]() { return this },
  }
}


/** Kept only in process memory: sidecar metadata must never contain credentials. */
const agentEnvironments = new Map<string, ModelEnvironment>()
export type ModelConnectionIdentity = { profileId?: string; provider: string; baseURL: string }
export function rememberAgentModelEnvironment(agentId: string, snapshot: ModelEnvironment): void {
  agentEnvironments.set(agentId, snapshot)
}
export function getModelConnectionIdentity(): ModelConnectionIdentity {
  const { provider, baseURL } = getModelConnection()
  return { provider, baseURL, profileId: getModelEnvironment().DOGE_ACTIVE_MODEL_PROFILE || undefined }
}
export function restoreAgentModelEnvironment(
  agentId: string, identity: ModelConnectionIdentity | undefined, fallback: ModelEnvironment,
): ModelEnvironment {
  const existing = agentEnvironments.get(agentId)
  if (existing) return existing
  if (!identity) return fallback // Legacy transcripts have no connection identity.
  return runWithModelEnvironment(fallback, () => {
    if (!identity.profileId) {
      const current = getModelConnection()
      if (current.provider !== identity.provider || current.baseURL !== identity.baseURL) {
        throw new Error('无法恢复代理的原始模型连接，请选择原连接后重试或新建代理')
      }
      return fallback
    }
    const profile = resolveProfileReference(fallback.stored.modelProfiles ?? [], identity.profileId)
    if (!profile) throw new Error('代理原模型配置已不存在，请恢复配置后重试或新建代理')
    const normalizeURL = (url: string): string => new URL(url).href.replace(/\/+$/, '')
    if ((profile.provider ?? 'anthropic') !== identity.provider ||
      normalizeURL(profile.baseURL || 'https://api.anthropic.com') !== normalizeURL(identity.baseURL)) {
      throw new Error('代理原始模型连接已变更，请恢复原配置后重试或新建代理')
    }
    const env = { ...fallback.env, ...modelProfileEnvPatch(profile), CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' }
    const captured = captureModelEnvironment(env)
    const restored = Object.freeze({ ...captured, mainLoopModelOverride: profile.model, settingsModel: profile.model })
    registerOAuthSession(restored)
    return restored
  })
}

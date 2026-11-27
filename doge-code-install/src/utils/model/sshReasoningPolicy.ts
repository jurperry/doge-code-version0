import { isEnvTruthy } from '../envUtils.js'
import { catalogConnectionForRequest, type ReasoningPolicy } from './modelCatalog.js'

const ENV_KEY = 'DOGE_SSH_REASONING_POLICIES'
type Snapshot = { connectionId: string; policies: Record<string, ReasoningPolicy> }

const modelKey = (model: string): string => model.toLowerCase().trim().replace(/\[[12]m\]$/i, '')

/** Only the active connection's reasoning controls travel over SSH. */
export function sshReasoningEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const connection = catalogConnectionForRequest(env)?.connection
  if (!connection) return { [ENV_KEY]: '' }
  const policies: Snapshot['policies'] = Object.fromEntries(connection.models.flatMap(model => {
    const { reasoning } = model
    if (!reasoning) return []
    // Connection routing, credentials and arbitrary request extensions stay local.
    const { preset, thinking, effort, response } = reasoning
    return [[modelKey(model.upstreamModel), { preset, thinking, effort, response }]]
  }))
  return { [ENV_KEY]: JSON.stringify({ connectionId: connection.id, policies } satisfies Snapshot) }
}

export function usesSshModelTunnel(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ANTHROPIC_UNIX_SOCKET && isEnvTruthy(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST))
}

let cached: { encoded: string; snapshot?: Snapshot } | undefined

/** The remote catalog is unrelated to the connection owned by the SSH client. */
export function sshReasoningPolicy(model: string, env: NodeJS.ProcessEnv): ReasoningPolicy | undefined {
  const encoded = env[ENV_KEY]
  if (!encoded) return undefined
  if (cached?.encoded !== encoded) {
    let snapshot: Snapshot | undefined
    try { snapshot = JSON.parse(encoded) as Snapshot } catch { /* malformed or old host */ }
    cached = { encoded, snapshot }
  }
  const snapshot = cached.snapshot
  const active = env.DOGE_ACTIVE_CONNECTION_ID || env.DOGE_ACTIVE_MODEL_PROFILE?.split(':')[0]
  if (!snapshot?.policies || (active && snapshot.connectionId !== active)) return undefined
  const normalized = modelKey(model === 'default' ? env.ANTHROPIC_MODEL ?? model : model)
  const tier = normalized === 'opus' || normalized === 'sonnet' || normalized === 'haiku' ? normalized : undefined
  const key = modelKey(tier ? env[`ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`] ?? normalized : normalized)
  return Object.hasOwn(snapshot.policies, key) ? snapshot.policies[key] : undefined
}

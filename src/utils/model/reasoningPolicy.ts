import type { EffortLevel } from './effortCapabilities.js'
import { catalogPolicyForModel, type ReasoningPolicy } from './modelCatalog.js'
import { availableEffortLevels, planReasoningRequest, removeEffortFields } from './reasoningRequest.js'
import { getModelEnvironment } from './runtimeModelContext.js'

/**
 * Reasoning policy read directly from the unified Model Catalog.
 *
 * There is no host-policy env snapshot anymore: App and CLI both read
 * `~/.doge/model-catalog.json`. This module only turns a policy into wire
 * fields; model capability inference for first-party Claude stays elsewhere.
 */

export type HostReasoningPolicy = ReasoningPolicy
export { removeEffortFields }

export interface HostReasoningPlan {
  wireEffort?: string
  extraBody?: Record<string, unknown>
  applied?: EffortLevel
  downgraded: boolean
  warnings: string[]
  levels: EffortLevel[]
  supportsEffort: boolean
  supportsMax: boolean
  thinking: 'adaptive' | 'budget' | 'none'
  responseFields: string[]
}

/** 运行时 400 后禁用该模型的 host policy，直到进程结束；防止重试继续发同一参数。 */
const disabledHostModels = new Set<string>()

export function disableHostReasoningPolicy(model: string): void {
  disabledHostModels.add(reasoningRouteKey(model))
}

export function clearHostReasoningDisables(): void {
  disabledHostModels.clear()
}

function normalizeModelId(model: string): string {
  return model.toLowerCase().trim().replace(/\[(?:1|2)m\]$/i, '').replace(/@\d+$/i, '')
}

function reasoningRouteKey(model: string, env = getModelEnvironment()): string {
  return JSON.stringify([
    env.DOGE_ACTIVE_CONNECTION_ID || env.DOGE_ACTIVE_MODEL_PROFILE,
    env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER,
    env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, ''),
    normalizeModelId(model),
  ])
}

export function wasEffortRejected(model: string, env = getModelEnvironment()): boolean {
  return disabledHostModels.has(reasoningRouteKey(model, env))
}

function isPolicy(value: unknown): value is HostReasoningPolicy {
  if (!value || typeof value !== 'object') return false
  const p = value as HostReasoningPolicy
  return !!p.thinking && typeof p.thinking === 'object' && !!p.effort && typeof p.effort === 'object' && !!p.response && typeof p.response === 'object'
}

/** Read the model's policy from the catalog (active connection first). */
export function getHostReasoningPolicy(model: string, env = getModelEnvironment()): HostReasoningPolicy | undefined {
  return wasEffortRejected(model, env) ? undefined : getCatalogReasoningPolicy(model, env)
}

/** Response display rules still apply after a wire-parameter rejection. */
export function getCatalogReasoningPolicy(model: string, env = getModelEnvironment()): HostReasoningPolicy | undefined {
  const policy = catalogPolicyForModel(model, undefined, env)
  return isPolicy(policy) ? policy : undefined
}

export function hostReasoningLevels(policy: HostReasoningPolicy | undefined, thinkingEnabled?: boolean): EffortLevel[] {
  return policy ? availableEffortLevels(policy, thinkingEnabled) : []
}

export function hostReasoningThinking(policy: HostReasoningPolicy | undefined): 'adaptive' | 'budget' | 'none' {
  if (!policy) return 'none'
  if (policy.thinking.mode === 'budget' && policy.thinking.field === 'thinking') return 'budget'
  if (policy.thinking.mode === 'value' && policy.thinking.field === 'thinking') {
    const value = policy.thinking.value
    if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'adaptive') return 'adaptive'
  }
  return 'none'
}

export function hostResponseFields(policy: HostReasoningPolicy | undefined): string[] {
  if (policy?.response.display === 'none') return []
  const fields = policy?.response.openaiFields?.filter((f) => typeof f === 'string' && f.trim())
  return fields?.length ? fields : ['reasoning_content', 'reasoning']
}

/** Adapt the catalog's wire plan to the CLI's Anthropic output_config path. */
export function planHostReasoning(input: {
  policy: HostReasoningPolicy
  requested: EffortLevel | undefined
  maxOutputTokens?: number
  suppressEffort?: boolean
  thinkingEnabled?: boolean
}): HostReasoningPlan {
  const { policy, maxOutputTokens } = input
  const { request, applied, levels, downgraded, warnings } = planReasoningRequest({
    ...input,
    outputLimit: maxOutputTokens,
  })
  let wireEffort: string | undefined
  if (applied !== 'auto' && policy.effort.mode === 'named' && policy.effort.field === 'output_config.effort') {
    const output = request.output_config as Record<string, unknown>
    wireEffort = output.effort as string
    delete output.effort
    if (Object.keys(output).length === 0) delete request.output_config
  }
  return {
    ...(wireEffort ? { wireEffort } : {}),
    ...(Object.keys(request).length ? { extraBody: request } : {}),
    ...(applied === 'auto' ? {} : { applied }),
    downgraded,
    warnings,
    levels,
    supportsEffort: levels.length > 0,
    supportsMax: levels.includes('max'),
    thinking: hostReasoningThinking(policy),
    responseFields: hostResponseFields(policy),
  }
}

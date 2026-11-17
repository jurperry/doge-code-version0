import type { EffortLevel } from './effortCapabilities.js'
import { catalogPolicyForModel } from './modelCatalog.js'
import { getModelEnvironment } from './runtimeModelContext.js'

/**
 * Reasoning policy read directly from the unified Model Catalog.
 *
 * There is no host-policy env snapshot anymore: App and CLI both read
 * `~/.doge/model-catalog.json`. This module only turns a policy into wire
 * fields; model capability inference for first-party Claude stays elsewhere.
 */

export type HostProtocol = 'anthropic' | 'openai' | 'responses'
export type HostReasoningPreset =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'glm'
  | 'kimi'
  | 'qwen'
  | 'xai'
  | 'generic'

export type HostThinkingPolicy =
  | { mode: 'none' }
  | { mode: 'always' }
  | { mode: 'value'; field: string; value: unknown }
  | { mode: 'toggle'; field: string; on: unknown; off: unknown }
  | { mode: 'budget'; field: string; budgetTokens?: number }

export type HostEffortPolicy =
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

export interface HostReasoningPolicy {
  preset: HostReasoningPreset
  thinking: HostThinkingPolicy
  effort: HostEffortPolicy
  response: { openaiFields: string[]; display: 'full' | 'summary' | 'none' }
  extraBody?: Record<string, unknown>
}

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

const LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

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

function reasoningRouteKey(model: string): string {
  const env = getModelEnvironment()
  return JSON.stringify([
    env.DOGE_ACTIVE_CONNECTION_ID || env.DOGE_ACTIVE_MODEL_PROFILE,
    env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER,
    env.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, ''),
    normalizeModelId(model),
  ])
}

export function wasEffortRejected(model: string): boolean {
  return disabledHostModels.has(reasoningRouteKey(model))
}

function isLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (LEVELS as string[]).includes(value)
}

function isPolicy(value: unknown): value is HostReasoningPolicy {
  if (!value || typeof value !== 'object') return false
  const p = value as HostReasoningPolicy
  return !!p.thinking && typeof p.thinking === 'object' && !!p.effort && typeof p.effort === 'object' && !!p.response && typeof p.response === 'object'
}

/** Read the model's policy from the catalog (active connection first). */
export function getHostReasoningPolicy(model: string): HostReasoningPolicy | undefined {
  return wasEffortRejected(model) ? undefined : getCatalogReasoningPolicy(model)
}

/** Response display rules still apply after a wire-parameter rejection. */
export function getCatalogReasoningPolicy(model: string): HostReasoningPolicy | undefined {
  const policy = catalogPolicyForModel(model, undefined, getModelEnvironment())
  return isPolicy(policy) ? policy : undefined
}

export function hostReasoningLevels(policy: HostReasoningPolicy | undefined): EffortLevel[] {
  if (!policy || policy.effort.mode === 'none' || !isReasoningFieldPath(policy.effort.field) || !Array.isArray(policy.effort.levels)) return []
  if ('field' in policy.thinking && pathsOverlap(policy.thinking.field, policy.effort.field)) return []
  return policy.effort.levels.filter(isLevel)
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

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!isReasoningFieldPath(path)) return
  const parts = path.split('.')
  let cursor = target
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[parts.at(-1)!] = value
}

function isReasoningFieldPath(path: unknown): path is string {
  return typeof path === 'string' && path.split('.').every(part =>
    /^[a-zA-Z_][\w-]*$/.test(part) && !Object.hasOwn(Object.prototype, part) && part !== 'prototype')
}

function pathsOverlap(a: unknown, b: string): boolean {
  return typeof a === 'string' && (a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`))
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const [key, ...parts] = path.split('.')
  if (!key || !Object.hasOwn(target, key)) return
  if (!parts.length) {
    delete target[key]
    return
  }
  const value = target[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const next = { ...(value as Record<string, unknown>) }
  deletePath(next, parts.join('.'))
  if (Object.keys(next).length) target[key] = next
  else delete target[key]
}

export function removeEffortFields(target: Record<string, unknown>, policy?: HostReasoningPolicy): void {
  for (const path of ['output_config.effort', 'reasoning.effort', 'reasoning_effort', 'anthropic_internal.effort_override']) {
    deletePath(target, path)
  }
  if (policy && 'field' in policy.effort && isReasoningFieldPath(policy.effort.field)) deletePath(target, policy.effort.field)
}

function clone<T>(value: T): T {
  return value === undefined || value === null || typeof value !== 'object'
    ? value
    : JSON.parse(JSON.stringify(value)) as T
}

function budgetFor(policy: Extract<HostEffortPolicy, { mode: 'budget' }>, level: EffortLevel, outputLimit?: number): number {
  const raw = policy.budgets[level] ?? policy.budgets[policy.defaultLevel ?? 'medium'] ?? 4096
  let budget = policy.maxBudget === undefined ? raw : Math.min(raw, policy.maxBudget)
  if (outputLimit !== undefined && outputLimit > 0) {
    const reserve = policy.reserveOutputTokens ?? 0
    const room = outputLimit - reserve
    budget = room >= 1 ? Math.min(budget, room) : Math.min(budget, outputLimit)
  }
  return Math.max(1, Math.floor(budget))
}

/**
 * 生成 host policy 的 wire 计划：
 * - output_config.effort 仍走 EffortWirePlan.wireEffort（Anthropic 专用）；
 * - 其余字段（reasoning_effort / reasoning / enable_thinking / thinking）放
 *   extraBody，CLI 的 compat 路径会原样并入请求体。
 */
export function planHostReasoning(input: {
  policy: HostReasoningPolicy
  requested: EffortLevel | undefined
  maxOutputTokens?: number
  suppressEffort?: boolean
  thinkingEnabled?: boolean
}): HostReasoningPlan {
  const { policy } = input
  const effortOff = input.suppressEffort || (input.thinkingEnabled === false &&
    (policy.thinking.mode === 'toggle' || policy.effort.mode === 'budget'))
  const levels = effortOff ? [] : hostReasoningLevels(policy)
  const requested = effortOff ? undefined : input.requested
  const extraBody: Record<string, unknown> = { ...(policy.extraBody ? clone(policy.extraBody) : {}) }
  if (effortOff) removeEffortFields(extraBody, policy)
  let wireEffort: string | undefined
  let applied: EffortLevel | undefined
  let downgraded = false
  const warnings: string[] = []

  const supported = requested !== undefined && levels.includes(requested)
  if (requested !== undefined && !supported) {
    warnings.push(`模型未声明支持 ${requested} 档，按自动处理`)
    downgraded = true
  }
  const defaultLevel = policy.effort.mode === 'none' ? undefined : policy.effort.defaultLevel
  const autoUsesDefault = requested === undefined && defaultLevel !== undefined && levels.includes(defaultLevel)
  const effective = autoUsesDefault ? defaultLevel : supported ? requested : undefined

  if (effective && policy.effort.mode === 'named') {
    const wire = policy.effort.wireMap?.[effective] ?? effective
    applied = policy.effort.appliedMap?.[effective] ?? effective
    downgraded = downgraded || applied !== effective
    if (policy.effort.field === 'output_config.effort') wireEffort = wire
    else setPath(extraBody, policy.effort.field, wire)
  } else if (effective && policy.effort.mode === 'budget') {
    applied = effective
    setPath(extraBody, policy.effort.field, budgetFor(policy.effort, effective, input.maxOutputTokens))
  }

  if (input.thinkingEnabled === false) {
    if ('field' in policy.thinking && isReasoningFieldPath(policy.thinking.field)) deletePath(extraBody, policy.thinking.field)
    if (policy.thinking.mode === 'toggle') setPath(extraBody, policy.thinking.field, clone(policy.thinking.off))
  } else if (policy.thinking.mode === 'value') {
    if (policy.thinking.field !== 'output_config.effort') setPath(extraBody, policy.thinking.field, clone(policy.thinking.value))
  } else if (policy.thinking.mode === 'budget') {
    const raw = policy.thinking.budgetTokens ?? 4096
    const limit = input.maxOutputTokens
    const budget = limit === undefined ? raw : Math.min(Math.max(1, limit - 1), Math.max(1, raw))
    if (policy.thinking.field !== 'thinking' || budget >= 1024) {
      setPath(extraBody, policy.thinking.field, { type: 'enabled', budget_tokens: budget })
    }
  } else if (policy.thinking.mode === 'toggle' && effective) {
    setPath(extraBody, policy.thinking.field, clone(policy.thinking.on))
  }

  return {
    ...(wireEffort ? { wireEffort } : {}),
    ...(Object.keys(extraBody).length ? { extraBody } : {}),
    ...(applied ? { applied } : {}),
    downgraded,
    warnings,
    levels,
    supportsEffort: levels.length > 0 && policy.effort.mode !== 'none',
    supportsMax: levels.includes('max'),
    thinking: hostReasoningThinking(policy),
    responseFields: hostResponseFields(policy)
  }
}

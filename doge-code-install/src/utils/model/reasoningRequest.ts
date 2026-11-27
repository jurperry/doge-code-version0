import type { EffortLevel, EffortPolicy, ReasoningPolicy, ThinkingPolicy } from './modelCatalog.js'

const LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function isReasoningFieldPath(path: unknown): path is string {
  return typeof path === 'string' && path.split('.').every(part =>
    /^[a-zA-Z_][\w-]*$/.test(part) && !Object.hasOwn(Object.prototype, part) && part !== 'prototype')
}

export function reasoningPathsOverlap(a: unknown, b: string): boolean {
  return typeof a === 'string' && (a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`))
}

function thinkingIsOff(thinking: ThinkingPolicy, enabled?: boolean): boolean {
  return enabled === false || (thinking.mode === 'toggle' && thinking.defaultEnabled === false)
}

export function availableEffortLevels(policy: ReasoningPolicy, thinkingEnabled?: boolean): EffortLevel[] {
  const { thinking, effort } = policy
  if (effort.mode === 'none' || !isReasoningFieldPath(effort.field) || !Array.isArray(effort.levels)) return []
  if ('field' in thinking && reasoningPathsOverlap(thinking.field, effort.field)) return []
  if (thinkingIsOff(thinking, thinkingEnabled) && (thinking.mode === 'toggle' || effort.mode === 'budget')) return []
  return LEVELS.filter(level => effort.levels.includes(level))
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!isReasoningFieldPath(path)) return
  const parts = path.split('.')
  let parent = target
  for (const key of parts.slice(0, -1)) {
    const child = parent[key]
    if (!child || typeof child !== 'object' || Array.isArray(child)) parent[key] = {}
    parent = parent[key] as Record<string, unknown>
  }
  parent[parts.at(-1)!] = structuredClone(value)
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

export function removeEffortFields(target: Record<string, unknown>, policy?: ReasoningPolicy): void {
  for (const path of ['output_config.effort', 'reasoning.effort', 'reasoning_effort', 'anthropic_internal.effort_override']) {
    deletePath(target, path)
  }
  if (policy && 'field' in policy.effort && isReasoningFieldPath(policy.effort.field)) deletePath(target, policy.effort.field)
}

function budgetFor(policy: Extract<EffortPolicy, { mode: 'budget' }>, level: EffortLevel, outputLimit?: number): number {
  const raw = policy.budgets[level] ?? policy.budgets[policy.defaultLevel ?? 'medium'] ?? 4096
  const room = outputLimit === undefined ? Infinity : outputLimit - (policy.reserveOutputTokens ?? 0)
  return Math.max(1, Math.floor(Math.min(raw, policy.maxBudget ?? Infinity, room > 0 ? room : (outputLimit ?? Infinity))))
}

export function planReasoningRequest(input: {
  policy: ReasoningPolicy
  requested?: EffortLevel | 'auto'
  outputLimit?: number
  suppressEffort?: boolean
  thinkingEnabled?: boolean
}): {
  request: Record<string, unknown>
  applied: EffortLevel | 'auto'
  downgraded: boolean
  warnings: string[]
  levels: EffortLevel[]
} {
  const { policy, outputLimit, thinkingEnabled, suppressEffort } = input
  const { thinking, effort } = policy
  const off = thinkingIsOff(thinking, thinkingEnabled)
  const gated = suppressEffort || (off && (thinking.mode === 'toggle' || effort.mode === 'budget'))
  const levels = gated ? [] : availableEffortLevels(policy, thinkingEnabled)
  const requested = gated || input.requested === 'auto' ? undefined : input.requested
  const fallback = effort.mode === 'none' ? undefined : effort.defaultLevel
  const unsupported = requested !== undefined && !levels.includes(requested)
  const effective = requested && !unsupported ? requested : fallback && levels.includes(fallback) ? fallback : undefined
  const request = structuredClone(policy.extraBody ?? {})
  if (gated) removeEffortFields(request, policy)
  let applied: EffortLevel | 'auto' = 'auto'
  if (effective && effort.mode === 'named') {
    setPath(request, effort.field, effort.wireMap?.[effective] ?? effective)
    applied = effort.appliedMap?.[effective] ?? effective
  } else if (effective && effort.mode === 'budget') {
    setPath(request, effort.field, budgetFor(effort, effective, outputLimit))
    applied = effective
  }

  if (off) {
    if ('field' in thinking && isReasoningFieldPath(thinking.field)) deletePath(request, thinking.field)
    if (thinking.mode === 'toggle') setPath(request, thinking.field, thinking.off)
  } else if (thinking.mode === 'value' && thinking.field !== 'output_config.effort') {
    setPath(request, thinking.field, thinking.value)
  } else if (thinking.mode === 'budget') {
    const budget = Math.min(Math.max(1, thinking.budgetTokens ?? 4096), outputLimit === undefined ? Infinity : Math.max(1, outputLimit - 1))
    if (thinking.field !== 'thinking' || budget >= 1024) {
      setPath(request, thinking.field, { type: 'enabled', budget_tokens: budget })
    }
  } else if (thinking.mode === 'toggle' && (thinking.defaultEnabled === true || effective)) {
    setPath(request, thinking.field, thinking.on)
  }

  return {
    request,
    applied,
    downgraded: unsupported || (effective !== undefined && applied !== effective),
    warnings: unsupported ? [`模型未声明支持 ${requested} 档，按自动处理`] : [],
    levels,
  }
}

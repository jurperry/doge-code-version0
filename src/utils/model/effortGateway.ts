import type { EffortLevel } from './effortCapabilities.js'
import { getModelEnvironment } from './runtimeModelContext.js'

/**
 * Gateway-aware effort wire mapping.
 *
 * Internal code works with one five-level ladder (low/medium/high/xhigh/max),
 * but providers accept different subsets and express thinking differently
 * (`reasoning_effort`, `output_config.effort`, `reasoning.effort`, Qwen's
 * enable_thinking/thinking_budget). Mapping here prevents:
 *  - sending a value the gateway rejects (400), and
 *  - silently claiming a level that was never sent (the user-facing `applied`).
 *
 * Sources: docs/validation research (2026-10-18) under
 * E:\ClaudeCode\research\llm-thinking-apis.md. Gateways whose Anthropic
 * endpoint does not document effort (GLM) deliberately send nothing.
 */
export type EffortWireProtocol = 'anthropic' | 'openai' | 'responses'
export type EffortGatewayKind =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'glm'
  | 'kimi'
  | 'qwen'
  | 'openrouter'
  | 'xai'
  | 'gemini'
  | 'generic'

export interface EffortWirePlan {
  gateway: EffortGatewayKind
  /** Value for output_config.effort / reasoning_effort / reasoning.effort. */
  wireEffort?: string
  /** Extra top-level request body fields (e.g. Qwen enable_thinking). */
  extraBody?: Record<string, unknown>
  /** Level the user should see as applied (undefined = nothing sent). */
  applied?: EffortLevel
  downgraded: boolean
  reason?: 'gateway-unsupported' | 'gateway-clamped' | 'gateway-unverified'
  /** Human-readable detail for warnings/logs. */
  detail?: string
}

type LevelMap = Partial<Record<EffortLevel, { wire: string; applied: EffortLevel }>>

const PASS_THROUGH: LevelMap = {
  low: { wire: 'low', applied: 'low' },
  medium: { wire: 'medium', applied: 'medium' },
  high: { wire: 'high', applied: 'high' },
  xhigh: { wire: 'xhigh', applied: 'xhigh' },
  max: { wire: 'max', applied: 'max' },
}

/** DeepSeek / Kimi Anthropic-compatible endpoints: low/high/max only. */
const LOW_HIGH_MAX: LevelMap = {
  low: { wire: 'low', applied: 'low' },
  medium: { wire: 'high', applied: 'high' },
  high: { wire: 'high', applied: 'high' },
  xhigh: { wire: 'high', applied: 'high' },
  max: { wire: 'max', applied: 'max' },
}

/** GLM 5.3 family: forced thinking, only low/high/max accepted. */
const GLM_53_MAP: LevelMap = {
  low: { wire: 'low', applied: 'low' },
  medium: { wire: 'high', applied: 'high' },
  high: { wire: 'high', applied: 'high' },
  xhigh: { wire: 'max', applied: 'max' },
  max: { wire: 'max', applied: 'max' },
}

/** Qwen Anthropic endpoint (qwen3.8-max/flash): low/medium/xhigh only. */
const QWEN_ANTHROPIC_MAP: LevelMap = {
  low: { wire: 'low', applied: 'low' },
  medium: { wire: 'medium', applied: 'medium' },
  high: { wire: 'xhigh', applied: 'xhigh' },
  xhigh: { wire: 'xhigh', applied: 'xhigh' },
  max: { wire: 'xhigh', applied: 'xhigh' },
}

/** Qwen Anthropic endpoint behind glm-5.2 / deepseek-v4-pro: high/max only. */
const HIGH_MAX: LevelMap = {
  low: { wire: 'high', applied: 'high' },
  medium: { wire: 'high', applied: 'high' },
  high: { wire: 'high', applied: 'high' },
  xhigh: { wire: 'max', applied: 'max' },
  max: { wire: 'max', applied: 'max' },
}

/** GLM 5.2 accepts the wide enum but maps low/medium → high and xhigh → max. */
const GLM_52_MAP: LevelMap = {
  low: { wire: 'low', applied: 'high' },
  medium: { wire: 'medium', applied: 'high' },
  high: { wire: 'high', applied: 'high' },
  xhigh: { wire: 'xhigh', applied: 'max' },
  max: { wire: 'max', applied: 'max' },
}

/** xAI: none/low/medium/high/xhigh (no max). */
const XAI_MAP: LevelMap = {
  ...PASS_THROUGH,
  max: { wire: 'xhigh', applied: 'xhigh' },
}

/** Older xAI models do not expose xhigh either; clamp to high. */
const XAI_LEGACY_MAP: LevelMap = {
  ...PASS_THROUGH,
  xhigh: { wire: 'high', applied: 'high' },
  max: { wire: 'high', applied: 'high' },
}

/** Qwen OpenAI-compatible endpoint: token budget instead of a named level. */
const QWEN_BUDGETS: Record<EffortLevel, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 24576,
  max: 32768,
}

function resolveProtocol(protocol?: EffortWireProtocol): EffortWireProtocol {
  if (protocol) return protocol
  const raw = getModelEnvironment().CLAUDE_CODE_COMPATIBLE_API_PROVIDER
  return raw === 'openai' || raw === 'responses' ? raw : 'anthropic'
}

function resolveBaseURL(baseURL?: string): string {
  return (baseURL ?? getModelEnvironment().ANTHROPIC_BASE_URL ?? '').toLowerCase()
}

function detectGateway(baseURL: string, model: string): EffortGatewayKind {
  if (baseURL.includes('openrouter.ai')) return 'openrouter'
  if (baseURL.includes('deepseek')) return 'deepseek'
  if (/bigmodel|zhipu|z\.ai/.test(baseURL)) return 'glm'
  if (/moonshot|kimi/.test(baseURL)) return 'kimi'
  if (/dashscope|aliyuncs|qwen|model-studio/.test(baseURL)) return 'qwen'
  if (baseURL.includes('api.openai.com')) return 'openai'
  if (baseURL.includes('x.ai')) return 'xai'
  if (/googleapis|gemini/.test(baseURL)) return 'gemini'
  if (baseURL.includes('api.anthropic.com')) return 'anthropic'
  // Custom gateways that proxy multiple vendors: infer from the model id.
  if (model.includes('deepseek')) return 'deepseek'
  if (model.startsWith('glm-') || model.includes('glm-')) return 'glm'
  if (model.includes('kimi') || model.includes('moonshot')) return 'kimi'
  if (model.includes('qwen')) return 'qwen'
  if (baseURL) return 'generic'
  return 'generic'
}

function mapLevel(
  level: EffortLevel,
  map: LevelMap,
): Pick<EffortWirePlan, 'wireEffort' | 'applied' | 'downgraded'> {
  const mapped = map[level] ?? { wire: level, applied: level }
  return {
    wireEffort: mapped.wire,
    applied: mapped.applied,
    downgraded: mapped.applied !== level,
  }
}

function planForGateway(
  gateway: EffortGatewayKind,
  protocol: EffortWireProtocol,
  model: string,
  level: EffortLevel,
  thinkingEnabled: boolean | undefined,
  maxOutputTokens: number | undefined,
): EffortWirePlan {
  const base = { gateway, downgraded: false } as const
  switch (gateway) {
    case 'anthropic':
    case 'openai':
      return { ...base, ...mapLevel(level, PASS_THROUGH) }
    case 'deepseek':
      return { ...base, ...mapLevel(level, LOW_HIGH_MAX) }
    case 'kimi':
      // k2.6 only has a thinking on/off switch and k2.7-code is forced-on;
      // there is no strength control to map, so do not pretend.
      if (/k2\.6|k2\.7/.test(model)) {
        return {
          ...base,
          reason: 'gateway-unsupported',
          detail:
            'Kimi k2.6/k2.7 only expose a thinking toggle (or force it on); no effort strength is available.',
        }
      }
      return { ...base, ...mapLevel(level, LOW_HIGH_MAX) }
    case 'glm':
      return {
        ...base,
        ...mapLevel(
          level,
          /glm-5\.3|flashx/.test(model)
            ? GLM_53_MAP
            : /glm-5\.2/.test(model)
              ? GLM_52_MAP
              : PASS_THROUGH,
        ),
      }
    case 'qwen':
      if (protocol === 'openai') {
        // A disabled thinking mode must not be re-enabled by an effort hint.
        if (thinkingEnabled === false) {
          return {
            ...base,
            reason: 'gateway-unsupported',
            detail: 'Thinking is disabled for this session; Qwen effort is not sent.',
          }
        }
        const budgetLimit = Math.max(
          1024,
          (maxOutputTokens ?? 32_000) - 1024,
        )
        const budget = Math.min(QWEN_BUDGETS[level], budgetLimit)
        return {
          ...base,
          applied: level,
          extraBody: {
            enable_thinking: true,
            thinking_budget: budget,
          },
          detail: 'Qwen OpenAI-compatible endpoint: thinking is controlled by enable_thinking + thinking_budget.',
        }
      }
      if (protocol === 'responses') {
        return {
          ...base,
          reason: 'gateway-unsupported',
          detail: 'Qwen Responses-compatible endpoint does not document an effort field.',
        }
      }
      if (/qwen3\.8|qwen3-8/.test(model)) return { ...base, ...mapLevel(level, QWEN_ANTHROPIC_MAP) }
      if (/glm-5\.3|flashx/.test(model)) return { ...base, ...mapLevel(level, GLM_53_MAP) }
      if (/glm-5\.2/.test(model)) return { ...base, ...mapLevel(level, GLM_52_MAP) }
      return { ...base, ...mapLevel(level, HIGH_MAX) }
    case 'xai':
      return {
        ...base,
        ...mapLevel(level, /grok-(?:4\.6|5)/.test(model) ? XAI_MAP : XAI_LEGACY_MAP),
      }
    case 'gemini':
      // Native Gemini uses thinkingLevel/thinkingBudget; the OpenAI-compatible
      // endpoint's acceptance of reasoning_effort is unverified. Pass through so
      // behavior is unchanged, but mark it for diagnostics.
      return { ...base, ...mapLevel(level, PASS_THROUGH), reason: 'gateway-unverified' }
    case 'openrouter':
    case 'generic':
    default:
      return { ...base, ...mapLevel(level, PASS_THROUGH) }
  }
}

export function planEffortWire(input: {
  model: string
  requested: EffortLevel | undefined
  protocol?: EffortWireProtocol
  baseURL?: string
  /** Provider-level thinking toggle; only Qwen's budget mode consumes it. */
  thinkingEnabled?: boolean
  /** Output-token ceiling, used to cap Qwen thinking_budget. */
  maxOutputTokens?: number
}): EffortWirePlan {
  const protocol = resolveProtocol(input.protocol)
  const baseURL = resolveBaseURL(input.baseURL)
  const model = input.model.toLowerCase()
  const gateway = baseURL
    ? detectGateway(baseURL, model)
    : protocol === 'anthropic'
      ? 'anthropic'
      : 'openai'
  if (input.requested === undefined) {
    return { gateway, downgraded: false }
  }
  return planForGateway(
    gateway,
    protocol,
    model,
    input.requested,
    input.thinkingEnabled,
    input.maxOutputTokens,
  )
}

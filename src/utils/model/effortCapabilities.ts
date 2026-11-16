import { getModelEnvironment } from './runtimeModelContext.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl, type APIProvider } from './providers.js'
import { planEffortWire } from './effortGateway.js'
import { clearHostReasoningDisables, disableHostReasoningPolicy, getHostReasoningPolicy, hostReasoningLevels, hostReasoningThinking } from './reasoningPolicy.js'
import { getCanonicalName } from './model.js'
import { resolveAntModel } from './antModels.js'
import { isEnvTruthy } from '../envUtils.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

/**
 * Single source of truth for model thinking/effort capability.
 *
 * Model capability is independent of the wire protocol: protocol adapters decide
 * how an accepted level is expressed (output_config.effort / reasoning_effort /
 * reasoning.effort). Keeping the decision in one place stops CLI, App and SDK
 * from disagreeing about the same model.
 */
export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export type { EffortLevel }

/** Models that rejected an effort parameter at runtime (400). Kept session-wide
 * so we do not keep sending a parameter the endpoint refuses. */
const rejectedEffortModels = new Set<string>()

export function recordEffortRejection(model: string): void {
  rejectedEffortModels.add(model.trim().toLowerCase().replace(/\[.*?\]$/, ''))
  disableHostReasoningPolicy(model)
}

export function clearEffortRejections(): void {
  rejectedEffortModels.clear()
  clearHostReasoningDisables()
}

/** Levels that need no `max_effort` declaration. */
export const BASE_EFFORT_LEVELS = ['low', 'medium', 'high'] as const

export type CapabilityProtocol = 'anthropic' | 'openai' | 'responses'
export type ThinkingMode = 'adaptive' | 'budget' | 'none'
export type CapabilitySource =
  | 'disabled-env'
  | 'always-env'
  | 'catalog'
  | 'builtin'
  | 'default'

export interface EffortCapability {
  model: string
  provider: APIProvider
  protocol: CapabilityProtocol
  /** Non-official ANTHROPIC_BASE_URL — gateways such as GLM/DeepSeek/Kimi. */
  customEndpoint: boolean
  supportsEffort: boolean
  /** `max`/`xhigh` gate. Public models: Claude Opus 4.8 only. */
  supportsMax: boolean
  /** Accepted levels for the UI, already trimmed by the gates above. */
  levels: EffortLevel[]
  thinking: ThinkingMode
  source: CapabilitySource
}

function resolveProtocol(env: NodeJS.ProcessEnv): CapabilityProtocol {
  const raw = env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
  return raw === 'openai' || raw === 'responses' ? raw : 'anthropic'
}

function isFamilyModel(model: string): boolean {
  return (
    model.includes('haiku') ||
    model.includes('sonnet') ||
    model.includes('opus')
  )
}

/**
 * Models with the 2026 adaptive-thinking + effort surface (Anthropic docs:
 * Opus 4.6/4.7/4.8/5.x, Sonnet 4.6/5.x, Haiku 5.5, Fable 5.x, Mythos 5.x).
 * Older families (4.5 and earlier) still use enabled+budget_tokens.
 */
function isModernThinkingModel(canonical: string): boolean {
  return /(?:opus|sonnet)-(?:4-[678]|5(?:-\d)?)|haiku-5-5|fable-5(?:-\d)?|mythos-5(?:-\d)?/.test(
    canonical,
  )
}

/** Public first-party models whose effort parameter is documented as working.
 * Kept deliberately narrow (SKILL.md "Thinking & Effort" is the product
 * contract): max/xhigh stay Opus 4.8-only until a real endpoint check allows
 * broadening. Newer 4.6+/5.x families still get adaptive thinking below. */
function isOfficialEffortModel(name: string): boolean {
  return /claude-(?:opus-4-8|sonnet-5|opus-4-5)(?:$|-)/.test(name)
}

/** Non-reasoning OpenAI models reject reasoning_effort even on official API. */
function isNonReasoningOpenAIModel(name: string): boolean {
  return (
    /(^|[/])gpt-(?:3|4o|4\.1|4\.5)(?:$|[-.])/.test(name) ||
    /(^|[/])gpt-4(?:-turbo(?:-preview)?|-\d{4})?$/.test(name)
  )
}

/** Public first-party model allowed to receive `max`/`xhigh`. */
function isMaxEffortModel(name: string): boolean {
  return /claude-opus-4-8(?:$|-)/.test(name)
}

export function getEffortCapability(model: string): EffortCapability {
  const env = getModelEnvironment()
  const provider = getAPIProvider()
  const protocol = resolveProtocol(env)
  const customEndpoint = Boolean(
    env.ANTHROPIC_BASE_URL && !isFirstPartyAnthropicBaseUrl(),
  )
  const hostPolicy = getHostReasoningPolicy(model)
  if (hostPolicy) {
    const levels = isEnvTruthy(env.CLAUDE_CODE_DISABLE_EFFORT) ? [] : hostReasoningLevels(hostPolicy)
    return {
      model,
      provider,
      protocol,
      customEndpoint,
      supportsEffort: levels.length > 0 && hostPolicy.effort.mode !== 'none',
      supportsMax: levels.includes('max'),
      levels,
      thinking: hostReasoningThinking(hostPolicy),
      source: 'catalog',
    }
  }
  const rawName = model.toLowerCase().trim()
  // [1m]/[2m] are local context-window suffixes; @date is the Vertex ID form.
  // Neither reaches the API, so strip them before anchored family regexes.
  const name = rawName.replace(/\[(?:1|2)m\]$/i, '').replace(/@\d+$/, '')
  const rejectedAtRuntime = rejectedEffortModels.has(name)
  const canonical = getCanonicalName(name).toLowerCase()

  const disabled = isEnvTruthy(env.CLAUDE_CODE_DISABLE_EFFORT)
  const alwaysEnabled = isEnvTruthy(env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)

  let source: CapabilitySource = 'builtin'
  let supportsEffort: boolean
  if (disabled) {
    supportsEffort = false
    source = 'disabled-env'
  } else if (rejectedAtRuntime) {
    // The endpoint returned 400 for this parameter; stop advertising/sending
    // it for the rest of the session.
    supportsEffort = false
    source = 'default'
  } else if (alwaysEnabled) {
    supportsEffort = true
    source = 'always-env'
  } else if (isNonReasoningOpenAIModel(name)) {
    supportsEffort = false
    source = 'default'
  } else if (isOfficialEffortModel(name)) {
    supportsEffort = true
  } else if (isFamilyModel(name) || isModernThinkingModel(name)) {
    // Claude families not in the documented effort list must not receive the
    // parameter (Sonnet 4.5 / Haiku 4.5 etc. error on it) — including when a
    // custom endpoint merely proxies Anthropic model names.
    supportsEffort = false
  } else if (customEndpoint) {
    // Custom gateway models must declare effort in the catalog. Without a
    // catalog policy there is no safe wire mapping, so stay conservative.
    supportsEffort = false
    source = 'default'
  } else {
    supportsEffort = provider === 'firstParty'
    if (!supportsEffort) source = 'default'
  }

  let supportsMax = false
  if (!disabled && supportsEffort) {
    if (isMaxEffortModel(name)) supportsMax = true
    else if (env.USER_TYPE === 'ant' && resolveAntModel(model)) supportsMax = true
  }

  const thinkingBase =
    provider === 'foundry' || (provider === 'firstParty' && !customEndpoint)
      ? !canonical.includes('claude-3-')
      : /(?:sonnet|opus)-4/.test(name)
  // Adaptive thinking follows the model family, not the endpoint: newer Claude
  // models reject enabled+budget_tokens even through a custom proxy.
  const adaptiveBase = isModernThinkingModel(name)
    ? true
    : isFamilyModel(name)
      ? false
      : provider === 'foundry' || (provider === 'firstParty' && !customEndpoint)

  const thinkingEnabled = thinkingBase
  const adaptiveEnabled = adaptiveBase

  const thinking: ThinkingMode = adaptiveEnabled
    ? 'adaptive'
    : thinkingEnabled
      ? 'budget'
      : 'none'

  // Only advertise levels this gateway/model combination can actually send.
  // This keeps App/CLI menus honest: e.g. GLM's Anthropic endpoint and Kimi's
  // forced-thinking variants reject effort, so they show no strength options
  // even though the model family is otherwise effort-capable.
  const requestedLevels: EffortLevel[] = supportsEffort
    ? supportsMax
      ? [...EFFORT_LEVELS]
      : [...BASE_EFFORT_LEVELS]
    : []
  const levels = requestedLevels.filter(level => {
    const plan = planEffortWire({
      model,
      requested: level,
      protocol,
      thinkingEnabled: !isEnvTruthy(env.CLAUDE_CODE_DISABLE_THINKING),
    })
    return Boolean(plan.wireEffort || plan.extraBody)
  })
  const effectiveSupportsEffort = levels.length > 0
  const effectiveSupportsMax = supportsMax && levels.includes('max')

  return {
    model,
    provider,
    protocol,
    customEndpoint,
    supportsEffort: effectiveSupportsEffort,
    supportsMax: effectiveSupportsMax,
    levels,
    thinking,
    source,
  }
}

// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'
import { getScopedEffort, suppressEffort } from './effortContext.js'
import {
  EFFORT_LEVELS,
  getEffortCapability,
} from './model/effortCapabilities.js'
import { planEffortWire } from './model/effortGateway.js'
import { getHostReasoningPolicy } from './model/reasoningPolicy.js'
import { resolveAntModel } from './model/antModels.js'
import { getModelEnvironment } from './model/runtimeModelContext.js'
import { isEnvTruthy } from './envUtils.js'

export type { EffortLevel }
export { EFFORT_LEVELS }

export type EffortValue = EffortLevel | number

export function modelSupportsEffort(model: string): boolean {
  return getEffortCapability(model).supportsEffort
}

export function modelSupportsMaxEffort(model: string): boolean {
  return getEffortCapability(model).supportsMax
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped for external users (ants can persist it).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  if (value === 'max' && process.env.USER_TYPE === 'ant') {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort filters 'max' for non-ants on read, so a manually
  // edited settings.json doesn't leak session-scoped max into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = getModelEnvironment().CLAUDE_CODE_EFFORT_LEVEL
  const level = envOverride?.toLowerCase()
  return level === 'unset' || level === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Capability + gateway mapping for one explicitly requested value.
 * Returns undefined when nothing can be sent (model or gateway unsupported).
 */
function applyEffortForValue(
  model: string,
  value: EffortValue,
  thinkingEnabled?: boolean,
): { applied: EffortValue | undefined; reason?: string } {
  const capability = getEffortCapability(model)
  if (!capability.supportsEffort) {
    return { applied: undefined, reason: '该模型不支持 effort' }
  }
  if (typeof value === 'number') {
    return { applied: value }
  }
  const clamped =
    capability.source !== 'catalog' && (value === 'max' || value === 'xhigh') && !capability.supportsMax
      ? 'high'
      : value
  const plan = planEffortWire({ model, requested: clamped, thinkingEnabled })
  if (plan.gateway === 'catalog') return { applied: plan.applied, reason: plan.detail }
  if (!plan.wireEffort && !plan.extraBody) {
    return { applied: undefined, reason: plan.detail ?? '该端点不支持 effort' }
  }
  return { applied: plan.applied ?? clamped, reason: plan.detail }
}

/**
 * Outcome of asking for one effort value on a model, without env overrides.
 * Used for user-facing warnings ("requested max → sent high") and tests.
 */
export function describeEffortApplication(
  model: string,
  value: EffortValue | undefined,
): {
  supported: boolean
  requested: EffortValue | undefined
  applied: EffortValue | undefined
  downgraded: boolean
  reason?: string
} {
  const capability = getEffortCapability(model)
  if (!capability.supportsEffort) {
    return {
      supported: false,
      requested: value,
      applied: undefined,
      downgraded: false,
      reason: '该模型不支持 effort',
    }
  }
  if (value === undefined) {
    return { supported: true, requested: undefined, applied: undefined, downgraded: false }
  }
  const outcome = applyEffortForValue(model, value)
  return {
    supported: outcome.applied !== undefined,
    requested: value,
    applied: outcome.applied,
    downgraded: outcome.applied !== value,
    reason: outcome.reason,
  }
}

/** Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  if (suppressEffort()) return undefined
  const scoped = getScopedEffort()
  const envOverride = scoped ? undefined : getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved =
    (scoped ? scoped.value : envOverride ?? appStateEffortValue) ??
    (getHostReasoningPolicy(model) ? undefined : getDefaultEffortForModel(model))
  // max/xhigh are only valid for models whose capability matrix declares them;
  // otherwise fall back to high (the API's usual default).
  if (
    (resolved === 'max' || resolved === 'xhigh') &&
    !getHostReasoningPolicy(model) && !modelSupportsMaxEffort(model)
  ) {
    return 'high'
  }
  return resolved
}

/**
 * Full chain (env/appState/model default) + capability clamp + gateway mapping.
 * This is the value user-facing UI should report as "applied"; undefined means
 * no effort parameter will be sent.
 */
export function getAppliedEffortValue(
  model: string,
  appStateEffort: EffortValue | undefined,
  thinkingEnabled = !isEnvTruthy(getModelEnvironment().CLAUDE_CODE_DISABLE_THINKING),
): EffortValue | undefined {
  if (suppressEffort()) return undefined
  const resolved = resolveAppliedEffort(model, appStateEffort)
  if (resolved === undefined) {
    if (getHostReasoningPolicy(model)) {
      return planEffortWire({ model, requested: undefined, thinkingEnabled }).applied
    }
    return undefined
  }
  return applyEffortForValue(model, resolved, thinkingEnabled).applied
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const applied = getAppliedEffortValue(model, appStateEffort)
  // No effort parameter sent: show the API's usual default.
  return applied !== undefined ? convertEffortValueToLevel(applied) : 'high'
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Always delegates to resolveAppliedEffort() so the displayed level
 * matches what the API actually receives — including env-var-driven
 * effort (CLAUDE_CODE_EFFORT_LEVEL) even when AppState.effortValue
 * is undefined.
 *
 * When no explicit effort is configured anywhere (env, appState, model
 * default), the API defaults to 'high'. Show that default so the TUI
 * display is accurate — but only when the user hasn't explicitly set
 * the env var to 'unset' (which means "don't send effort at all").
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  const applied = getAppliedEffortValue(model, effortValue)
  if (applied !== undefined) {
    // Display the gateway-mapped level (what the API actually receives).
    return ` with ${convertEffortValueToLevel(applied)} effort`
  }
  // No config / gateway without effort control → nothing to advertise.
  return ''
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    if (value <= 150) return 'xhigh'
    return 'max'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'xhigh':
      return 'Higher-intensity reasoning between high and max'
    case 'max':
      return 'Maximum capability with deepest reasoning (model/gateway dependent)'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // Always default ants to undefined/high
    return undefined
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  // Default effort on Opus 4.8 to medium for Pro.
  // Max/Team also get medium when the tengu_grey_step2 config is enabled.
  if (model.toLowerCase().includes('opus-4-8')) {
    if (isProSubscriber()) {
      return 'medium'
    }
    if (
      getOpusDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'medium'
    }
  }

  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}

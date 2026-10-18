import type { EffortValue } from './effort.js'

/**
 * Session-scoped per-model effort memory.
 *
 * User expectation: choosing `max` on Opus should not leak into Sonnet/Haiku;
 * switching back restores the level chosen for that model. The map is keyed by
 * a normalized model name (case-insensitive, context-window suffix stripped)
 * and never persisted — effort stays a session preference.
 *
 * Value semantics: effort level = explicit choice, null = explicit "auto"
 * (must not fall back to the global settings default), missing entry = no
 * explicit choice for that model.
 */
export type EffortMemory = Record<string, EffortValue | null>

export function effortModelKey(
  model: string | null | undefined,
): string | undefined {
  const trimmed = model?.trim().toLowerCase()
  if (!trimmed) return undefined
  return trimmed.replace(/\[(?:1|2)m\]$/i, '')
}

/** Initial session map: seed the model that starts with an explicit level. */
export function seedEffortMemory(
  model: string | null | undefined,
  value: EffortValue | undefined,
): EffortMemory {
  return value === undefined ? {} : rememberEffortForModel({}, model, value)
}

/** Immutable upsert; `undefined` stores an explicit "auto" (null). */
export function rememberEffortForModel(
  memory: EffortMemory | undefined,
  model: string | null | undefined,
  value: EffortValue | undefined,
): EffortMemory {
  const next: EffortMemory = { ...(memory ?? {}) }
  const key = effortModelKey(model)
  if (!key) return next
  next[key] = value === undefined ? null : value
  return next
}

export function getRememberedEffort(
  memory: EffortMemory | undefined,
  model: string | null | undefined,
): EffortValue | null | undefined {
  const key = effortModelKey(model)
  return key ? memory?.[key] : undefined
}

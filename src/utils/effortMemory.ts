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

export function activeEffortConnectionId(): string | undefined {
  return process.env.DOGE_ACTIVE_CONNECTION_ID || process.env.DOGE_ACTIVE_MODEL_PROFILE
}

export function effortModelKey(
  model: string | null | undefined,
  connectionId?: string,
): string | undefined {
  const trimmed = model?.trim().toLowerCase()
  if (!trimmed) return undefined
  const key = trimmed.replace(/\[(?:1|2)m\]$/i, '')
  return connectionId ? JSON.stringify([connectionId, key]) : key
}

/** Initial session map: seed the model that starts with an explicit level. */
export function seedEffortMemory(
  model: string | null | undefined,
  value: EffortValue | undefined,
  connectionId?: string,
): EffortMemory {
  return value === undefined ? {} : rememberEffortForModel({}, model, value, connectionId)
}

/** Immutable upsert; `undefined` stores an explicit "auto" (null). */
export function rememberEffortForModel(
  memory: EffortMemory | undefined,
  model: string | null | undefined,
  value: EffortValue | undefined,
  connectionId?: string,
): EffortMemory {
  const next: EffortMemory = { ...(memory ?? {}) }
  const key = effortModelKey(model, connectionId)
  if (!key) return next
  next[key] = value === undefined ? null : value
  return next
}

export function getRememberedEffort(
  memory: EffortMemory | undefined,
  model: string | null | undefined,
  connectionId?: string,
): EffortValue | null | undefined {
  const key = effortModelKey(model, connectionId)
  return key ? memory?.[key] : undefined
}

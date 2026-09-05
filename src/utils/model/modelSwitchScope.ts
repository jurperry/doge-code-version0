/**
 * Session-scoped model switching (multi-terminal isolation).
 *
 * All cross-terminal pollution comes from disk writes at switch time
 * (.claude.json / settings.json / .credentials.json); `process.env` is
 * already per-process. In 'session' scope (the default) /model only
 * mutates env + AppState (`mainLoopModelForSession`) and never touches
 * disk, so concurrent doge terminals keep independent models. Each new
 * terminal starts from the global baseline; use `/model <name> --save`
 * to persist a choice globally, or set DOGE_MODEL_SCOPE=global to
 * restore the legacy persist-everywhere behavior.
 */
export type ModelSwitchScope = 'session' | 'global'

export const MODEL_SCOPE_ENV_VAR = 'DOGE_MODEL_SCOPE'

export function resolveModelSwitchScope(explicit?: ModelSwitchScope): ModelSwitchScope {
  if (explicit) return explicit
  return process.env[MODEL_SCOPE_ENV_VAR] === 'global' ? 'global' : 'session'
}

/** No-op stand-in for syncModelConfigToDisk in session scope. */
export function noopSyncToDisk(
  _model: string,
  _clearCredentials: boolean,
  _credentialSourceProfile?: unknown,
): void {}

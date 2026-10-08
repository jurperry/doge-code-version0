import { useEffect, useReducer } from 'react'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { useAppState } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  getRuntimeMainLoopModel,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'

export interface ResolveMainLoopModelInput {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  permissionMode: PermissionMode
  exceeds200kTokens: boolean
}

/**
 * Single resolution path for the main-loop model. The status bar and the
 * API client must both go through this function (or through identical
 * arguments to parseUserSpecifiedModel + getRuntimeMainLoopModel) so that
 * what the user sees equals what gets sent.
 *
 * NOTE: `customApiStorage.model` is intentionally NOT in the fallback chain.
 * It is a persistence layer with write latency; including it makes the
 * status bar lag behind AppState after a /model switch (root cause of the
 * earlier misalignment bug — see development_logs.md §25 模型切换统一入口).
 */
export function resolveMainLoopModel(input: ResolveMainLoopModelInput): ModelName {
  const raw =
    input.mainLoopModelForSession ??
    input.mainLoopModel ??
    getDefaultMainLoopModelSetting()
  const parsed = parseUserSpecifiedModel(raw)
  return getRuntimeMainLoopModel({
    permissionMode: input.permissionMode,
    mainLoopModel: parsed,
    exceeds200kTokens: input.exceeds200kTokens,
  })
}

/**
 * React hook variant. The caller SHOULD supply permissionMode +
 * exceeds200kTokens so the returned value matches what the API client will
 * actually send (e.g. plan-mode haiku→sonnet upgrade). Callers that only
 * need a display string and have no permissionMode/exceeds200kTokens context
 * may omit the options; they default to `'default'` / `false`, which
 * reproduces the previous (no-runtime-upgrade) display behavior.
 *
 * StatusLine passes explicit options; the other historical callers
 * (GenerateStep, effort, login, REPL, PromptInput, Notifications, LogoV2,
 * CondensedLogo) call with no args and keep their previous behavior.
 */
export function useMainLoopModel(opts?: {
  permissionMode?: PermissionMode
  exceeds200kTokens?: boolean
}): ModelName {
  const mainLoopModel = useAppState((s) => s.mainLoopModel)
  const mainLoopModelForSession = useAppState((s) => s.mainLoopModelForSession)

  // parseUserSpecifiedModel reads growth-book-backed model overrides via
  // _CACHED_MAY_BE_STALE (in resolveAntModel). Until GB init completes that's
  // the stale disk cache; after, it's the in-memory remoteEval map. AppState
  // does not change when GB init finishes, so we subscribe to the refresh
  // signal and force a re-render to re-resolve with fresh values. Without
  // this, alias resolution freezes until something else re-renders the
  // component — the API would sample one model while /model (which also
  // re-resolves) displays another.
  const [, forceRerender] = useReducer((x) => x + 1, 0)
  useEffect(() => onGrowthBookRefresh(forceRerender), [])

  return resolveMainLoopModel({
    mainLoopModel,
    mainLoopModelForSession,
    permissionMode: opts?.permissionMode ?? 'default',
    exceeds200kTokens: opts?.exceeds200kTokens ?? false,
  })
}

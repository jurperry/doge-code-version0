import type { ToolPermissionContext } from '../../Tool.js'
import { isBypassPermissionsModeDisabled } from './permissionSetup.js'

// doge fork: single source for "this session currently auto-releases tool
// permission checks" (the /auto command). Direct bypassPermissions mode, plus
// plan mode in a flag-launched session (isBypassPermissionsModeAvailable —
// upstream semantics for --dangerously-skip-permissions).
//
// Plan mode entered FROM bypassPermissions in a /auto session
// (prePlanMode='bypassPermissions' stashed by prepareContextForPlanMode) is
// deliberately NOT bypass-active anymore: that combination is the Auto
// zero-ask plan interlude (see isZeroAskPlanInterlude), where writes are
// denied so the model actually plans instead of executing.
//
// This must stay weaker than the pipeline's earlier gates: deny rules (1a)
// are evaluated BEFORE the mode bypass in hasPermissionsToUseToolInner.
export function isAutoBypassActive(
  toolPermissionContext: Pick<
    ToolPermissionContext,
    'mode' | 'prePlanMode' | 'isBypassPermissionsModeAvailable'
  >,
): boolean {
  const { mode, isBypassPermissionsModeAvailable } = toolPermissionContext
  if (mode === 'bypassPermissions') {
    return true
  }
  return mode === 'plan' && isBypassPermissionsModeAvailable === true
}

/**
 * doge fork: "Auto zero-ask" — a bypassPermissions session never asks the
 * user anything. While active, hasPermissionsToUseToolInner releases every
 * prompt-shaped decision (tool ask rules 1b, requiresUserInteraction tools
 * 1e, content ask rules 1f, safety checks 1g) to the 2a bypass allow;
 * explicit deny rules (1a/1d) still win. The killswitch
 * (settings/GrowthBook) turns the whole behavior off.
 */
export function isZeroAskAutoActive(
  toolPermissionContext: Pick<ToolPermissionContext, 'mode'>,
): boolean {
  return (
    toolPermissionContext.mode === 'bypassPermissions' &&
    !isBypassPermissionsModeDisabled()
  )
}

/**
 * doge fork: the Auto plan interlude — plan mode entered FROM
 * bypassPermissions (model called EnterPlanMode inside an Auto session).
 * While active, hasPermissionsToUseToolInner turns prompt-shaped decisions
 * into a deny telling the model to finish the plan, and auto-approves
 * ExitPlanMode so the session returns to Auto without asking.
 *
 * Flag-launched --dangerously-skip-permissions sessions are excluded
 * (isBypassPermissionsModeAvailable): upstream keeps full bypass inside
 * plan mode for them via isAutoBypassActive above.
 */
export function isZeroAskPlanInterlude(
  toolPermissionContext: Pick<
    ToolPermissionContext,
    'mode' | 'prePlanMode' | 'isBypassPermissionsModeAvailable'
  >,
): boolean {
  return (
    toolPermissionContext.mode === 'plan' &&
    toolPermissionContext.prePlanMode === 'bypassPermissions' &&
    toolPermissionContext.isBypassPermissionsModeAvailable !== true &&
    !isBypassPermissionsModeDisabled()
  )
}

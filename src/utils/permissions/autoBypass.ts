import type { ToolPermissionContext } from '../../Tool.js'

// doge fork: single source for "this session currently auto-releases tool
// permission checks" (the /auto command). Direct bypassPermissions mode, plus
// plan mode that was entered FROM bypassPermissions — the model's
// EnterPlanModeTool in an /auto session stashes prePlanMode='bypassPermissions'
// (permissionSetup.ts prepareContextForPlanMode). Previously only
// flag-launched sessions (isBypassPermissionsModeAvailable) kept bypass while
// in plan mode; /auto sessions regressed to per-tool prompts the moment the
// model switched to plan.
//
// This must stay weaker than the pipeline's earlier gates: deny rules (1a),
// tool-level ask rules (1b/1f), safety checks (1g) and — crucially —
// requiresUserInteraction tools like the ExitPlanMode approval dialog (1e)
// are all evaluated BEFORE the mode bypass in hasPermissionsToUseToolInner,
// so plan approval still reaches the user in auto mode.
export function isAutoBypassActive(
  toolPermissionContext: Pick<
    ToolPermissionContext,
    'mode' | 'prePlanMode' | 'isBypassPermissionsModeAvailable'
  >,
): boolean {
  const { mode, prePlanMode, isBypassPermissionsModeAvailable } =
    toolPermissionContext
  if (mode === 'bypassPermissions') {
    return true
  }
  return (
    mode === 'plan' &&
    (prePlanMode === 'bypassPermissions' ||
      isBypassPermissionsModeAvailable === true)
  )
}

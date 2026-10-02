import type { PermissionMode } from '../../types/permissions.js'

// doge fork: live mirror of AppState.toolPermissionContext.mode for
// consumers that cannot read the React store (constants/prompts.ts system
// prompt sections). Initialized by initializeToolPermissionContext and kept
// in sync by onChangeAppState — the single choke point every mode mutation
// path (Shift+Tab, /auto, /plan, ExitPlanMode, SDK set_permission_mode,
// bridge) flows through.
let currentPermissionMode: PermissionMode = 'default'
let currentAutoPlan = false

export function getCurrentPermissionMode(): PermissionMode {
  return currentPermissionMode
}

export function isCurrentAutoPlan(): boolean {
  return currentPermissionMode === 'plan' && currentAutoPlan
}

export function setCurrentPermissionMode(mode: PermissionMode, autoPlan = false): void {
  currentPermissionMode = mode
  currentAutoPlan = autoPlan
}

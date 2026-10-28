import type { PermissionMode } from '../../types/permissions.js'

// doge fork: live mirror of AppState.toolPermissionContext.mode for
// consumers that cannot read the React store (constants/prompts.ts system
// prompt sections). Initialized by initializeToolPermissionContext and kept
// in sync by onChangeAppState — the single choke point every mode mutation
// path (Shift+Tab, /auto, /plan, ExitPlanMode, SDK set_permission_mode,
// bridge) flows through.
let currentPermissionMode: PermissionMode = 'default'
let currentAutoPlan = false
const permissionModeListeners = new Set<() => void>()

/** Multiple pending interaction channels must observe the same mode transition. */
export function subscribeToPermissionModeChanges(listener: () => void): () => void {
  permissionModeListeners.add(listener)
  return () => { permissionModeListeners.delete(listener) }
}

export function getCurrentPermissionMode(): PermissionMode {
  return currentPermissionMode
}

export function isCurrentAutoPlan(): boolean {
  return currentPermissionMode === 'plan' && currentAutoPlan
}

export function setCurrentPermissionMode(mode: PermissionMode, autoPlan = false): void {
  const changed = currentPermissionMode !== mode || currentAutoPlan !== autoPlan
  currentPermissionMode = mode
  currentAutoPlan = autoPlan
  if (changed) for (const listener of permissionModeListeners) listener()
}

import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from '../../utils/permissions/permissionSetup.js'
import { getLeaderSetToolPermissionContext } from '../../utils/swarm/leaderPermissionBridge.js'

// doge fork: /auto switches into bypassPermissions at runtime — no
// --dangerously-skip-permissions launch flag needed. It deliberately does NOT
// require toolPermissionContext.isBypassPermissionsModeAvailable and does NOT
// set bootstrap's sessionBypassPermissionsMode: both stay tied to
// flag-launched sessions so their side effects (plan mode bypassing all
// checks in permissions.ts, bypass inheritance for spawned teammates) don't
// leak into /auto sessions. Mode is session-scoped, never persisted.
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const { getAppState, setAppState } = context
  const arg = args.trim().toLowerCase()
  if (arg !== '' && arg !== 'on' && arg !== 'off') {
    onDone(`Unknown argument "${arg}". Usage: /auto [on|off]`)
    return null
  }

  const toolPermissionContext = getAppState().toolPermissionContext
  const currentMode = toolPermissionContext.mode
  const targetMode: PermissionMode = arg === 'off' ? 'default' : 'bypassPermissions'

  if (currentMode === targetMode) {
    onDone(
      targetMode === 'bypassPermissions'
        ? 'Auto mode is already on — all tools run without confirmation. Use /auto off to exit.'
        : 'Auto mode is already off (default permission mode).',
    )
    return null
  }

  if (targetMode === 'bypassPermissions' && isBypassPermissionsModeDisabled()) {
    onDone(
      'Cannot enable auto mode: bypassPermissions is disabled by settings (permissions.disableBypassPermissionsMode).',
    )
    return null
  }

  const nextContext = {
    ...transitionPermissionMode(currentMode, targetMode, toolPermissionContext),
    mode: targetMode,
  }
  setAppState(prev => ({ ...prev, toolPermissionContext: nextContext }))
  // Also route through the REPL's registered setter so permission prompts
  // already queued in the UI are rechecked under the new mode.
  getLeaderSetToolPermissionContext()?.(nextContext)

  onDone(
    targetMode === 'bypassPermissions'
      ? 'Auto mode enabled — tools will run without asking for confirmation. Shift+Tab cycles auto → accept edits → plan; /auto off returns to default.'
      : 'Auto mode disabled — back to default permission mode.',
  )
  return null
}

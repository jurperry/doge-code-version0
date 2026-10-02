import { getInitialSettings } from '../settings/settings.js'
import { getSessionShell } from './sessionShell.js'

/**
 * Resolve the default shell — drives the model's shell tool (Bash vs
 * PowerShell, see shellToolUtils.resolveActiveShellTool), input-box `!`
 * routing, and the no-git-bash startup gate.
 *
 * Resolution order:
 *   session override (sessionShell.ts — snapshotted at process start,
 *   rewritten by /shell) → settings.defaultShell → 'bash'
 *
 * The session snapshot isolates running sessions: a disk settings.json
 * change (settings cache invalidation via changeDetector) does NOT retarget
 * this session's active shell — only new processes snapshot the new value.
 *
 * Platform default is 'bash' everywhere — we do NOT auto-flip Windows to
 * PowerShell (would break existing Windows users with bash hooks).
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  return getSessionShell() ?? getInitialSettings().defaultShell ?? 'bash'
}

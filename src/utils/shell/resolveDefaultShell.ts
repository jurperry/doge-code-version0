import { getInitialSettings } from '../settings/settings.js'

/**
 * Resolve the default shell — drives the model's shell tool (Bash vs
 * PowerShell, see shellToolUtils.resolveActiveShellTool), input-box `!`
 * routing, and the no-git-bash startup gate.
 *
 * Resolution order:
 *   settings.defaultShell → 'bash'
 *
 * Platform default is 'bash' everywhere — we do NOT auto-flip Windows to
 * PowerShell (would break existing Windows users with bash hooks).
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  return getInitialSettings().defaultShell ?? 'bash'
}

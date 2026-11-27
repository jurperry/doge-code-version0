import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform, type Platform } from '../platform.js'
import { resolveDefaultShell } from './resolveDefaultShell.js'
import type { ShellType } from './shellProvider.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

export type ShellToolGateInput = {
  platform: Platform
  userType: string | undefined
  /** Raw value of CLAUDE_CODE_USE_POWERSHELL_TOOL. */
  psToolEnv: string | undefined
  defaultShell: ShellType
}

/**
 * Pure core of isPowerShellToolEnabled — every input explicit so the
 * platform × settings × env matrix is unit-testable.
 *
 * Gate order:
 *   1. Windows-only (the permission engine uses Win32-specific path
 *      normalizations).
 *   2. settings.defaultShell === 'powershell' opts in unconditionally —
 *      an explicit user choice beats the env killswitch, and a missing
 *      pwsh/powershell is surfaced gracefully by PowerShellTool's
 *      pre-flight sentinel instead of hiding the tool.
 *   3. Env gate: ant defaults on (opt-out via env=0); external defaults
 *      off (opt-in via env=1).
 */
export function isPowerShellToolEnabledFor(input: ShellToolGateInput): boolean {
  if (input.platform !== 'windows') return false
  if (input.defaultShell === 'powershell') return true
  return input.userType === 'ant'
    ? !isEnvDefinedFalsy(input.psToolEnv)
    : isEnvTruthy(input.psToolEnv)
}

/**
 * Runtime gate for PowerShellTool. Windows-only (the permission engine uses
 * Win32-specific path normalizations). Enabled when the user selected
 * defaultShell: 'powershell', or via the env gate (ant defaults on, opt-out
 * via env=0; external defaults off, opt-in via env=1).
 *
 * Used by tools.ts (tool-list visibility) and promptShellExecution (skill
 * frontmatter routing). `!` input routing (processBashCommand) and the
 * system-prompt shell line (prompts.ts) go through resolveActiveShellTool()
 * below instead — the gate alone does not make pwsh the active shell.
 */
export function isPowerShellToolEnabled(): boolean {
  return isPowerShellToolEnabledFor({
    platform: getPlatform(),
    userType: process.env.USER_TYPE,
    psToolEnv: process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL,
    defaultShell: resolveDefaultShell(),
  })
}

/**
 * Which shell tool the model gets — the single exclusive resolution shared by
 * tools.ts (tool pool), prompts.ts (system-prompt shell line) and
 * processBashCommand (! routing). PowerShell only when the gate is open
 * AND the user selected it; env=1 alone makes the tool available but does
 * not make it active. Anything else falls back to bash.
 */
export function resolveActiveShellToolFor(input: ShellToolGateInput): ShellType {
  return isPowerShellToolEnabledFor(input) && input.defaultShell === 'powershell'
    ? 'powershell'
    : 'bash'
}

export function resolveActiveShellTool(): ShellType {
  return resolveActiveShellToolFor({
    platform: getPlatform(),
    userType: process.env.USER_TYPE,
    psToolEnv: process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL,
    defaultShell: resolveDefaultShell(),
  })
}

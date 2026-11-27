import type { ShellType } from '../../utils/shell/shellProvider.js'

export type ShellCommandArgs =
  | { kind: 'select' }
  | { kind: 'status' }
  | { kind: 'set'; shell: ShellType }
  | { kind: 'help' }
  | { kind: 'invalid'; arg: string }

const HELP_ARGS = ['help', '-h', '--help']

/**
 * /shell argument parsing. '' opens the interactive selector; 'bash' and
 * 'pwsh' (alias: 'powershell') select directly; 'status' prints the current
 * selection and both interpreters' availability.
 */
export function parseShellArgs(args: string): ShellCommandArgs {
  const normalized = args.trim().toLowerCase()
  if (!normalized) return { kind: 'select' }
  if (HELP_ARGS.includes(normalized)) return { kind: 'help' }
  if (normalized === 'status') return { kind: 'status' }
  if (normalized === 'bash') return { kind: 'set', shell: 'bash' }
  if (normalized === 'pwsh' || normalized === 'powershell') {
    return { kind: 'set', shell: 'powershell' }
  }
  return { kind: 'invalid', arg: args.trim() }
}

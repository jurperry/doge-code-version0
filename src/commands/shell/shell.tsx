import * as React from 'react'
import { Select } from '../../components/CustomSelect/index.js'
import { Pane } from '../../components/design-system/Pane.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getPlatform } from '../../utils/platform.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import {
  getCachedPowerShellPath,
  getPowerShellEdition,
} from '../../utils/shell/powershellDetection.js'
import { resolveDefaultShell } from '../../utils/shell/resolveDefaultShell.js'
import type { ShellType } from '../../utils/shell/shellProvider.js'
import { probeGitBashPath } from '../../utils/windowsPaths.js'
import { parseShellArgs } from './args.js'

const USAGE = `Usage: /shell [bash|pwsh|status]

Select the command interpreter:
- bash    Git Bash (Unix shell syntax)
- pwsh    PowerShell (native Windows syntax; alias: powershell)
- status  Show the current shell and availability

Saved to user settings (defaultShell); takes effect on the next turn.`

type ShellAvailability = {
  available: boolean
  detail: string
}

type ShellAvailabilityInfo = {
  bash: ShellAvailability
  pwsh: ShellAvailability
}

async function detectShellAvailability(): Promise<ShellAvailabilityInfo> {
  if (getPlatform() !== 'windows') {
    return {
      bash: { available: true, detail: 'Available (system bash)' },
      // PowerShellTool's permission engine is Windows-only, so the selector
      // cannot offer pwsh elsewhere even though pwsh runs on macOS/Linux.
      pwsh: { available: false, detail: 'Windows only' },
    }
  }
  const gitBashPath = probeGitBashPath()
  const psPath = await getCachedPowerShellPath()
  const edition = psPath ? await getPowerShellEdition() : null
  const psName = psPath?.split(/[/\\]/).pop() ?? 'powershell'
  return {
    bash: gitBashPath
      ? { available: true, detail: `Detected: ${gitBashPath}` }
      : {
          available: false,
          detail:
            'Git Bash not detected — install Git for Windows and restart, or set CLAUDE_CODE_GIT_BASH_PATH',
        },
    pwsh: psPath
      ? {
          available: true,
          detail: `Detected: ${psName} (${edition === 'core' ? 'PowerShell 7+' : 'Windows PowerShell 5.1'})`,
        }
      : { available: false, detail: 'PowerShell (pwsh/powershell) not detected' },
  }
}

function shellDisplayName(shell: ShellType): string {
  return shell === 'powershell' ? 'Pwsh' : 'Bash'
}

function applyShellSelection(
  shell: ShellType,
  availability: ShellAvailabilityInfo,
): string {
  // Pwsh is Windows-only (PowerShellTool's permission engine uses Win32
  // path normalizations) — refuse outright rather than persisting a
  // selection that can never activate.
  if (shell === 'powershell' && getPlatform() !== 'windows') {
    return 'Pwsh is only available on Windows — kept the current shell unchanged.'
  }
  const result = updateSettingsForSource('userSettings', { defaultShell: shell })
  if (result.error) {
    return `Failed to set shell: ${result.error.message}`
  }
  // The env-info system prompt section (which carries the Shell: line) is
  // cached per session and only cleared on /clear, /compact, and worktree
  // enter/exit — without this the model keeps the old shell's syntax
  // guidance until one of those happens.
  clearSystemPromptSections()
  const lines = [
    `Switched to ${shellDisplayName(shell)} — takes effect on the next turn.`,
  ]
  // A higher-priority source (project/local/--settings) can override the
  // user setting we just wrote — surface that instead of lying about the
  // effective shell.
  const effective = resolveDefaultShell()
  if (effective !== shell) {
    lines.push(
      `Note: a higher-priority settings source overrides this — the effective shell is ${shellDisplayName(effective)}.`,
    )
  }
  if (shell === 'powershell' && !availability.pwsh.available) {
    lines.push(
      'Warning: no PowerShell executable was detected — commands will fail until pwsh or powershell is installed.',
    )
  }
  if (shell === 'bash' && !availability.bash.available) {
    lines.push(
      'Warning: Git Bash not detected — with Bash selected, startup will fail until Git for Windows is installed or CLAUDE_CODE_GIT_BASH_PATH is set.',
    )
  }
  return lines.join('\n')
}

function statusMessage(availability: ShellAvailabilityInfo): string {
  return [
    `Current shell: ${shellDisplayName(resolveDefaultShell())}`,
    '',
    `Bash: ${availability.bash.detail}`,
    `Pwsh: ${availability.pwsh.detail}`,
  ].join('\n')
}

function ShellSelect({
  availability,
  onDone,
}: {
  availability: ShellAvailabilityInfo
  onDone: (result?: string, options?: { display?: 'system' }) => void
}): React.ReactNode {
  const isWindows = getPlatform() === 'windows'
  return (
    <Pane color="permission">
      <Text bold>Select command interpreter</Text>
      <Select
        options={[
          {
            label: 'Bash',
            value: 'bash' as ShellType,
            description: availability.bash.detail,
          },
          {
            label: 'Pwsh',
            value: 'powershell' as ShellType,
            description: availability.pwsh.detail,
            disabled: !isWindows,
          },
        ]}
        defaultValue={resolveDefaultShell()}
        onChange={value => onDone(applyShellSelection(value, availability))}
        onCancel={() =>
          onDone('Shell selection dismissed', { display: 'system' })
        }
      />
    </Pane>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseShellArgs(args ?? '')
  switch (parsed.kind) {
    case 'help':
      onDone(USAGE)
      return
    case 'invalid':
      onDone(`Invalid argument: ${parsed.arg}\n\n${USAGE}`)
      return
    case 'status':
      onDone(statusMessage(await detectShellAvailability()))
      return
    case 'set':
      onDone(applyShellSelection(parsed.shell, await detectShellAvailability()))
      return
    case 'select':
      return (
        <ShellSelect
          availability={await detectShellAvailability()}
          onDone={onDone}
        />
      )
  }
}

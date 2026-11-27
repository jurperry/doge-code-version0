import { buildComputerUseTools } from '@ant/computer-use-mcp'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { buildMcpToolName } from '../../services/mcp/mcpStringUtils.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'

import { isInBundledMode } from '../bundledMode.js'
import { CLI_CU_CAPABILITIES, COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { getChicagoCoordinateMode } from './gates.js'

const MACOS_COMPUTER_USE_PROMPT = `<computer-use-availability>
Use mcp__computer-use__* in the main session for authorized desktop interaction. Use
Playwright MCP first for browser automation. Request access for the intended app,
open the granted app, and take a screenshot before coordinate input. Verify each
visible effect before continuing. Respect authorization and capability failures.
Use the latest base screenshot for coordinates, including after using zoom for detail.
When a tool or batch fails, inspect the current state and completed actions before
attempting any remaining step. If the user stops Computer Use, end desktop actions
for this turn.
</computer-use-availability>`

const LINUX_COMPUTER_USE_PROMPT = `<computer-use-availability>
Computer Use on X11 captures and controls the currently focused authorized window.
Ask for access to a window that is already open using request_access. Use open_application
to focus the granted window by its approved name or ID, then call screenshot. Coordinates
are pixels inside that window's image. Take a fresh screenshot after a focus, position or
size change. Check the effect with another screenshot after each action.
If the target is covered or loses focus, stop, focus the approved window again, and take
a fresh screenshot. Do not send input on stale coordinates or retry partial actions blindly.
Use Playwright MCP first for browser automation.
</computer-use-availability>`

export function nonWindowsComputerUsePrompt(isLinux: boolean): string {
  return isLinux ? LINUX_COMPUTER_USE_PROMPT : MACOS_COMPUTER_USE_PROMPT
}

/**
 * Build the dynamic MCP config + allowed tool names. Mirror of
 * `setupClaudeInChrome`. The `mcp__computer-use__*` tools are added to
 * `allowedTools` so they bypass the normal permission prompt — the package's
 * `request_access` handles approval for the whole session.
 *
 * The MCP layer isn't ceremony: the API backend detects `mcp__computer-use__*`
 * tool names and emits a CU availability hint into the system prompt
 * (COMPUTER_USE_MCP_AVAILABILITY_HINT in the anthropic repo). Built-in tools
 * with different names wouldn't trigger it. Cowork uses the same names for the
 * same reason (apps/desktop/src/main/local-agent-mode/systemPrompt.ts:314).
 */
export function setupComputerUseMCP(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
} {
  const allowedTools = buildComputerUseTools(
    CLI_CU_CAPABILITIES,
    getChicagoCoordinateMode(),
  ).map(t => buildMcpToolName(COMPUTER_USE_MCP_SERVER_NAME, t.name))

  // command/args are never spawned — client.ts intercepts by name and
  // uses the in-process server. The config just needs to exist with
  // type 'stdio' to hit the right branch. Mirrors Chrome's setup.
  const args = isInBundledMode()
    ? ['--computer-use-mcp']
    : [
        join(fileURLToPath(import.meta.url), '..', 'cli.js'),
        '--computer-use-mcp',
      ]

  return {
    mcpConfig: {
      [COMPUTER_USE_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args,
        scope: 'dynamic',
      } as const,
    },
    allowedTools,
  }
}

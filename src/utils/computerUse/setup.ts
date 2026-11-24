import { buildComputerUseTools } from '@ant/computer-use-mcp'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { buildMcpToolName } from '../../services/mcp/mcpStringUtils.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'

import { isInBundledMode } from '../bundledMode.js'
import { CLI_CU_CAPABILITIES, COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { getChicagoCoordinateMode } from './gates.js'

/**
 * Local stand-in for the CU availability hint the official Anthropic backend
 * injects server-side when it detects `mcp__computer-use__*` tool names.
 * Doge sessions usually run through custom/translated endpoints (openai /
 * responses bridges) where that server-side behavior doesn't exist — without
 * a local hint, the model may never discover or correctly drive the CU
 * tools. Appended to the system prompt whenever the CU MCP server is set up.
 */
export const COMPUTER_USE_MCP_PROMPT_HINT = `<computer-use-availability>
The mcp__computer-use__* tools give you direct control of the user's screen: taking screenshots, moving and clicking the mouse, typing, pressing keys, scrolling, dragging, and managing the clipboard and applications.

Use built-in Playwright MCP first for browser automation requests such as 浏览器自动化, 浏览器操作, Browser Use or Playwright. Use Computer Use for explicit desktop interaction, including when the user specifically asks to control an existing browser window through the desktop.

How to work with them:
1. Call request_access first — it asks the user which application you may control this session.
2. On Windows, use the granted bundleId with open_application. It binds the target and returns its first screenshot by default. Use settle_ms when the app needs time to render the first screen.
3. Act with the precise tools (left_click, type, key, scroll, left_click_drag, ...) using pixel coordinates taken from the screenshot image you received; the origin is the top-left corner of that image.
4. Verify the effect in the tool's returned image or window status. Take a separate screenshot when the action has no usable visual result.

Choose the coordinate space before acting:
- open_application selects a bound window; screenshots and coordinates are window-local.
- switch_display("auto") selects full-screen capture and global input, even if an application was previously opened. Use it whenever the user asks for desktop-wide control rather than a specific bound window.
- Changing the target invalidates previous image coordinates. Always take a fresh screenshot before further input.

Guidance:
- Use zoom to magnify a region when text is small or you need exact coordinates; it returns the cropped region at full resolution.
- Use computer_batch to replay several already-verified steps in a single call.
- On Windows, for a named desktop launcher, pass the user's absolute .lnk path or a literal Desktop-relative reference such as Desktop\\game\\Launcher to request_access. Use the returned executable bundleId in open_application. Use switch_display and the Explorer UI when you need to discover a filename visually.
- On Windows, call minimize_window({}) to minimize the bound window and confirm success. For an explicit request to minimize everything, ask for systemKeyCombos during request_access, then call minimize_window with all: true before opening the next app.
- On Windows, use left_click with screenshot: true for visual navigation. For games or custom controls that require physical input, use input: foreground on the focused bound window, with settle_ms for a slow visual transition. For known multi-action sequences, end computer_batch with screenshot.
- If the target reports foreground=false and the user wants to continue in it, call activate_window with the reported hwnd and screenshot: true. Use the returned image for the next action.
- Do not guess coordinates: re-screenshot or zoom instead. If a click misses, zoom into the target and correct the coordinates before retrying.
- A dispatched input event is not proof that the application changed state. Always verify the resulting UI before continuing.
- Read tool errors before retrying. A batch, type action, or timeout may be partially completed or have an unknown outcome; inspect the current screen instead of blindly replaying side effects.
- On an error, stop the current action sequence and read the exact failure before issuing more input. For a closed or replaced target, use open_application to bind the authorized app. After a capture failure, never click using stale coordinates. If the click was already dispatched, inspect the result before considering another click.
- computer_batch stops at the first failure. Use completed, failed or aborted, remaining, and recovery to understand the boundary; inspect the screen and perform only missing actions instead of replaying the batch.
- On Windows, never automate the secure UAC prompt. The user handles it directly; after any prompt clears, call screenshot as a standalone tool before resuming input. When an authorized target has a higher integrity level, Computer Use may ask once for a persistent administrator helper so later capture, click, drag, type, key and batch actions can run normally. If helper setup fails, report the error instead of switching to another injection method.
- If a newly started application takes the foreground, treat it as a target change: inspect the fresh screenshot, then open_application or request_access for that actual application before more input. Never use shell scripts to bypass Computer Use target or permission gates, and never mix coordinates from custom captures with Computer Use screenshots.
- If the user declines request_access, do not show the same dialog again. Choose a non-Computer-Use approach or ask the user to perform the action.
</computer-use-availability>`

export const LINUX_COMPUTER_USE_MCP_PROMPT_HINT = `<computer-use-availability>
Computer Use on X11 captures and controls the currently focused authorized window.
Ask for access to a window that is already open using request_access. Use open_application
to focus the granted window by its approved name or ID, then call screenshot. Coordinates
are pixels inside that window's image. Take a fresh screenshot after a focus, position or
size change. Check the effect with another screenshot after each action.
If the target is covered or loses focus, stop, focus the approved window again, and take
a fresh screenshot. Do not send input on stale coordinates or retry partial actions blindly.
Use Playwright MCP first for browser automation.
</computer-use-availability>`

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

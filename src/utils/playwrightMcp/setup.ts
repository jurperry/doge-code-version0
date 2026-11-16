import { existsSync } from 'fs'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'

import { logForDebugging } from '../debug.js'
import {
  DESKTOP_PLAYWRIGHT_BROWSERS,
  desktopBrowserPreference,
  PLAYWRIGHT_HEADED_MCP_SERVER_NAME,
  PLAYWRIGHT_MCP_PROMPT_HINT,
  PLAYWRIGHT_MCP_SERVER_NAME,
  type DesktopBrowser,
} from './common.js'
import { buildPlaywrightMcpCommand, type PlaywrightMcpCommand } from './command.js'

export { PLAYWRIGHT_MCP_PROMPT_HINT } from './common.js'

export function playwrightMcpPromptHint(): string {
  const preference = desktopBrowserPreference()
  return preference && preference !== 'auto'
    ? `${PLAYWRIGHT_MCP_PROMPT_HINT}\nThe user has set ${DESKTOP_PLAYWRIGHT_BROWSERS[preference].label} as their desktop browser preference. Use it for ordinary browser tasks unless the user explicitly names another browser or requests both.`
    : PLAYWRIGHT_MCP_PROMPT_HINT
}

/**
 * Server-level allow rule: `mcp__playwright__*`.
 *
 * Built by hand rather than through buildMcpToolName() — that helper runs the
 * tool name through normalizeNameForMCP(), which rewrites the wildcard `*` to
 * `_` and produces a rule that matches nothing.
 */
function serverWideAllowRule(serverName: string): string {
  return `mcp__${serverName}__*`
}

/** Set DOGE_PLAYWRIGHT_MCP=0 to opt out entirely. */
export function isPlaywrightMCPEnabled(): boolean {
  if (desktopBrowserPreference() && process.env.DOGE_APP_PLAYWRIGHT_DISABLED === '1') return false
  const raw = process.env.DOGE_PLAYWRIGHT_MCP?.trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

/**
 * Build the dynamic MCP config + allowed tool names for the built-in
 * Playwright servers. Mirrors `setupComputerUseMCP`.
 *
 * Unlike Computer Use, this one is a REAL stdio server: Playwright cannot
 * launch a browser from Bun (see command.ts for the matrix), so the CLI spawns
 * `@playwright/mcp`'s CLI as a Node child process. The browser itself is still
 * launched lazily, on the first tool call.
 *
 * Each server uses a server-level wildcard rule instead of enumerating tool
 * names: the upstream toolset changes between releases, and a stale hardcoded
 * list would silently leave new tools behind the permission prompt.
 * `permissions.ts` matches `mcp__<server>__*` as "all tools from server".
 */
export function setupPlaywrightMCP(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
} {
  if (!isPlaywrightMCPEnabled()) {
    return { mcpConfig: {}, allowedTools: [] }
  }

  const mcpConfig: Record<string, ScopedMcpServerConfig> = {}
  const register = (name: string, command: PlaywrightMcpCommand | undefined): void => {
    if (command) {
      mcpConfig[name] = { type: 'stdio', command: command.command, args: command.args, scope: 'dynamic' }
    }
  }
  if (desktopBrowserPreference()) {
    for (const browser of Object.keys(DESKTOP_PLAYWRIGHT_BROWSERS) as DesktopBrowser[]) {
      const spec = DESKTOP_PLAYWRIGHT_BROWSERS[browser]
      const executablePath = process.env[spec.pathEnv]
      if (!executablePath || !existsSync(executablePath)) continue
      const desktop = { browser, executablePath }
      register(spec.headless, buildPlaywrightMcpCommand({ desktop, headless: true }))
      register(spec.visible, buildPlaywrightMcpCommand({ desktop, headless: false }))
    }
  } else {
    register(PLAYWRIGHT_MCP_SERVER_NAME, buildPlaywrightMcpCommand())
    register(PLAYWRIGHT_HEADED_MCP_SERVER_NAME, buildPlaywrightMcpCommand({ headless: false }))
  }
  const names = Object.keys(mcpConfig)
  logForDebugging(`[Playwright MCP] stdio servers: ${names.join(', ') || 'none available'}`)

  return {
    mcpConfig,
    allowedTools: names.map(serverWideAllowRule),
  }
}

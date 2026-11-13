import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'

import { logForDebugging } from '../debug.js'
import { PLAYWRIGHT_HEADED_MCP_SERVER_NAME, PLAYWRIGHT_MCP_SERVER_NAME } from './common.js'
import { buildPlaywrightMcpCommand } from './command.js'

export { PLAYWRIGHT_MCP_PROMPT_HINT } from './common.js'

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

  const headless = buildPlaywrightMcpCommand()
  const headed = buildPlaywrightMcpCommand({ headless: false })
  if (!headless || !headed) {
    // No Node on this machine — better to register nothing than a server that
    // fails to start and shows up as a red entry in /mcp.
    logForDebugging(
      '[Playwright MCP] no Node executable found; server not registered',
    )
    return { mcpConfig: {}, allowedTools: [] }
  }

  logForDebugging(
    `[Playwright MCP] stdio servers: ${headless.command} (headless + visible)`,
  )

  return {
    mcpConfig: {
      [PLAYWRIGHT_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: headless.command,
        args: headless.args,
        scope: 'dynamic',
      } as const,
      [PLAYWRIGHT_HEADED_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: headed.command,
        args: headed.args,
        scope: 'dynamic',
      } as const,
    },
    allowedTools: [
      serverWideAllowRule(PLAYWRIGHT_MCP_SERVER_NAME),
      serverWideAllowRule(PLAYWRIGHT_HEADED_MCP_SERVER_NAME),
    ],
  }
}

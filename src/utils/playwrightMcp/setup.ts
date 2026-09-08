import { join } from 'path'
import { fileURLToPath } from 'url'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'

import { isInBundledMode } from '../bundledMode.js'
import { PLAYWRIGHT_MCP_SERVER_NAME } from './common.js'

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

/** Set DOGE_PLAYWRIGHT_MCP=0 to opt out entirely (e.g. missing browser binaries). */
export function isPlaywrightMCPEnabled(): boolean {
  const raw = process.env.DOGE_PLAYWRIGHT_MCP?.trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

/**
 * Build the dynamic MCP config + allowed tool names for the built-in
 * Playwright server. Mirrors `setupComputerUseMCP`.
 *
 * A single server-level wildcard rule is used instead of enumerating tool
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

  const allowedTools = [serverWideAllowRule(PLAYWRIGHT_MCP_SERVER_NAME)]

  // command/args are never spawned — client.ts intercepts by server name and
  // connects to the in-process server. The config only has to exist with
  // type 'stdio' to reach that branch. Mirrors the Chrome / Computer Use setup.
  const args = isInBundledMode()
    ? ['--playwright-mcp']
    : [join(fileURLToPath(import.meta.url), '..', 'cli.js'), '--playwright-mcp']

  return {
    mcpConfig: {
      [PLAYWRIGHT_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args,
        scope: 'dynamic',
      } as const,
    },
    allowedTools,
  }
}

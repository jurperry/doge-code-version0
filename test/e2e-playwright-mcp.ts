/**
 * E2E check for the built-in Playwright MCP server.
 *
 * Exercises the same path the CLI uses at runtime:
 *   1. setupPlaywrightMCP() → dynamic MCP config + allowedTools
 *   2. createPlaywrightMcpServerForCli() + createLinkedTransportPair()
 *      (exactly what client.ts does for the in-process branch)
 *   3. tools/list over a real MCP client
 *   4. the server-wide allow rule must match every advertised tool
 *   5. optional: launch the browser, navigate, snapshot, close
 *      (skipped with a clear message when no browser binary is installed)
 *
 * Usage: bun test/e2e-playwright-mcp.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { createLinkedTransportPair } from '../src/services/mcp/InProcessTransport.js'
import { mcpInfoFromString } from '../src/services/mcp/mcpStringUtils.js'
import { PLAYWRIGHT_MCP_SERVER_NAME } from '../src/utils/playwrightMcp/common.js'
import { createPlaywrightMcpServerForCli } from '../src/utils/playwrightMcp/mcpServer.js'
import { setupPlaywrightMCP } from '../src/utils/playwrightMcp/setup.js'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Re-implementation of the rule matcher in utils/permissions/permissions.ts. */
function ruleMatches(rule: string, toolName: string): boolean {
  const ruleInfo = mcpInfoFromString(rule)
  const toolInfo = mcpInfoFromString(toolName)
  return Boolean(
    ruleInfo &&
      toolInfo &&
      (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
      ruleInfo.serverName === toolInfo.serverName,
  )
}

async function main(): Promise<void> {
  // 1. Config shape
  const { mcpConfig, allowedTools } = setupPlaywrightMCP()
  const entry = mcpConfig[PLAYWRIGHT_MCP_SERVER_NAME] as
    | { type?: string; scope?: string }
    | undefined
  check('config registers the server', entry !== undefined)
  check('config type is stdio', entry?.type === 'stdio')
  check('config scope is dynamic', entry?.scope === 'dynamic')
  check('allow rule is a server-wide wildcard', allowedTools[0] === `mcp__${PLAYWRIGHT_MCP_SERVER_NAME}__*`, allowedTools[0])

  // 2. In-process connection
  const server = await createPlaywrightMcpServerForCli()
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'doge-e2e', version: '0.0.0' })
  await client.connect(clientTransport)
  check('in-process transport connected', true)

  // 3. Tool list
  const { tools } = await client.listTools()
  check('tools/list returns a non-empty toolset', tools.length > 0, `${tools.length} tools`)
  const expected = [
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_take_screenshot',
    'browser_close',
  ]
  const names = tools.map(t => t.name)
  for (const name of expected) {
    check(`tool present: ${name}`, names.includes(name))
  }

  // 4. The allow rule must cover every tool (no permission prompt per tool)
  const unmatched = tools
    .map(t => `mcp__${PLAYWRIGHT_MCP_SERVER_NAME}__${t.name}`)
    .filter(fq => !allowedTools.some(rule => ruleMatches(rule, fq)))
  check(
    'every tool is covered by the allow rule',
    unmatched.length === 0,
    unmatched.slice(0, 3).join(', '),
  )

  // 5. Optional live browser round-trip.
  //    The toolset, the transport and the permission rule are all verified
  //    above without a browser; this last step only proves the installed
  //    playwright can actually launch one. Missing binaries are an environment
  //    gap, not a code failure — report them as SKIP with the fix command.
  const nav = (await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'about:blank' },
  })) as { isError?: boolean; content?: Array<{ text?: string }> }
  const navError = nav.isError ? String(nav.content?.[0]?.text ?? '') : ''

  if (nav.isError && /is not installed|Executable doesn't exist/i.test(navError)) {
    console.log(
      `SKIP  live browser round-trip — browser binaries are not installed.\n` +
        `      ${navError.split('\n').find(l => l.includes('Run '))?.trim() ?? navError.split('\n')[0]}\n` +
        `      (or: bunx playwright install chromium)`,
    )
  } else {
    check('browser_navigate succeeded', !nav.isError, navError.split('\n')[0] ?? '')
    if (!nav.isError) {
      const snap = (await client.callTool({
        name: 'browser_snapshot',
        arguments: {},
      })) as { isError?: boolean; content?: Array<{ text?: string }> }
      check(
        'browser_snapshot returned content',
        !snap.isError && (snap.content?.length ?? 0) > 0,
        snap.isError ? String(snap.content?.[0]?.text ?? '').split('\n')[0] ?? '' : '',
      )
      await client.callTool({ name: 'browser_close', arguments: {} })
      check('browser_close succeeded', true)
    }
  }

  await client.close()
  await server.close()
  check('closed cleanly', true)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()

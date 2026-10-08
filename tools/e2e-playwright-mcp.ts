/**
 * E2E check for the built-in Playwright MCP server.
 *
 * Exercises the real runtime path:
 *   1. setupPlaywrightMCP() → dynamic MCP config + allowedTools
 *   2. spawn `@playwright/mcp`'s CLI under Node over stdio (exactly what
 *      client.ts does — Playwright can't drive a browser from Bun)
 *   3. tools/list
 *   4. the server-wide allow rule must match every advertised tool
 *   5. live round-trip: navigate to a real page, snapshot it, close
 *
 * Usage: bun tools/e2e-playwright-mcp.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { mcpInfoFromString } from '../src/services/mcp/mcpStringUtils.js'
import { PLAYWRIGHT_MCP_SERVER_NAME } from '../src/utils/playwrightMcp/common.js'
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
    | { type?: string; scope?: string; command?: string; args?: string[] }
    | undefined

  check('config registers the server', entry !== undefined)
  check('config type is stdio', entry?.type === 'stdio')
  check('config scope is dynamic', entry?.scope === 'dynamic')
  check(
    'allow rule is a server-wide wildcard',
    allowedTools[0] === `mcp__${PLAYWRIGHT_MCP_SERVER_NAME}__*`,
    allowedTools[0],
  )
  if (!entry) {
    console.log(
      '\nNo server registered (DOGE_PLAYWRIGHT_MCP=0, or no Node on this machine).',
    )
    process.exit(1)
  }

  console.log(`INFO  command: ${entry.command}`)
  console.log(`INFO  args   : ${entry.args?.join(' ')}`)

  // 2. Real stdio spawn
  const transport = new StdioClientTransport({
    command: entry.command!,
    args: entry.args!,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'doge-e2e', version: '0.0.0' })
  await client.connect(transport)
  check('stdio MCP server connected', true)

  // 3. Tool list
  const { tools } = await client.listTools()
  check(
    'tools/list returns a non-empty toolset',
    tools.length > 0,
    `${tools.length} tools`,
  )
  const names = tools.map(t => t.name)
  for (const name of [
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_take_screenshot',
    'browser_close',
  ]) {
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

  // 5. Live round-trip against a real page
  let navOk = false
  let navError = ''
  try {
    const nav = (await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }
    navOk = !nav.isError
    navError = nav.isError ? String(nav.content?.[0]?.text ?? '') : ''
  } catch (error) {
    navError = error instanceof Error ? error.message : String(error)
  }

  if (/is not installed|Executable doesn't exist/i.test(navError)) {
    console.log(
      `SKIP  live browser round-trip — no browser binary available.\n` +
        `      ${navError.split('\n').find(l => l.includes('Run '))?.trim() ?? navError.split('\n')[0]}`,
    )
  } else if (navError) {
    check('browser_navigate succeeded', false, navError.split('\n')[0])
  } else {
    check('browser_navigate succeeded', navOk)
    const snap = (await client.callTool({
      name: 'browser_snapshot',
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> }
    const snapText = String(snap.content?.[0]?.text ?? '')
    check(
      'browser_snapshot returned the page content',
      !snap.isError && snapText.includes('Example Domain'),
      snapText.slice(0, 80).replace(/\n/g, ' | '),
    )
    await client.callTool({ name: 'browser_close', arguments: {} })
    check('browser_close succeeded', true)
  }

  await client.close()
  check('closed cleanly', true)

  console.log(
    failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

await main()

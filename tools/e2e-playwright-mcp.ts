/**
 * E2E check for the built-in Playwright MCP servers.
 *
 * For both headless and visible modes, exercises the real runtime path:
 *   1. setupPlaywrightMCP() → dynamic MCP config + allowedTools
 *   2. spawn `@playwright/mcp`'s CLI under Node over stdio
 *   3. tools/list and server-wide permission matching
 *   4. live round-trip: navigate to a real page, snapshot it, close
 *
 * Usage: bun tools/e2e-playwright-mcp.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

import { mcpInfoFromString } from '../src/services/mcp/mcpStringUtils.js'
import {
  PLAYWRIGHT_HEADED_MCP_SERVER_NAME,
  PLAYWRIGHT_MCP_SERVER_NAME,
} from '../src/utils/playwrightMcp/common.js'
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

type McpEntry = { type?: string; scope?: string; command?: string; args?: string[] }

async function verifyServer(
  serverName: string,
  entry: McpEntry | undefined,
  allowedTools: string[],
): Promise<void> {
  check(`${serverName}: config registers the server`, entry !== undefined)
  check(`${serverName}: config type is stdio`, entry?.type === 'stdio')
  check(`${serverName}: config scope is dynamic`, entry?.scope === 'dynamic')
  const allowRule = `mcp__${serverName}__*`
  check(`${serverName}: allow rule is a server-wide wildcard`, allowedTools.includes(allowRule))
  const expectsHeadless = serverName === PLAYWRIGHT_MCP_SERVER_NAME
  check(
    `${serverName}: browser mode is ${expectsHeadless ? 'headless' : 'visible'}`,
    entry?.args?.includes('--headless') === expectsHeadless,
    entry?.args?.join(' '),
  )
  if (!entry) return

  const transport = new StdioClientTransport({
    command: entry.command!,
    args: entry.args!,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'doge-e2e', version: '0.0.0' })
  await client.connect(transport)
  check(`${serverName}: stdio MCP server connected`, true)

  try {
    const { tools } = await client.listTools()
    check(
      `${serverName}: tools/list returns a non-empty toolset`,
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
      check(`${serverName}: tool present: ${name}`, names.includes(name))
    }

    const unmatched = tools
      .map(t => `mcp__${serverName}__${t.name}`)
      .filter(fq => !allowedTools.some(rule => ruleMatches(rule, fq)))
    check(
      `${serverName}: every tool is covered by the allow rule`,
      unmatched.length === 0,
      unmatched.slice(0, 3).join(', '),
    )

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
      console.log(`SKIP  ${serverName}: live browser round-trip — no browser binary available.`)
    } else if (navError) {
      check(`${serverName}: browser_navigate succeeded`, false, navError.split('\n')[0])
    } else {
      check(`${serverName}: browser_navigate succeeded`, navOk)
      const snap = (await client.callTool({
        name: 'browser_snapshot',
        arguments: {},
      })) as { isError?: boolean; content?: Array<{ text?: string }> }
      const snapText = String(snap.content?.[0]?.text ?? '')
      check(
        `${serverName}: browser_snapshot returned the page content`,
        !snap.isError && snapText.includes('Example Domain'),
        snapText.slice(0, 80).replace(/\n/g, ' | '),
      )
      await client.callTool({ name: 'browser_close', arguments: {} })
      check(`${serverName}: browser_close succeeded`, true)
    }
  } finally {
    await client.close()
  }
}

async function main(): Promise<void> {
  mkdirSync(join(process.cwd(), 'test'), { recursive: true })
  const outputDir = mkdtempSync(join(process.cwd(), 'test', 'playwright-mcp-'))
  const previousOutputDir = process.env.DOGE_PLAYWRIGHT_OUTPUT_DIR
  process.env.DOGE_PLAYWRIGHT_OUTPUT_DIR = outputDir
  try {
    const { mcpConfig, allowedTools } = setupPlaywrightMCP()
    for (const serverName of [PLAYWRIGHT_MCP_SERVER_NAME, PLAYWRIGHT_HEADED_MCP_SERVER_NAME]) {
      await verifyServer(serverName, mcpConfig[serverName] as McpEntry | undefined, allowedTools)
    }
  } finally {
    if (previousOutputDir === undefined) delete process.env.DOGE_PLAYWRIGHT_OUTPUT_DIR
    else process.env.DOGE_PLAYWRIGHT_OUTPUT_DIR = previousOutputDir
    rmSync(outputDir, { recursive: true, force: true })
  }
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()

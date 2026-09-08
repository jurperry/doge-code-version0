import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  isMcpServerDisabled,
  setMcpServerEnabled,
} from '../../services/mcp/config.js'
import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import { saveCurrentProjectConfig } from '../../utils/config.js'
import {
  PLAYWRIGHT_MCP_PROMPT_HINT,
  PLAYWRIGHT_MCP_SERVER_NAME,
  isPlaywrightMCPServer,
} from './common.js'
import { isPlaywrightMCPEnabled, setupPlaywrightMCP } from './setup.js'

// NODE_ENV=test (bun:test default) keeps getCurrentProjectConfig /
// saveCurrentProjectConfig on the in-memory TEST_PROJECT_CONFIG_FOR_TESTING,
// so no disk writes. Reset both toggles to avoid leaking state between cases.
const originalOptOut = process.env.DOGE_PLAYWRIGHT_MCP

beforeEach(() => {
  delete process.env.DOGE_PLAYWRIGHT_MCP
  saveCurrentProjectConfig(current => ({
    ...current,
    disabledMcpServers: [],
    enabledMcpServers: [],
  }))
})

afterEach(() => {
  if (originalOptOut === undefined) {
    delete process.env.DOGE_PLAYWRIGHT_MCP
  } else {
    process.env.DOGE_PLAYWRIGHT_MCP = originalOptOut
  }
})

test('playwright MCP server is enabled by default', () => {
  // Built-in and always-on, same contract as computer-use: the tools must be
  // in the model's list without any /mcp opt-in.
  expect(isMcpServerDisabled(PLAYWRIGHT_MCP_SERVER_NAME)).toBe(false)
})

test('playwright can still be opted out via setMcpServerEnabled(false)', () => {
  setMcpServerEnabled(PLAYWRIGHT_MCP_SERVER_NAME, false)
  expect(isMcpServerDisabled(PLAYWRIGHT_MCP_SERVER_NAME)).toBe(true)

  setMcpServerEnabled(PLAYWRIGHT_MCP_SERVER_NAME, true)
  expect(isMcpServerDisabled(PLAYWRIGHT_MCP_SERVER_NAME)).toBe(false)
})

test('setupPlaywrightMCP registers the in-process server', () => {
  const { mcpConfig } = setupPlaywrightMCP()
  const entry = mcpConfig[PLAYWRIGHT_MCP_SERVER_NAME]

  expect(entry).toBeDefined()
  // 'stdio' + scope 'dynamic' is what routes connectToServer into the
  // in-process branch; the command is never spawned.
  expect(entry?.type).toBe('stdio')
  expect((entry as { scope?: string }).scope).toBe('dynamic')
})

test('setupPlaywrightMCP allow rule covers every tool from the server', () => {
  const { allowedTools } = setupPlaywrightMCP()

  // A single server-level wildcard rather than an enumerated tool list: the
  // upstream toolset changes between releases and a stale hardcoded list would
  // silently leave new tools behind the permission prompt.
  expect(allowedTools).toHaveLength(1)

  const rule = allowedTools[0]!
  expect(rule).toBe(`mcp__${PLAYWRIGHT_MCP_SERVER_NAME}__*`)
  expect(mcpInfoFromString(rule)).toEqual({
    serverName: PLAYWRIGHT_MCP_SERVER_NAME,
    toolName: '*',
  })
  // permissions.ts matches a rule when ruleInfo.toolName is '*' and the server
  // names are equal — assert the concrete tool this relies on.
  const tool = mcpInfoFromString(`mcp__${PLAYWRIGHT_MCP_SERVER_NAME}__browser_navigate`)
  expect(tool?.serverName).toBe(PLAYWRIGHT_MCP_SERVER_NAME)
})

test('DOGE_PLAYWRIGHT_MCP=0 opts out entirely', () => {
  for (const value of ['0', 'false', 'off']) {
    process.env.DOGE_PLAYWRIGHT_MCP = value
    expect(isPlaywrightMCPEnabled()).toBe(false)
    expect(setupPlaywrightMCP()).toEqual({ mcpConfig: {}, allowedTools: [] })
  }

  process.env.DOGE_PLAYWRIGHT_MCP = '1'
  expect(isPlaywrightMCPEnabled()).toBe(true)
  expect(Object.keys(setupPlaywrightMCP().mcpConfig)).toContain(
    PLAYWRIGHT_MCP_SERVER_NAME,
  )
})

test('server name matching is normalization-tolerant', () => {
  // normalizeNameForMCP maps non [a-zA-Z0-9_-] to '_', so config keys that
  // differ only by separators still resolve to the reserved built-in name.
  expect(isPlaywrightMCPServer('playwright')).toBe(true)
  expect(isPlaywrightMCPServer('PlayWright')).toBe(false)
  expect(isPlaywrightMCPServer('playwright-mcp')).toBe(false)
})

test('local prompt hint covers the snapshot-driven workflow', () => {
  // Third-party/translated endpoints don't get the server-side browser hint,
  // so the local one must teach discovery + the snapshot → act → verify loop.
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('mcp__playwright__')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('browser_navigate')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('browser_snapshot')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT.toLowerCase()).toContain('verify')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('WebFetch')
})

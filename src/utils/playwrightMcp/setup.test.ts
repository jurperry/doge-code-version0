import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  isMcpServerDisabled,
  setMcpServerEnabled,
} from '../../services/mcp/config.js'
import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import { saveCurrentProjectConfig } from '../../utils/config.js'
import {
  PLAYWRIGHT_HEADED_MCP_SERVER_NAME,
  PLAYWRIGHT_MCP_SERVER_NAME,
  isPlaywrightMCPServer,
} from './common.js'
import { isPlaywrightMCPEnabled, PLAYWRIGHT_MCP_PROMPT_HINT, setupPlaywrightMCP } from './setup.js'

// NODE_ENV=test (bun:test default) keeps getCurrentProjectConfig /
// saveCurrentProjectConfig on the in-memory TEST_PROJECT_CONFIG_FOR_TESTING,
// so no disk writes. Reset both toggles to avoid leaking state between cases.
const originalOptOut = process.env.DOGE_PLAYWRIGHT_MCP
const originalHeadless = process.env.DOGE_PLAYWRIGHT_HEADLESS

beforeEach(() => {
  delete process.env.DOGE_PLAYWRIGHT_MCP
  delete process.env.DOGE_PLAYWRIGHT_HEADLESS
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
  if (originalHeadless === undefined) {
    delete process.env.DOGE_PLAYWRIGHT_HEADLESS
  } else {
    process.env.DOGE_PLAYWRIGHT_HEADLESS = originalHeadless
  }
})

test('both playwright MCP servers are enabled by default', () => {
  for (const name of [PLAYWRIGHT_MCP_SERVER_NAME, PLAYWRIGHT_HEADED_MCP_SERVER_NAME]) {
    expect(isMcpServerDisabled(name)).toBe(false)
  }
})

test('each playwright mode can still be opted out via setMcpServerEnabled(false)', () => {
  for (const name of [PLAYWRIGHT_MCP_SERVER_NAME, PLAYWRIGHT_HEADED_MCP_SERVER_NAME]) {
    setMcpServerEnabled(name, false)
    expect(isMcpServerDisabled(name)).toBe(true)

    setMcpServerEnabled(name, true)
    expect(isMcpServerDisabled(name)).toBe(false)
  }
})

test('setupPlaywrightMCP registers real stdio servers for headless and visible modes', () => {
  const { mcpConfig } = setupPlaywrightMCP()
  const headless = mcpConfig[PLAYWRIGHT_MCP_SERVER_NAME] as
    | { type?: string; scope?: string; command?: string; args?: string[] }
    | undefined
  const headed = mcpConfig[PLAYWRIGHT_HEADED_MCP_SERVER_NAME] as
    | { type?: string; scope?: string; command?: string; args?: string[] }
    | undefined

  for (const entry of [headless, headed]) {
    expect(entry).toBeDefined()
    expect(entry?.type).toBe('stdio')
    expect(entry?.scope).toBe('dynamic')
    expect(entry?.command).toBeTruthy()
    expect(entry?.args?.[0]).toContain('playwright')
  }
  expect(headless?.args).toContain('--headless')
  expect(headed?.args).not.toContain('--headless')
})

test('legacy DOGE_PLAYWRIGHT_HEADLESS=0 keeps the original server visible', () => {
  process.env.DOGE_PLAYWRIGHT_HEADLESS = '0'
  const { mcpConfig } = setupPlaywrightMCP()
  const original = mcpConfig[PLAYWRIGHT_MCP_SERVER_NAME] as { args?: string[] }
  const headed = mcpConfig[PLAYWRIGHT_HEADED_MCP_SERVER_NAME] as { args?: string[] }
  expect(original.args).not.toContain('--headless')
  expect(headed.args).not.toContain('--headless')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('DOGE_PLAYWRIGHT_HEADLESS=0')
})

test('setupPlaywrightMCP allow rules cover every tool from both servers', () => {
  const { allowedTools } = setupPlaywrightMCP()

  expect(allowedTools).toHaveLength(2)
  for (const [index, serverName] of [PLAYWRIGHT_MCP_SERVER_NAME, PLAYWRIGHT_HEADED_MCP_SERVER_NAME].entries()) {
    const rule = allowedTools[index]!
    expect(rule).toBe(`mcp__${serverName}__*`)
    expect(mcpInfoFromString(rule)).toEqual({ serverName, toolName: '*' })
    const tool = mcpInfoFromString(`mcp__${serverName}__browser_navigate`)
    expect(tool?.serverName).toBe(serverName)
  }
})

test('DOGE_PLAYWRIGHT_MCP=0 opts out entirely', () => {
  for (const value of ['0', 'false', 'off']) {
    process.env.DOGE_PLAYWRIGHT_MCP = value
    expect(isPlaywrightMCPEnabled()).toBe(false)
    expect(setupPlaywrightMCP()).toEqual({ mcpConfig: {}, allowedTools: [] })
  }

  process.env.DOGE_PLAYWRIGHT_MCP = '1'
  expect(isPlaywrightMCPEnabled()).toBe(true)
  expect(Object.keys(setupPlaywrightMCP().mcpConfig)).toEqual([
    PLAYWRIGHT_MCP_SERVER_NAME,
    PLAYWRIGHT_HEADED_MCP_SERVER_NAME,
  ])
})

test('server name matching is normalization-tolerant', () => {
  // normalizeNameForMCP maps non [a-zA-Z0-9_-] to '_', so config keys that
  // differ only by separators still resolve to the reserved built-in name.
  expect(isPlaywrightMCPServer('playwright')).toBe(true)
  expect(isPlaywrightMCPServer('playwright-headed')).toBe(true)
  expect(isPlaywrightMCPServer('PlayWright')).toBe(false)
  expect(isPlaywrightMCPServer('playwright-mcp')).toBe(false)
})

test('local prompt hint covers the snapshot-driven workflow', () => {
  // Third-party/translated endpoints don't get the server-side browser hint,
  // so the local one must teach discovery + the snapshot → act → verify loop.
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('mcp__playwright__')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('mcp__playwright-headed__')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('browser_navigate')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('browser_snapshot')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT.toLowerCase()).toContain('verify')
  expect(PLAYWRIGHT_MCP_PROMPT_HINT).toContain('WebFetch')
})

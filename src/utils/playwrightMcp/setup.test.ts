import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
import { resolvePlaywrightCliPath } from './command.js'
import { isPlaywrightMCPEnabled, PLAYWRIGHT_MCP_PROMPT_HINT, setupPlaywrightMCP } from './setup.js'

// NODE_ENV=test (bun:test default) keeps getCurrentProjectConfig /
// saveCurrentProjectConfig on the in-memory TEST_PROJECT_CONFIG_FOR_TESTING,
// so no disk writes. Reset both toggles to avoid leaking state between cases.
const originalOptOut = process.env.DOGE_PLAYWRIGHT_MCP
const originalHeadless = process.env.DOGE_PLAYWRIGHT_HEADLESS
const desktopEnv = ['DOGE_APP_PLAYWRIGHT_PREFERENCE', 'DOGE_APP_PLAYWRIGHT_CHROME_PATH', 'DOGE_APP_PLAYWRIGHT_EDGE_PATH', 'DOGE_APP_PLAYWRIGHT_DISABLED', 'DOGE_APP_PLAYWRIGHT_BRIDGE'] as const
const originalDesktopEnv = desktopEnv.map(key => process.env[key])

// Real files the bridge lookup must existsSync before using it.
const bridgeDirs: string[] = []

function makeBridgeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'doge-pw-bridge-'))
  bridgeDirs.push(dir)
  const path = join(dir, 'browser-bridge.cjs')
  writeFileSync(path, '// test bridge\n')
  return path
}

beforeEach(() => {
  delete process.env.DOGE_PLAYWRIGHT_MCP
  delete process.env.DOGE_PLAYWRIGHT_HEADLESS
  for (const key of desktopEnv) delete process.env[key]
  saveCurrentProjectConfig(current => ({
    ...current,
    disabledMcpServers: [],
    enabledMcpServers: [],
  }))
})

afterEach(() => {
  for (const dir of bridgeDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const [index, key] of desktopEnv.entries()) {
    const value = originalDesktopEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
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

test('the injected bridge wraps the CLI for the headless server only', () => {
  // The desktop shell points this at its own bridge script, which starts a
  // local headless browser and hands its CDP endpoint to the MCP CLI.
  const bridge = makeBridgeFile()
  process.env.DOGE_APP_PLAYWRIGHT_BRIDGE = bridge
  const { mcpConfig } = setupPlaywrightMCP()
  const headless = mcpConfig[PLAYWRIGHT_MCP_SERVER_NAME] as { args?: string[] }
  const headed = mcpConfig[PLAYWRIGHT_HEADED_MCP_SERVER_NAME] as { args?: string[] }

  expect(headless.args?.[0]).toBe(bridge)
  expect(headless.args?.[1]).toBe(resolvePlaywrightCliPath())
  expect(headless.args).toContain('--headless')

  expect(headed.args?.[0]).toBe(resolvePlaywrightCliPath())
  expect(headed.args).not.toContain(bridge)
  expect(headed.args).not.toContain('--headless')
})

test('desktop headless servers use the bridge while visible servers keep the CLI', () => {
  const bridge = makeBridgeFile()
  process.env.DOGE_APP_PLAYWRIGHT_BRIDGE = bridge
  process.env.DOGE_APP_PLAYWRIGHT_PREFERENCE = 'auto'
  process.env.DOGE_APP_PLAYWRIGHT_CHROME_PATH = process.execPath
  process.env.DOGE_APP_PLAYWRIGHT_EDGE_PATH = process.execPath
  const { mcpConfig } = setupPlaywrightMCP()
  const cli = resolvePlaywrightCliPath()

  expect(Object.keys(mcpConfig)).toHaveLength(4)
  for (const [name, config] of Object.entries(mcpConfig)) {
    if (config.type !== 'stdio') throw new Error('Expected stdio server')
    const args = config.args as string[]
    if (name.endsWith('-headed')) {
      expect(args[0]).toBe(cli)
      expect(args).not.toContain(bridge)
    } else {
      expect(args[0]).toBe(bridge)
      expect(args[1]).toBe(cli)
    }
  }
})

test('an unset or missing bridge file leaves the CLI first', () => {
  const cli = resolvePlaywrightCliPath()

  // Unset.
  const plain = setupPlaywrightMCP().mcpConfig[PLAYWRIGHT_MCP_SERVER_NAME] as { args?: string[] }
  expect(plain.args?.[0]).toBe(cli)

  // Set, but pointing at a file that does not exist.
  const missingDir = mkdtempSync(join(tmpdir(), 'doge-pw-bridge-'))
  bridgeDirs.push(missingDir)
  process.env.DOGE_APP_PLAYWRIGHT_BRIDGE = join(missingDir, 'missing.cjs')
  const missing = setupPlaywrightMCP().mcpConfig[PLAYWRIGHT_MCP_SERVER_NAME] as { args?: string[] }
  expect(missing.args?.[0]).toBe(cli)
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

test.each(['auto', 'chrome', 'msedge'])('desktop %s keeps both installed browsers available in the same session', preference => {
  process.env.DOGE_APP_PLAYWRIGHT_PREFERENCE = preference
  process.env.DOGE_APP_PLAYWRIGHT_CHROME_PATH = process.execPath
  process.env.DOGE_APP_PLAYWRIGHT_EDGE_PATH = process.execPath
  const { mcpConfig, allowedTools } = setupPlaywrightMCP()
  expect(Object.keys(mcpConfig).sort()).toEqual(['playwright-chrome', 'playwright-chrome-headed', 'playwright-edge', 'playwright-edge-headed'])
  for (const [name, config] of Object.entries(mcpConfig)) {
    if (config.type !== 'stdio') throw new Error('Expected stdio server')
    expect(config.args).toContain(name.startsWith('playwright-edge') ? 'msedge' : 'chrome')
    expect(config.args).toContain(process.execPath)
    expect(config.args?.includes('--headless')).toBe(!name.endsWith('-headed'))
    expect(allowedTools).toContain(`mcp__${name}__*`)
    expect(isPlaywrightMCPServer(name)).toBe(true)
  }
})

test('desktop setup only publishes installed browsers and honors off', () => {
  process.env.DOGE_APP_PLAYWRIGHT_PREFERENCE = 'auto'
  expect(setupPlaywrightMCP().mcpConfig).toEqual({})
  process.env.DOGE_APP_PLAYWRIGHT_EDGE_PATH = process.execPath
  process.env.DOGE_APP_PLAYWRIGHT_CHROME_PATH = 'missing-chrome-path'
  expect(Object.keys(setupPlaywrightMCP().mcpConfig)).toEqual(['playwright-edge', 'playwright-edge-headed'])
  process.env.DOGE_PLAYWRIGHT_MCP = '1'
  process.env.DOGE_APP_PLAYWRIGHT_DISABLED = '1'
  expect(setupPlaywrightMCP().mcpConfig).toEqual({})
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

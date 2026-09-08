import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  buildPlaywrightMcpCommand,
  detectSystemBrowser,
  findNodeExecutable,
  playwrightOutputDir,
  resolvePlaywrightCliPath,
} from './command.js'

const MANAGED_ENV = [
  'DOGE_PLAYWRIGHT_BROWSER',
  'DOGE_PLAYWRIGHT_HEADLESS',
  'DOGE_PLAYWRIGHT_EXECUTABLE_PATH',
  'DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER',
  'DOGE_PLAYWRIGHT_OUTPUT_DIR',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of MANAGED_ENV) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (saved[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved[key]
    }
  }
})

test('finds a Node executable and the CLI entrypoint', () => {
  // The whole server depends on these existing — Playwright can't run under
  // Bun, so Node is a hard requirement (see command.ts).
  const node = findNodeExecutable()
  const cli = resolvePlaywrightCliPath()
  expect(node).toBeTruthy()
  expect(existsSync(node!)).toBe(true)
  expect(cli).toBeTruthy()
  expect(existsSync(cli!)).toBe(true)
})

test('spawns the CLI under Node with chromium + isolated + output dir', () => {
  const cmd = buildPlaywrightMcpCommand()!
  expect(cmd).toBeDefined()
  expect(cmd.command).toBe(findNodeExecutable())
  expect(cmd.args[0]).toBe(resolvePlaywrightCliPath())
  expect(cmd.args).toContain('--browser')
  expect(cmd.args).toContain('chromium')
  expect(cmd.args).toContain('--isolated')
  expect(cmd.browser).toBe('chromium')
  expect(cmd.headless).toBe(true)
})

test('headless flag follows DOGE_PLAYWRIGHT_HEADLESS=0', () => {
  const cmd = buildPlaywrightMcpCommand()!
  expect(cmd.args).toContain('--headless')

  process.env.DOGE_PLAYWRIGHT_HEADLESS = '0'
  const headed = buildPlaywrightMcpCommand()!
  expect(headed.headless).toBe(false)
  expect(headed.args).not.toContain('--headless')
})

test('an explicit executable path wins over auto-detection', () => {
  process.env.DOGE_PLAYWRIGHT_EXECUTABLE_PATH = 'C:\\custom\\chrome.exe'
  const cmd = buildPlaywrightMcpCommand()!
  expect(cmd.executablePath).toBe('C:\\custom\\chrome.exe')
  expect(cmd.args).toContain('--executable-path')
  expect(cmd.args).toContain('C:\\custom\\chrome.exe')
})

test('auto-detected system browser is used for chromium', () => {
  const detected = detectSystemBrowser()
  const cmd = buildPlaywrightMcpCommand()!
  if (!detected) {
    expect(cmd.executablePath).toBeUndefined()
    return
  }
  expect(cmd.executablePath).toBe(detected)
})

test('DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER=0 falls back to the bundled build', () => {
  process.env.DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER = '0'
  expect(buildPlaywrightMcpCommand()!.executablePath).toBeUndefined()
})

test('a Chrome binary is not handed to the firefox/webkit engines', () => {
  process.env.DOGE_PLAYWRIGHT_BROWSER = 'firefox'
  const cmd = buildPlaywrightMcpCommand()!
  expect(cmd.browser).toBe('firefox')
  expect(cmd.executablePath).toBeUndefined()
  expect(cmd.args).not.toContain('--executable-path')

  process.env.DOGE_PLAYWRIGHT_BROWSER = 'webkit'
  expect(buildPlaywrightMcpCommand()!.browser).toBe('webkit')

  process.env.DOGE_PLAYWRIGHT_BROWSER = 'netscape'
  expect(buildPlaywrightMcpCommand()!.browser).toBe('chromium')
})

test('artifacts go to the temp dir, not the project directory', () => {
  // Upstream writes <cwd>/.playwright-mcp by default, which litters whatever
  // project the user happens to be sitting in.
  expect(playwrightOutputDir()).toBe(join(tmpdir(), 'doge-playwright-mcp'))

  process.env.DOGE_PLAYWRIGHT_OUTPUT_DIR = 'D:\\pw-out'
  expect(playwrightOutputDir()).toBe('D:\\pw-out')
  expect(buildPlaywrightMcpCommand()!.args).toContain('D:\\pw-out')
})

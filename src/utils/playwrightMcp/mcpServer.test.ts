import { afterEach, beforeEach, expect, test } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  buildPlaywrightMcpConfig,
  detectSystemBrowser,
  playwrightOutputDir,
} from './mcpServer.js'

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

type LaunchOptions = { headless?: boolean; executablePath?: string }

function launch(): LaunchOptions {
  return (buildPlaywrightMcpConfig().browser?.launchOptions ?? {}) as
    LaunchOptions
}

test('defaults to headless chromium', () => {
  const config = buildPlaywrightMcpConfig()
  expect(config.browser?.browserName).toBe('chromium')
  expect(launch().headless).toBe(true)
})

test('DOGE_PLAYWRIGHT_HEADLESS=0 runs headed', () => {
  process.env.DOGE_PLAYWRIGHT_HEADLESS = '0'
  expect(launch().headless).toBe(false)
})

test('an explicit executable path always wins', () => {
  process.env.DOGE_PLAYWRIGHT_EXECUTABLE_PATH = 'C:\\custom\\chrome.exe'
  expect(launch().executablePath).toBe('C:\\custom\\chrome.exe')
})

test('auto-detected system browser is used for chromium', () => {
  const detected = detectSystemBrowser()
  if (!detected) {
    // No Chrome/Edge here — nothing to assert about auto-detection.
    expect(launch().executablePath).toBeUndefined()
    return
  }
  expect(launch().executablePath).toBe(detected)
})

test('DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER=0 falls back to the bundled build', () => {
  process.env.DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER = '0'
  expect(launch().executablePath).toBeUndefined()
})

test('a Chrome binary is not handed to the firefox/webkit engines', () => {
  process.env.DOGE_PLAYWRIGHT_BROWSER = 'firefox'
  expect(buildPlaywrightMcpConfig().browser?.browserName).toBe('firefox')
  expect(launch().executablePath).toBeUndefined()

  process.env.DOGE_PLAYWRIGHT_BROWSER = 'webkit'
  expect(buildPlaywrightMcpConfig().browser?.browserName).toBe('webkit')
})

test('unknown browser names fall back to chromium', () => {
  process.env.DOGE_PLAYWRIGHT_BROWSER = 'netscape'
  expect(buildPlaywrightMcpConfig().browser?.browserName).toBe('chromium')
})

test('artifacts go to the temp dir, not the project directory', () => {
  // Upstream writes <cwd>/.playwright-mcp by default, which litters whatever
  // project the user happens to be sitting in.
  expect(playwrightOutputDir()).toBe(join(tmpdir(), 'doge-playwright-mcp'))

  process.env.DOGE_PLAYWRIGHT_OUTPUT_DIR = 'D:\\pw-out'
  expect(playwrightOutputDir()).toBe('D:\\pw-out')
  expect(buildPlaywrightMcpConfig().outputDir).toBe('D:\\pw-out')
})

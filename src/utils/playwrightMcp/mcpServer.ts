import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { createConnection } from '@playwright/mcp'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logForDebugging } from '../debug.js'

type PlaywrightMcpConfig = NonNullable<
  Parameters<typeof createConnection>[0]
>
type BrowserName = NonNullable<
  NonNullable<PlaywrightMcpConfig['browser']>['browserName']
>

const DEFAULT_BROWSER: BrowserName = 'chromium'

function parseBrowserName(raw: string | undefined): BrowserName {
  if (raw === 'firefox' || raw === 'webkit') return raw
  return DEFAULT_BROWSER
}

/**
 * Where Playwright writes session artifacts (traces, PDFs, saved session).
 *
 * Upstream defaults to `<cwd>/.playwright-mcp`, which litters every project the
 * user happens to be in — this repo itself has a stray one from an earlier run.
 * Keep it in the OS temp dir instead.
 */
export function playwrightOutputDir(): string {
  return (
    process.env.DOGE_PLAYWRIGHT_OUTPUT_DIR?.trim() ||
    join(tmpdir(), 'doge-playwright-mcp')
  )
}

/**
 * First existing Chromium-based browser installed on this machine.
 *
 * Playwright normally drives its own pinned browser build (chromium revision
 * 1243 for the version we ship), which the user has to download separately —
 * ~150 MB, and it lands on the system drive. Nearly every desktop already has
 * Chrome or Edge, and both are Chromium, so pointing Playwright at one of them
 * makes the toolset work on first use with nothing to download.
 *
 * Only consulted for the chromium engine: handing a Chrome binary to the
 * firefox/webkit engines would obviously not work.
 */
export function detectSystemBrowser(): string | undefined {
  const localAppData = process.env.LOCALAPPDATA ?? ''

  const candidates: string[] =
    process.platform === 'win32'
      ? [
          join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge',
          ]

  return candidates.find(path => path.length > 0 && existsSync(path))
}

export function buildPlaywrightMcpConfig(): PlaywrightMcpConfig {
  const headless = process.env.DOGE_PLAYWRIGHT_HEADLESS?.trim() !== '0'
  const browserName = parseBrowserName(
    process.env.DOGE_PLAYWRIGHT_BROWSER?.trim(),
  )

  const launchOptions: NonNullable<
    NonNullable<PlaywrightMcpConfig['browser']>['launchOptions']
  > = { headless }

  const explicitPath = process.env.DOGE_PLAYWRIGHT_EXECUTABLE_PATH?.trim()
  const systemBrowser =
    process.env.DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER?.trim() === '0'
      ? undefined
      : detectSystemBrowser()

  // An explicit path always wins; auto-detection only applies to chromium
  // (a Chrome binary is meaningless to the firefox/webkit engines).
  const executablePath =
    explicitPath || (browserName === 'chromium' ? systemBrowser : undefined)
  if (executablePath) {
    launchOptions.executablePath = executablePath
  }

  return {
    browser: {
      browserName,
      // Isolated profile: no shared cookies/state with the user's real browser,
      // and nothing persisted between sessions.
      isolated: true,
      launchOptions,
    },
    outputDir: playwrightOutputDir(),
  }
}

/**
 * Create the Playwright MCP server for in-process use by the CLI.
 *
 * `createConnection` only builds the Server object — the browser itself is
 * launched lazily on the first tool call, so this is cheap (single-digit ms)
 * and safe to run during MCP connection setup.
 */
export async function createPlaywrightMcpServerForCli(): Promise<Server> {
  const config = buildPlaywrightMcpConfig()
  const executable = (
    config.browser?.launchOptions as { executablePath?: string } | undefined
  )?.executablePath

  logForDebugging(
    `[Playwright MCP] starting in-process server (browser=${config.browser?.browserName}, headless=${config.browser?.launchOptions?.headless}, executable=${executable ?? 'playwright default'})`,
  )

  const server = await createConnection(config)
  // Normalize to the SDK Server type: the package types it as Server already,
  // but the runtime object comes from playwright-core's bundled copy.
  return server as unknown as Server
}

import { existsSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { DesktopBrowser } from './common.js'

type BrowserName = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'msedge'

/**
 * Why this server runs as a Node subprocess instead of in-process.
 *
 * Playwright cannot drive a browser from Bun. Both transport paths fail
 * there, while both work under Node on the same machine:
 *
 *   | transport                    | Node | Bun |
 *   |------------------------------|------|-----|
 *   | `--remote-debugging-pipe`    | ok   | timeout (extra fds 3/4 never reach the child) |
 *   | `--remote-debugging-port`+WS | ok   | timeout (WebSocket handshake never completes) |
 *
 * Bun can still `fetch()` the CDP HTTP endpoint fine, so it's specifically the
 * pipe/WebSocket transport layer. Doge runs on Bun, so the Playwright MCP
 * server is spawned as a stdio child process under Node — which is also how
 * upstream ships it (`npx @playwright/mcp`), so it's the best-tested path.
 */

function parseBrowserName(raw: string | undefined): BrowserName {
  if (raw === 'firefox' || raw === 'webkit' || raw === 'chrome' || raw === 'msedge') return raw
  return 'chromium'
}

/** Absolute path of a Node executable, or undefined if there is none. */
export function findNodeExecutable(): string | undefined {
  // Explicit override. The Doge Code desktop shell uses this to point at the
  // Node runtime it can guarantee (its own Electron binary, driven with
  // ELECTRON_RUN_AS_NODE) when the machine has no Node on PATH — otherwise
  // every desktop install would silently get no browser tools at all.
  const override = process.env.DOGE_PLAYWRIGHT_NODE_PATH?.trim()
  if (override && existsSync(override)) {
    return override
  }

  // Doge itself may be running under Node.
  const exec = process.execPath
  if (exec && /node(\.exe)?$/i.test(exec) && existsSync(exec)) {
    return exec
  }

  const separator = process.platform === 'win32' ? ';' : ':'
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']

  for (const rawDir of (process.env.PATH ?? '').split(separator)) {
    // Windows PATH entries are sometimes wrapped in quotes.
    const dir = rawDir.replace(/^"|"$/g, '').trim()
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** Absolute path of `@playwright/mcp`'s CLI entrypoint. */
export function resolvePlaywrightCliPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const packageJson = require.resolve('@playwright/mcp/package.json')
    const cli = join(dirname(packageJson), 'cli.js')
    return existsSync(cli) ? cli : undefined
  } catch {
    return undefined
  }
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
 * ~150 MB, on the system drive. Nearly every desktop already has Chrome or
 * Edge, and both are Chromium, so pointing Playwright at one of them makes the
 * toolset work on first use with nothing to download.
 *
 * Only consulted for the chromium engine: a Chrome binary is meaningless to
 * the firefox/webkit engines.
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

/** Captures everything that goes into the CLI argv, for tests. */
export interface PlaywrightMcpCommand {
  command: string
  args: string[]
  browser: BrowserName
  headless: boolean
  executablePath?: string
}

/**
 * Build the argv for spawning `@playwright/mcp`'s CLI under Node.
 *
 * Returns undefined when there is no Node on this machine — the caller then
 * registers no server at all rather than one that would fail to start.
 */
export function buildPlaywrightMcpCommand(options: {
  headless?: boolean
  desktop?: { browser: DesktopBrowser; executablePath: string }
} = {}): PlaywrightMcpCommand | undefined {
  const command = findNodeExecutable()
  const cliPath = resolvePlaywrightCliPath()
  if (!command || !cliPath) return undefined

  const browser = options.desktop?.browser ?? parseBrowserName(process.env.DOGE_PLAYWRIGHT_BROWSER?.trim())
  const headless = options.headless ?? process.env.DOGE_PLAYWRIGHT_HEADLESS?.trim() !== '0'

  const explicitPath = process.env.DOGE_PLAYWRIGHT_EXECUTABLE_PATH?.trim()
  const executablePath = options.desktop?.executablePath ?? (explicitPath ||
    (browser === 'chromium' && process.env.DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER?.trim() !== '0'
      ? detectSystemBrowser()
      : undefined))

  const args = [
    cliPath,
    '--browser',
    browser,
    '--isolated',
    '--output-dir',
    playwrightOutputDir(),
  ]
  if (headless) args.push('--headless')
  if (executablePath) args.push('--executable-path', executablePath)

  return { command, args, browser, headless, executablePath }
}

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { createConnection } from '@playwright/mcp'
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
function outputDir(): string {
  return (
    process.env.DOGE_PLAYWRIGHT_OUTPUT_DIR?.trim() ||
    join(tmpdir(), 'doge-playwright-mcp')
  )
}

function buildConfig(): PlaywrightMcpConfig {
  const headless = process.env.DOGE_PLAYWRIGHT_HEADLESS?.trim() !== '0'
  const browserName = parseBrowserName(
    process.env.DOGE_PLAYWRIGHT_BROWSER?.trim(),
  )

  return {
    browser: {
      browserName,
      // Isolated profile: no shared cookies/state with the user's real browser,
      // and nothing persisted between sessions.
      isolated: true,
      launchOptions: { headless },
    },
    outputDir: outputDir(),
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
  const config = buildConfig()
  logForDebugging(
    `[Playwright MCP] starting in-process server (browser=${config.browser?.browserName}, headless=${config.browser?.launchOptions?.headless})`,
  )
  const server = await createConnection(config)
  // Normalize to the SDK Server type: the package types it as Server already,
  // but the runtime object comes from playwright-core's bundled copy.
  return server as unknown as Server
}

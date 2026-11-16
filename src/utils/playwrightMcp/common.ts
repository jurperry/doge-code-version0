import { normalizeNameForMCP } from '../../services/mcp/normalization.js'

/**
 * Server names for the built-in Playwright MCP browser modes.
 *
 * Doge fork: official Claude Code has no browser automation server of its own —
 * WebFetch/WebSearch are plain HTTP calls the model can't drive interactively
 * (no clicking, no JS execution, no authenticated sessions). Embedding
 * @playwright/mcp as an in-process MCP server gives the model a real browser
 * controlled through the normal MCP tool surface.
 */
export const PLAYWRIGHT_MCP_SERVER_NAME = 'playwright'
export const PLAYWRIGHT_HEADED_MCP_SERVER_NAME = 'playwright-headed'

export const DESKTOP_PLAYWRIGHT_BROWSERS = {
  chrome: {
    label: 'Chrome',
    headless: 'playwright-chrome',
    visible: 'playwright-chrome-headed',
    pathEnv: 'DOGE_APP_PLAYWRIGHT_CHROME_PATH',
  },
  msedge: {
    label: 'Edge',
    headless: 'playwright-edge',
    visible: 'playwright-edge-headed',
    pathEnv: 'DOGE_APP_PLAYWRIGHT_EDGE_PATH',
  },
} as const

export type DesktopBrowser = keyof typeof DESKTOP_PLAYWRIGHT_BROWSERS
export type BrowserMode = 'headless' | 'visible'
export const DESKTOP_PLAYWRIGHT_SERVER_MODES: ReadonlyMap<string, BrowserMode> = new Map<string, BrowserMode>(
  Object.values(DESKTOP_PLAYWRIGHT_BROWSERS).flatMap(({ headless, visible }) => [
    [headless, 'headless'] as const,
    [visible, 'visible'] as const,
  ]),
)
export const PLAYWRIGHT_MCP_SERVER_NAMES: ReadonlySet<string> = new Set([
  PLAYWRIGHT_MCP_SERVER_NAME,
  PLAYWRIGHT_HEADED_MCP_SERVER_NAME,
  ...DESKTOP_PLAYWRIGHT_SERVER_MODES.keys(),
])

export function desktopBrowserPreference(): 'auto' | DesktopBrowser | undefined {
  const value = process.env.DOGE_APP_PLAYWRIGHT_PREFERENCE
  return value === 'chrome' || value === 'msedge' || value === 'auto' ? value : undefined
}

export function isPlaywrightMCPServer(name: string): boolean {
  return PLAYWRIGHT_MCP_SERVER_NAMES.has(normalizeNameForMCP(name))
}

/**
 * Local stand-in for the browser-tool availability hint the official Anthropic
 * backend injects server-side when it detects `mcp__playwright__*` tool names.
 * Same reasoning as COMPUTER_USE_MCP_PROMPT_HINT: doge sessions usually run
 * through custom/translated endpoints where that server-side behavior doesn't
 * exist, so without a local hint the model may never reach for the browser.
 */
export const PLAYWRIGHT_MCP_PROMPT_HINT = `<browser-automation-availability>
Requests for 浏览器自动化, 浏览器操作, Browser Use, Playwright, or Playwright MCP mean the built-in Playwright MCP. Use its tools first for the browser task. Computer Use handles explicit desktop interaction, such as an existing desktop window or a native dialog.

Desktop sessions expose installed browsers by name: mcp__playwright-chrome__* and mcp__playwright-edge__* are headless, and their -headed variants open visible windows. Select the named browser when the user specifies one. In Auto, choose among the available browsers based on the task. A Chrome token in a user agent also appears in Edge; Edg/ identifies desktop Edge.
Standalone sessions use mcp__playwright__* for the configured headless browser and mcp__playwright-headed__* for the configured visible browser.

Choose the browser mode before starting a task:
- Use a headless server for background automation and when no visible window is needed.
- Use a -headed server when the user asks to open or watch a browser, or when visible interaction matters.
- Follow an explicit user request for headless or visible mode. The two servers have independent browser sessions; do not mix them within one task unless the user asks.
- Legacy compatibility: when DOGE_PLAYWRIGHT_HEADLESS=0 is explicitly set, mcp__playwright__* also runs a visible browser, so both servers are visible. Unset that variable when headless operation is needed.

When to use them instead of WebFetch/WebSearch:
1. The page needs JavaScript to render, requires a login/session, or is behind a form.
2. You must interact (click, scroll, fill, submit) rather than just read a URL.
3. WebFetch/WebSearch returned nothing useful, a bot wall, or a truncated shell.

How to work with them:
1. browser_navigate to the URL.
2. browser_snapshot to read the page as an accessibility tree — that is your primary way to "see" content; it is far cheaper than screenshots and gives stable element references.
3. Act with browser_click / browser_type / browser_fill_form / browser_select_option using the element references from the snapshot.
4. Re-snapshot to verify the effect, then iterate: navigate → snapshot → act → verify.
5. Use browser_take_screenshot only when layout/visuals actually matter, or when the snapshot is ambiguous.

Guidance:
- Prefer browser_snapshot over browser_take_screenshot for reading text; screenshots cost far more tokens.
- Use browser_console_messages and browser_network_requests to debug a page that isn't behaving.
- The selected browser starts on the first call to its server; browser_close shuts that server's browser down when you're done.
- If the requested browser is missing or its server fails, report the exact problem. In the desktop app, check Settings → MCP for installation status, download links, and the switch. Use the command interpreter for local prerequisites, then use the browser MCP for navigation and page interaction. Do not substitute shell-based browser launch, local Playwright imports, another browser, or Computer Use.
- Do not use these tools to bypass a site's access controls or terms of service.
</browser-automation-availability>`

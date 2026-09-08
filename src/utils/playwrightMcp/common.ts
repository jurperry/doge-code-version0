import { normalizeNameForMCP } from '../../services/mcp/normalization.js'

/**
 * Server name for the built-in Playwright MCP server.
 *
 * Doge fork: official Claude Code has no browser automation server of its own —
 * WebFetch/WebSearch are plain HTTP calls the model can't drive interactively
 * (no clicking, no JS execution, no authenticated sessions). Embedding
 * @playwright/mcp as an in-process MCP server gives the model a real browser
 * controlled through the normal MCP tool surface.
 */
export const PLAYWRIGHT_MCP_SERVER_NAME = 'playwright'

export function isPlaywrightMCPServer(name: string): boolean {
  return normalizeNameForMCP(name) === PLAYWRIGHT_MCP_SERVER_NAME
}

/**
 * Local stand-in for the browser-tool availability hint the official Anthropic
 * backend injects server-side when it detects `mcp__playwright__*` tool names.
 * Same reasoning as COMPUTER_USE_MCP_PROMPT_HINT: doge sessions usually run
 * through custom/translated endpoints where that server-side behavior doesn't
 * exist, so without a local hint the model may never reach for the browser.
 */
export const PLAYWRIGHT_MCP_PROMPT_HINT = `<browser-automation-availability>
The mcp__playwright__* tools drive a real Chromium browser: navigating, clicking, typing, filling forms, reading the accessibility snapshot, taking screenshots, listing console/network activity, and managing tabs.

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
- The browser is headless by default and starts on first tool call; browser_close shuts it down when you're done.
- Do not use these tools to bypass a site's access controls or terms of service.
</browser-automation-availability>`

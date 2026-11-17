import { getToolNameForPermissionCheck, mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import type { Message } from '../../types/message.js'
import {
  DESKTOP_PLAYWRIGHT_BROWSERS,
  DESKTOP_PLAYWRIGHT_SERVER_MODES,
  isPlaywrightMCPServer,
  type BrowserMode,
  type DesktopBrowser,
} from './common.js'

const BROWSER_USE = /浏览器自动化|浏览器操作|\bbrowser[ -]use\b|\bplaywright(?:\s+mcp)?\b/i
const BRAND = /\b(?:google\s+)?chrome\b|\b(?:microsoft\s+)?(?:edge|msedge)\b/gi
const BRAND_ACTION = /(?:(?:打开|启动|关闭)(?:的是|一下|下)?|(?:换|切换)(?:到|成|为)?|(?:改|使)?用|通过|比较|对比|\b(?:open|launch|close|use|switch to|with|in|compare)(?:\s+the)?)\s*$/i
const NON_BROWSER = /^\s*(?:branch\b|extension\b|driver\b|分支|扩展|插件|驱动)/i
const BRAND_JOIN = /^\s*(?:和|与|及|以及|或者?|、|and|or|versus|vs\.?)\s*$/i
const NEGATED = /(?:不要|不需要|不使用|不用|不选|别|禁止|避免|而非|而不是|不是|代替|替代)\s*(?:(?:使用|用|选择|切换到|打开|启动|在)\s*)?$|\b(?:not|never|don't|without|instead of|rather than)\s+(?:(?:use|using|choose|open|launch|in|the)\s+)*$/i
const IN_BROWSER = /^\s*(?:浏览器\s*)?(?:中|里|上)\s*(打开|启动|访问|进入|导航|点击|截图|输入|填写|滚动)/
const EXPLICIT_DESKTOP = /^(?:请\s*)?(?:使用|用|通过|use|using)?\s*(?:电脑操作|桌面操作|\bcomputer[ -]use\b)/i
const MODE_LABEL = /无头|可见|有头|\b(?:headless|visible|headed)\b/gi
const MODE_NOUN = /^\s*的?\s*(?:浏览器|窗口|模式|\b(?:browser|window|mode|chrome|edge|msedge)\b)/i
const MODE_CONTEXT = /(?:浏览器|窗口|\b(?:browser|chrome|edge|msedge)\b)(?:\s+(?:in|as))?\s*$/i
const MODE_BEFORE_BRAND = /(?:无头|可见|有头|\b(?:headless|visible|headed)\b)\s*的?\s*$/i
const NO_BROWSER = /^(?:请\s*)?(?:不要|别|无需|禁止|不需要)\s*(?:使用|用|通过|调用)?\s*(?:浏览器|browser|playwright)|^(?:do not|don't|never)\s+(?:use|open|launch)\s+(?:browser|playwright)\b/i

export interface BrowserIntent {
  browser?: DesktopBrowser
  bothBrowsers: boolean
  mode?: BrowserMode
}

export function detectBrowserIntent(raw: string): BrowserIntent | undefined {
  const text = raw.replace(/https?:\/\/[^\s，。！？；、,<>]+/gi, ' ').trim()
  if (!text || EXPLICIT_DESKTOP.test(text) || NO_BROWSER.test(text)) return

  const alias = BROWSER_USE.exec(text)
  const requestedAlias = alias && !NEGATED.test(text.slice(0, alias.index)) && (
    /(?:使用|用|通过|借助|调用|\b(?:use|using|via|with)\b)\s*$/i.test(text.slice(0, alias.index)) ||
    (alias.index === 0 && /^(?:\s*$|\s*[,，:：]|\s*(?:打开|导航|访问|进入|点击|截图|切换|please\b|open\b|navigate\b|visit\b|click\b))/i.test(text.slice(alias[0].length)))
  )
  const targets = new Set<DesktopBrowser>()
  let lastTargetEnd: number | undefined
  const opensBrowser = /(?:打开|启动)\s*浏览器|\b(?:open|launch)\s+(?:the\s+)?browser\b/i.test(text)
  const modeMatch = [...text.matchAll(MODE_LABEL)].findLast(match =>
    MODE_NOUN.test(text.slice(match.index + match[0].length)) ||
    MODE_CONTEXT.test(text.slice(0, match.index)))
  const modeOnly = modeMatch && /打开|访问|启动|导航|点击|使用|\b(?:open|visit|launch|navigate|click|use)\b/i.test(text)
  for (const brand of text.matchAll(BRAND)) {
    const before = text.slice(0, brand.index)
    const beforeMode = before.replace(MODE_BEFORE_BRAND, '')
    const after = text.slice(brand.index + brand[0].length)
    if (NEGATED.test(beforeMode) || NON_BROWSER.test(after)) continue
    const locationAction = /在\s*$/.test(beforeMode) && IN_BROWSER.exec(after)
    if (!requestedAlias && !BRAND_ACTION.test(beforeMode) && !locationAction &&
        !(brand.index === 0 && /^(?:\s*浏览器)?[.!。！]?\s*$/.test(after)) &&
        !(lastTargetEnd !== undefined && BRAND_JOIN.test(before.slice(lastTargetEnd)))) continue
    targets.add(/chrome/i.test(brand[0]) ? 'chrome' : 'msedge')
    lastTargetEnd = brand.index + brand[0].length
  }
  if (!requestedAlias && targets.size === 0 && !opensBrowser && !modeOnly) return

  let mode: BrowserMode | undefined
  if (modeMatch) {
    const headless = /无头|headless/i.test(modeMatch[0])
    mode = headless !== NEGATED.test(text.slice(0, modeMatch.index)) ? 'headless' : 'visible'
  }
  return {
    browser: targets.size === 1 ? [...targets][0] : undefined,
    bothBrowsers: targets.size > 1,
    mode,
  }
}

export function latestBrowserIntent(messages: Message[]): BrowserIntent | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type !== 'user' || message.isMeta || message.isCompactSummary || message.isVirtual) continue
    const content = message.message.content
    if (typeof content === 'string') return detectBrowserIntent(content)
    if (content.some(block => block.type === 'tool_result')) continue
    return detectBrowserIntent(content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'))
  }
}

/** Prefer the browser used most recently when budgeting tool schemas. */
export function previousBrowserServer(messages: Message[]): string | undefined {
  const successful = new Set<string>()
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type !== 'assistant' && message.type !== 'user') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i]
      if (block.type === 'tool_result' && !block.is_error && typeof block.tool_use_id === 'string') {
        successful.add(block.tool_use_id)
      }
      if (block.type === 'tool_use' && successful.has(block.id) && typeof block.name === 'string') {
        const server = mcpInfoFromString(block.name)?.serverName
        if (server && DESKTOP_PLAYWRIGHT_SERVER_MODES.has(server)) return server
      }
    }
  }
}

const BROWSER_TOOL_BUDGET = 48
const CORE_BROWSER_TOOLS = [
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_tabs',
  'browser_take_screenshot', 'browser_wait_for', 'browser_hover', 'browser_close',
]

type NamedTool = Parameters<typeof getToolNameForPermissionCheck>[0]

/** Keep every eligible browser/mode selectable. The active server gets more
 * schemas after its first tool succeeds, while the other modes retain navigation. */
export function limitBrowserToolSchemas<T extends NamedTool>(tools: readonly T[], preferredServer?: string): readonly T[] {
  const groups = new Map<string, Array<{ tool: T; rank: number }>>()
  for (const tool of tools) {
    const mcp = mcpInfoFromString(getToolNameForPermissionCheck(tool))
    if (!mcp || !DESKTOP_PLAYWRIGHT_SERVER_MODES.has(mcp.serverName)) continue
    const group = groups.get(mcp.serverName) ?? []
    const priority = mcp.toolName ? CORE_BROWSER_TOOLS.indexOf(mcp.toolName) : -1
    group.push({ tool, rank: priority < 0 ? CORE_BROWSER_TOOLS.length : priority })
    groups.set(mcp.serverName, group)
  }
  const count = [...groups.values()].reduce((sum, group) => sum + group.length, 0)
  if (count <= BROWSER_TOOL_BUDGET) return tools

  const preferred = preferredServer ? groups.get(preferredServer) : undefined
  const preferredBudget = preferred ? Math.min(preferred.length, BROWSER_TOOL_BUDGET / 2) : 0
  const remainingPerServer = Math.floor((BROWSER_TOOL_BUDGET - preferredBudget) / Math.max(1, groups.size - Number(Boolean(preferred))))
  const omit = new Set<T>()
  for (const group of groups.values()) {
    const budget = group === preferred ? preferredBudget : remainingPerServer
    for (const { tool } of group.sort((a, b) => a.rank - b.rank).slice(budget)) omit.add(tool)
  }
  return tools.filter(tool => !omit.has(tool))
}

export function browserTurnRoute(
  intent: BrowserIntent | undefined,
  preference: 'auto' | DesktopBrowser,
  enabled = true,
) {
  const browser = preference === 'auto' ? intent?.browser : preference
  const conflicts = preference !== 'auto' && (intent?.bothBrowsers || (intent?.browser && intent.browser !== preference))
  const specs = browser ? [DESKTOP_PLAYWRIGHT_BROWSERS[browser]] : Object.values(DESKTOP_PLAYWRIGHT_BROWSERS)
  const servers: ReadonlySet<string> = new Set(enabled ? specs.flatMap(spec => intent?.mode
    ? [spec[intent.mode]]
    : [spec.headless, spec.visible]) : [])
  function toolError(name: string): string | undefined {
    const mcp = mcpInfoFromString(name)
    if (!mcp) return
    if (isPlaywrightMCPServer(mcp.serverName) && !servers.has(mcp.serverName)) {
      return 'This Playwright server does not match the browser or mode allowed for this turn.'
    }
    if (intent && (mcp.serverName === 'computer-use' ||
        (servers.has(mcp.serverName) && (mcp.toolName === 'browser_run_code_unsafe' || mcp.toolName === 'browser_install')))) {
      return 'Use the built-in Playwright MCP tools for this browser request.'
    }
  }
  return {
    hideTool: (name: string): boolean => toolError(name) !== undefined,
    toolError,
    prompt(tools: ReadonlyArray<NamedTool>): string {
      const navigation = tools.map(getToolNameForPermissionCheck).filter(name => {
        const mcp = mcpInfoFromString(name)
        return mcp?.toolName === 'browser_navigate' && servers.has(mcp.serverName)
      })
      const target = browser ? DESKTOP_PLAYWRIGHT_BROWSERS[browser].label : 'the installed browser that fits the request'
      const action = navigation.length > 0
        ? `Use ${target}. For navigation, call one of these Playwright MCP tools directly: ${navigation.join(', ')}. If the user has not specified a mode, choose headless or visible according to the task. Keep using that server for follow-up interaction.`
        : `The matching Playwright MCP tools for ${target} are unavailable. Tell the user and direct them to Settings → MCP to check the switch, local browser installation, and connection. Do not substitute another browser.`
      const conflict = conflicts ? ` Settings allow only ${target}. Tell the user their requested browser conflicts with this setting before substituting a browser.` : ''
      return `<browser-use-routing>Route browser launch, navigation and page interaction through Playwright MCP. ${action}${conflict} The configured command interpreter remains available for local prerequisites, such as resolving a shortcut, starting a local service, or checking readiness. Complete those steps before navigating to the service URL. Do not substitute desktop control, shell-based browser launch, or standalone Playwright code for browser MCP actions.</browser-use-routing>`
    },
  }
}

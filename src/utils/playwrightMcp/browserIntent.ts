import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import type { Message } from '../../types/message.js'
import {
  DESKTOP_PLAYWRIGHT_BROWSERS,
  DESKTOP_PLAYWRIGHT_SERVER_MODES,
  type BrowserMode,
  type DesktopBrowser,
} from './common.js'

const BROWSER_USE = /浏览器自动化|浏览器操作|\bbrowser[ -]use\b|\bplaywright(?:\s+mcp)?\b/i
const BRAND = /\b(?:google\s+)?chrome\b|\b(?:microsoft\s+)?(?:edge|msedge)\b/gi
const BRAND_ACTION = /(?:(?:打开|启动|关闭)(?:的是|一下|下)?|(?:换|切换)(?:到|成|为)?|(?:改|使)?用|通过|比较|对比|\b(?:open|launch|close|use|switch to|with|in|compare)(?:\s+the)?)\s*$/i
const NON_BROWSER = /^\s*(?:branch\b|extension\b|driver\b|分支|扩展|插件|驱动)/i
const BRAND_JOIN = /^\s*(?:和|与|及|以及|或者?|、|and|or|versus|vs\.?)\s*$/i
const NEGATED = /(?:不要|不需要|不使用|不用|不选|别|禁止|避免|而非|而不是|不是|代替|替代)\s*(?:(?:使用|用|选择|切换到|打开|启动|在)\s*)?$|\b(?:not|never|don't|without|instead of|rather than)\s+(?:(?:use|using|choose|open|launch|in|the)\s+)*$/i
const OPEN = /(?:(?:打开|启动)(?:的是|一下|下)?|\b(?:open|launch)(?:\s+the)?)\s*$/i
const IN_BROWSER = /^\s*(?:浏览器\s*)?(?:中|里|上)\s*(打开|启动|访问|进入|导航|点击|截图|输入|填写|滚动)/
const EXPLICIT_DESKTOP = /^(?:请\s*)?(?:使用|用|通过|use|using)?\s*(?:电脑操作|桌面操作|\bcomputer[ -]use\b)/i
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
  let opensBrowser = /(?:打开|启动)\s*浏览器|\b(?:open|launch)\s+(?:the\s+)?browser\b/i.test(text)
  for (const brand of text.matchAll(BRAND)) {
    const before = text.slice(0, brand.index)
    const after = text.slice(brand.index + brand[0].length)
    if (NEGATED.test(before) || NON_BROWSER.test(after)) continue
    const locationAction = /在\s*$/.test(before) && IN_BROWSER.exec(after)
    if (!requestedAlias && !BRAND_ACTION.test(before) && !locationAction &&
        !(brand.index === 0 && /^(?:\s*浏览器)?[.!。！]?\s*$/.test(after)) &&
        !(lastTargetEnd !== undefined && BRAND_JOIN.test(before.slice(lastTargetEnd)))) continue
    targets.add(/chrome/i.test(brand[0]) ? 'chrome' : 'msedge')
    lastTargetEnd = brand.index + brand[0].length
    opensBrowser ||= OPEN.test(before) || Boolean(locationAction && /打开|启动/.test(locationAction[1]!))
  }
  if (!requestedAlias && targets.size === 0 && !opensBrowser) return

  const modeMatch = [...text.matchAll(/无头|可见|有头|\b(?:headless|visible|headed)\b/gi)].at(-1)
  let mode: BrowserMode | undefined = opensBrowser ? 'visible' : undefined
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

export function desktopBrowserToolMode(name: string): BrowserMode | undefined {
  const mcp = mcpInfoFromString(name)
  return mcp && DESKTOP_PLAYWRIGHT_SERVER_MODES.get(mcp.serverName)
}

/** Follow-up interactions should keep the mode of the last successful browser tool. */
export function previousBrowserMode(messages: Message[]): BrowserMode | undefined {
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
        const mode = desktopBrowserToolMode(block.name)
        if (mode) return mode
      }
    }
  }
}

export function browserTurnRoute(
  intent: BrowserIntent,
  preference: 'auto' | DesktopBrowser,
) {
  const browser = intent.browser ?? (!intent.bothBrowsers && preference !== 'auto' ? preference : undefined)
  const specs = browser ? [DESKTOP_PLAYWRIGHT_BROWSERS[browser]] : Object.values(DESKTOP_PLAYWRIGHT_BROWSERS)
  const servers: ReadonlySet<string> = new Set(specs.flatMap(spec => intent.mode
    ? [spec[intent.mode]]
    : [spec.headless, spec.visible]))
  const hideTool = (name: string): boolean => {
    const mcp = mcpInfoFromString(name)
    return mcp?.serverName === 'computer-use' ||
      Boolean(mcp && DESKTOP_PLAYWRIGHT_SERVER_MODES.has(mcp.serverName) && (mcp.toolName === 'browser_run_code_unsafe' || mcp.toolName === 'browser_install'))
  }
  return {
    hideTool,
    prompt(tools: ReadonlyArray<{ name: string }>): string {
      const navigation = tools.filter(tool => {
        const mcp = mcpInfoFromString(tool.name)
        return mcp?.toolName === 'browser_navigate' && servers.has(mcp.serverName)
      }).map(tool => tool.name)
      const target = browser ? DESKTOP_PLAYWRIGHT_BROWSERS[browser].label : 'the installed browser that fits the request'
      const action = navigation.length > 0
        ? `Use ${target}. For navigation, call one of these Playwright MCP tools directly: ${navigation.join(', ')}. Keep using that server for this browser unless the user directs a switch.`
        : `The matching Playwright MCP tools for ${target} are unavailable. Tell the user and direct them to Settings → MCP to check the switch, local browser installation, and connection. Do not substitute another browser.`
      return `<browser-use-routing>Route browser launch, navigation and page interaction through Playwright MCP. ${action} The configured command interpreter remains available for local prerequisites, such as resolving a shortcut, starting a local service, or checking readiness. Complete those steps before navigating to the service URL. Do not substitute desktop control, shell-based browser launch, or standalone Playwright code for browser MCP actions.</browser-use-routing>`
    },
    toolError(name: string): string | undefined {
      const mcp = mcpInfoFromString(name)
      if (hideTool(name)) {
        return 'Use the built-in Playwright MCP tools for this browser request.'
      }
      if (mcp && DESKTOP_PLAYWRIGHT_SERVER_MODES.has(mcp.serverName) && !servers.has(mcp.serverName)) {
        return 'This Playwright server does not match the requested browser or mode. Use the server named in browser-use-routing.'
      }
    },
  }
}

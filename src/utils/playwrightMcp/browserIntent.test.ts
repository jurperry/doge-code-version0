import { expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import { browserTurnRoute, detectBrowserIntent, latestBrowserIntent, limitBrowserToolSchemas, previousBrowserServer } from './browserIntent.js'

const chromeVisible = { name: 'mcp__playwright-chrome-headed__browser_navigate' }
const edgeVisible = { name: 'mcp__playwright-edge-headed__browser_navigate' }
const edgeHeadless = { name: 'mcp__playwright-edge__browser_navigate' }
const navigate = [chromeVisible, edgeVisible, edgeHeadless]
const user = (content: string): Message => ({ type: 'user', message: { content } })

test.each(['浏览器自动化', '浏览器操作', 'Browser Use', 'browser use', 'playwright', 'playwright mcp'])('recognizes %s as Browser Use', alias => {
  expect(detectBrowserIntent(alias)).toEqual({ browser: undefined, bothBrowsers: false, mode: undefined })
  expect(detectBrowserIntent(`请使用${alias}，打开Edge浏览器，并进入bilibili`)).toEqual({
    browser: 'msedge', bothBrowsers: false, mode: undefined,
  })
})

test('honors the explicitly named browser in Auto', () => {
  const messages: Message[] = [user('使用浏览器自动化，打开Edge浏览器，并进入bilibili')]
  const first = browserTurnRoute(latestBrowserIntent(messages)!, 'auto')
  expect(first.prompt(navigate)).toContain(edgeVisible.name)
  expect(first.hideTool(chromeVisible.name)).toBe(true)
  expect(first.toolError(chromeVisible.name)).toBeTruthy()
  expect(first.toolError(edgeHeadless.name)).toBeUndefined()
  expect(first.toolError(edgeVisible.name)).toBeUndefined()
  expect(first.hideTool('mcp__computer-use__request_access')).toBe(true)
  for (const shell of ['Bash', 'PowerShell']) {
    expect(first.hideTool(shell)).toBe(false)
    expect(first.toolError(shell)).toBeUndefined()
  }

  messages.push(user('打开 Chrome 浏览器进入同一个网站'))
  const next = browserTurnRoute(latestBrowserIntent(messages)!, 'auto')
  expect(next.prompt(navigate)).toContain(chromeVisible.name)
  expect(next.toolError(edgeVisible.name)).toBeTruthy()
  expect(next.toolError(chromeVisible.name)).toBeUndefined()
})

test('Auto offers both browsers and a fixed preference takes priority', () => {
  const generic = detectBrowserIntent('Browser Use, open browser and visit example.com')!
  const auto = browserTurnRoute(generic, 'auto')
  expect(auto.prompt(navigate)).toContain(edgeVisible.name)
  expect(auto.prompt(navigate)).toContain(chromeVisible.name)
  expect(detectBrowserIntent('use Browser Use to open https://example.com/edge')?.browser).toBeUndefined()
  const named = browserTurnRoute(detectBrowserIntent('我让你打开的是Edge浏览器，并进入bilibili')!, 'chrome')
  expect(named.prompt(navigate)).toContain(chromeVisible.name)
  expect(named.prompt(navigate)).toContain('Settings allow only Chrome')
  expect(named.prompt([edgeVisible])).toContain('unavailable')
  expect(named.toolError(edgeVisible.name)).toBeTruthy()
  expect(browserTurnRoute(undefined, 'msedge').hideTool(chromeVisible.name)).toBe(true)
  expect(browserTurnRoute(undefined, 'msedge', false).hideTool(edgeHeadless.name)).toBe(true)
})

test('does not carry Browser Use into unrelated prompts or explicit desktop work', () => {
  expect(detectBrowserIntent('Playwright 和 Puppeteer 有什么区别？')).toBeUndefined()
  expect(detectBrowserIntent('不要使用浏览器自动化，分析这些记录')).toBeUndefined()
  expect(detectBrowserIntent('请用 Computer Use 点击 Edge 的本机对话框')).toBeUndefined()
  expect(detectBrowserIntent('use Bash to build the Chrome extension')).toBeUndefined()
  expect(detectBrowserIntent('switch to the edge branch and run the tests')).toBeUndefined()
  expect(detectBrowserIntent('在 edge 分支里打开项目文件')).toBeUndefined()
  expect(latestBrowserIntent([user('Browser Use'), user('读取 README.md')])).toBeUndefined()
})

test('recognizes direct launch, corrections, negation and comparison', () => {
  expect(detectBrowserIntent('Browser Use please')).toBeDefined()
  expect(detectBrowserIntent('Please open the Microsoft Edge browser')?.mode).toBeUndefined()
  for (const prompt of ['Use Edge, not Chrome', '不要用 Chrome，换成 Edge', '用 Edge 代替 Chrome', "Don't open Chrome; use Edge"]) {
    expect(detectBrowserIntent(prompt)?.browser).toBe('msedge')
  }
  expect(detectBrowserIntent('用 Edge，不要无头模式')?.mode).toBe('visible')
  expect(detectBrowserIntent('用 Edge 和 Chrome 分别打开同一页面')?.bothBrowsers).toBe(true)
  expect(detectBrowserIntent('打开浏览器访问网站')?.mode).toBeUndefined()
  expect(detectBrowserIntent('使用有头浏览器打开bilibili')?.mode).toBe('visible')
  expect(detectBrowserIntent('用无头浏览器访问本地页面')?.mode).toBe('headless')
  expect(detectBrowserIntent('Use a visible browser to open the page')?.mode).toBe('visible')
  expect(detectBrowserIntent('请在 Edge 浏览器中打开这个网址')).toMatchObject({ browser: 'msedge', mode: undefined })
  expect(detectBrowserIntent('在 Chrome 里访问这个网址')?.browser).toBe('chrome')
  expect(detectBrowserIntent('可以帮我打开一下 Edge 浏览器吗')).toMatchObject({ browser: 'msedge', mode: undefined })
  expect(detectBrowserIntent('请用可见的浏览器窗口打开网页')?.mode).toBe('visible')
  expect(detectBrowserIntent('切换为 Edge')?.browser).toBe('msedge')
})

test('only browser mode qualifiers affect routing', () => {
  expect(detectBrowserIntent('帮我打开无头浏览器访问网站，然后检查按钮是否可见')?.mode).toBe('headless')
  expect(detectBrowserIntent('请打开 Edge 并检查提交按钮是否可见')?.mode).toBeUndefined()
  expect(detectBrowserIntent('请用无头 Edge 打开网页')).toMatchObject({ browser: 'msedge', mode: 'headless' })
  expect(detectBrowserIntent('请用可见的 Edge 浏览器访问这个网站')).toMatchObject({ browser: 'msedge', mode: 'visible' })
  expect(detectBrowserIntent('Open Chrome in headless mode and confirm the button is visible')?.mode).toBe('headless')
})

test('finds the last browser server that actually ran successfully', () => {
  expect(previousBrowserServer([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: edgeVisible.name, id: 'success' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'success' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: edgeHeadless.name, id: 'denied' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'denied', is_error: true }] } },
  ])).toBe('playwright-edge-headed')
})

test('tool budget keeps both modes and brands and prioritizes the browser in use', () => {
  const servers = ['playwright-edge', 'playwright-edge-headed', 'playwright-chrome', 'playwright-chrome-headed']
  const browserTools = servers.flatMap(serverName => ['browser_navigate', ...Array.from({ length: 23 }, (_, i) => `tool${i}`)]
    .map(toolName => ({ name: `mcp__${serverName}__${toolName}` })))
  const bash = { name: 'Bash' }
  const chosen = limitBrowserToolSchemas([...browserTools, bash], 'playwright-edge-headed')
  expect(chosen.length).toBeLessThanOrEqual(49)
  expect(chosen).toContain(bash)
  for (const server of servers) expect(chosen).toContainEqual({ name: `mcp__${server}__browser_navigate` })
  expect(chosen.filter(tool => tool.name.startsWith('mcp__playwright-edge-headed__'))).toHaveLength(24)
})

test('browser intent leaves the command interpreter available even when the browser is unavailable', () => {
  const route = browserTurnRoute(detectBrowserIntent('使用浏览器自动化打开 C:\\Desktop\\本地应用.lnk')!, 'auto')
  expect(route.prompt([])).toContain('resolving a shortcut')
  expect(route.prompt([])).toContain('unavailable')
  expect(route.toolError('Bash')).toBeUndefined()
  expect(route.toolError('PowerShell')).toBeUndefined()
})

/**
 * Computer Use 端到端验证脚本（Windows 实机）。
 *
 * 验证链路：bindSessionContext（锁 gate）→ handleToolCall →
 * CLI executor → platforms/win32 后端，即 TUI 会话里一次真实
 * mcp__computer-use__* 工具调用的完整执行路径（不含权限对话框 UI）。
 *
 * 运行：bun run tools/computer-use-e2e.ts
 * 只做只读操作（screenshot / zoom / cursor_position），不动鼠标键盘。
 * 锁文件与截图落在 test/ 下的临时目录，结束即清理，不触碰 ~/.doge。
 */

process.env.CLAUDE_CONFIG_DIR = (() => {
  const { join } = require('path') as typeof import('path')
  return join(process.cwd(), 'test', 'tmp-cu-e2e-config')
})()

const { mkdirSync, rmSync, writeFileSync, readFileSync } = await import('fs')
const { join } = await import('path')

const TMP_DIR = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CODE_TMPDIR = TMP_DIR
process.env.TEMP = TMP_DIR
process.env.TMP = TMP_DIR

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

try {
  mkdirSync(TMP_DIR, { recursive: true })

  const { bindSessionContext, DEFAULT_GRANT_FLAGS } = await import(
    '@ant/computer-use-mcp'
  )
  const { getComputerUseHostAdapter } = await import(
    '../src/utils/computerUse/hostAdapter.js'
  )
  const { getChicagoCoordinateMode } = await import(
    '../src/utils/computerUse/gates.js'
  )
  const {
    checkComputerUseLock,
    tryAcquireComputerUseLock,
    releaseComputerUseLock,
  } = await import('../src/utils/computerUse/computerUseLock.js')

  // ── 0. MCP 协议层：client.ts 连接 in-process server 的真实路径 ──────
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { createLinkedTransportPair } = await import(
    '../src/services/mcp/InProcessTransport.js'
  )
  const { createComputerUseMcpServerForCli } = await import(
    '../src/utils/computerUse/mcpServer.js'
  )
  const server = await createComputerUseMcpServerForCli()
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  const mcpClient = new Client({ name: 'cu-e2e', version: '0' }, { capabilities: {} })
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)])
  const { tools } = await mcpClient.listTools()
  check(
    'MCP ListTools exposes the CU toolset',
    tools.length >= 20 && tools.some(t => t.name === 'request_access') && tools.some(t => t.name === 'screenshot'),
    `${tools.length} tools`,
  )
  await mcpClient.close()
  await server.close()

  // 与 wrapper.tsx 相同的锁接线（去掉 ESC 热键等 UI 部分）。
  const ctx = {
    getAllowedApps: () => [
      { bundleId: '*', displayName: 'e2e-verification', grantedAt: Date.now() },
    ],
    getGrantFlags: () => DEFAULT_GRANT_FLAGS,
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => undefined,
    isAborted: () => false,
    checkCuLock: async () => {
      const c = await checkComputerUseLock()
      switch (c.kind) {
        case 'free':
          return { holder: undefined, isSelf: false }
        case 'held_by_self':
          return { holder: 'e2e-self', isSelf: true }
        case 'blocked':
          return { holder: c.by, isSelf: false }
      }
    },
    acquireCuLock: async () => {
      const r = await tryAcquireComputerUseLock()
      if (r.kind === 'blocked') throw new Error(`lock held by ${r.by}`)
    },
  }

  const adapter = getComputerUseHostAdapter()
  const dispatch = bindSessionContext(
    adapter,
    getChicagoCoordinateMode(),
    ctx as any,
  )

  // ── 1. screenshot：全屏截图经 imageResize 预缩放回传 ─────────────────
  const shot = await dispatch('screenshot', {})
  const shotImage = (shot.content as any[]).find(c => c.type === 'image')
  check(
    'screenshot returns an image block',
    !shot.isError && !!shotImage?.data,
    shot.isError ? JSON.stringify(shot.content).slice(0, 200) : '',
  )
  if (shotImage?.data) {
    const shotPath = join(process.cwd(), 'test', 'cu-e2e-screenshot.jpg')
    writeFileSync(shotPath, Buffer.from(shotImage.data, 'base64'))
    console.log(`       screenshot saved: ${shotPath} (${shotImage.data.length} b64 chars, ${shot.screenshot?.width}x${shot.screenshot?.height})`)
  }

  // ── 2. save_to_disk：显式保存必须返回真实可读文件 ─────────────────────
  const saved = await dispatch('screenshot', { save_to_disk: true })
  const savedImage = (saved.content as any[]).find(c => c.type === 'image')
  const savedText = (saved.content as any[])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .find(text => text.startsWith('Screenshot saved to: '))
  const savedPath = savedText?.slice('Screenshot saved to: '.length)
  let saveMatches = false
  if (savedPath && savedImage?.data) {
    saveMatches = readFileSync(savedPath).equals(Buffer.from(savedImage.data, 'base64'))
  }
  check(
    'save_to_disk returns a readable JPEG at the reported path',
    !saved.isError && !!savedPath && saveMatches,
    savedPath ?? JSON.stringify(saved.content).slice(0, 200),
  )

  // ── 3. zoom：基于 lastScreenshot 的区域放大（同一 dispatcher 闭包） ──
  const zoomed = await dispatch('zoom', { region: [0, 0, 600, 400] })
  const zoomImage = (zoomed.content as any[]).find(c => c.type === 'image')
  check(
    'zoom crops the requested region',
    !zoomed.isError && !!zoomImage?.data,
    zoomed.isError ? JSON.stringify(zoomed.content).slice(0, 200) : '',
  )

  // ── 4. cursor_position：只读坐标查询 ────────────────────────────────
  const cursor = await dispatch('cursor_position', {})
  const cursorText = ((cursor.content as any[])?.[0]?.text ?? '') as string
  const xy = cursorText.match(/-?\d+/g)
  check(
    'cursor_position reports numeric coords',
    !cursor.isError && !!xy && xy.length >= 2,
    cursorText.slice(0, 120),
  )

  // ── 5. 连续全屏捕获：不得被冗余显示器枚举或旧窗口绑定阻断 ──────────
  const captureStart = Date.now()
  let capturesStable = true
  for (let i = 0; i < 10; i++) {
    const repeated = await dispatch('screenshot', {})
    capturesStable &&= !repeated.isError && repeated.content.some(item => item.type === 'image')
  }
  check('10 consecutive full-display screenshots remain stable', capturesStable, `${Date.now() - captureStart}ms`)

  // ── 6. 锁释放：回合结束 cleanup.ts 的路径 ───────────────────────────
  const released = await releaseComputerUseLock()
  check('computer-use lock released after turn', released, '')
} catch (e) {
  failures++
  console.error('[FAIL] e2e threw:', e)
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true })
  try {
    rmSync(join(process.cwd(), 'test', 'cu-e2e-screenshot.jpg'), { force: true })
  } catch {}
}

console.log(failures === 0 ? '\nE2E RESULT: ALL PASS' : `\nE2E RESULT: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

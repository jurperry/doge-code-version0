/**
 * E2E smoke for the IM remote-control daemon: mock Telegram Bot API +
 * fake session WebSocket client. Exercises pairing, prompt routing,
 * ask relay with callback picks, tool-tick summaries, agent notices and
 * turn reporting — without any real network or model.
 *
 * Run: bun run tools/e2e-im-remote.ts  (self-cleaning)
 */
import { spawn } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`(pass) ${name}`)
  } else {
    failures++
    console.error(`(fail) ${name} ${detail}`)
  }
}

type Sent = { method: string; body: any }
const sent: Sent[] = []
const pendingUpdates: any[] = []
let updateId = 1

function mkUpdate(u: Record<string, unknown>): void {
  pendingUpdates.push({ update_id: updateId++, ...u })
}

// --- Mock Telegram Bot API --------------------------------------------------
const mockApi = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const method = url.pathname.split('/').pop()!
    const body = req.method === 'POST' ? await req.json() : {}
    if (method === 'getUpdates') {
      const result = pendingUpdates.splice(0)
      return Response.json({ ok: true, result })
    }
    sent.push({ method, body })
    if (method === 'getMe') {
      return Response.json({ ok: true, result: { id: 1, username: 'doge_test_bot' } })
    }
    return Response.json({ ok: true, result: {} })
  },
})

// --- Config + daemon --------------------------------------------------------
const sandbox = await mkdtemp(join(tmpdir(), 'im-remote-e2e-'))
const configPath = join(sandbox, 'im-remote.json')
const webConfigPath = join(sandbox, 'im-remote-web.json')
const statusPath = join(sandbox, 'im-remote-status.json')
const daemonPort = 4700 + Math.floor(Math.random() * 200)
const webPort = 4900 + Math.floor(Math.random() * 90)

const config = {
  version: 1,
  enabled: true,
  platform: 'telegram',
  telegram: {
    botToken: 'TESTTOKEN',
    apiBase: `http://127.0.0.1:${mockApi.port}`,
  },
  allowedUsers: ['777'],
  autoMode: true,
  summaryEvery: 3,
  port: daemonPort,
  token: 'localtesttokenlocaltesttoken',
}
await writeFile(configPath, JSON.stringify(config, null, 2))

// QR web channel — separate file, token-gated (no pairing flow).
const webToken = 'webtesttokenwebtesttoken'
await writeFile(
  webConfigPath,
  JSON.stringify({ version: 1, enabled: true, port: webPort, token: webToken }, null, 2),
)

const daemon = spawn(
  process.execPath.includes('bun') ? process.execPath : 'bun',
  [join(ROOT, 'src/bootstrap-entry.ts'), 'im'],
  {
    env: {
      ...process.env,
      DOGE_IM_REMOTE_CONFIG: configPath,
      DOGE_IM_REMOTE_WEB_CONFIG: webConfigPath,
      DOGE_IM_REMOTE_STATUS: statusPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let daemonOut = ''
daemon.stdout.on('data', d => (daemonOut += d))
daemon.stderr.on('data', d => (daemonOut += d))

async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

async function waitForAndRead<T>(read: () => Promise<T | null>, ms = 8000): Promise<T | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}

function sentTexts(): string {
  return sent
    .filter(s => s.method === 'sendMessage')
    .map(s => String(s.body.text ?? ''))
    .join('\n---\n')
}

try {
  const started = await waitFor(() => daemonOut.includes('已启动'))
  check('daemon starts against mock Telegram', started, daemonOut)

  // --- Fake session client --------------------------------------------------
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/?token=${config.token}`)
  const inbound: any[] = []
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = e => reject(e)
    setTimeout(() => reject(new Error('ws timeout')))
  })
  ws.onmessage = ev => {
    try {
      inbound.push(JSON.parse(String(ev.data)))
    } catch {}
  }
  ws.send(JSON.stringify({ t: 'hello', sessionId: 's1', kind: 'headless', label: 'e2e', cwd: sandbox, pid: process.pid }))
  await new Promise(r => setTimeout(r, 300))

  // --- status command from paired user --------------------------------------
  mkUpdate({ message: { message_id: 1, text: '/status', chat: { id: 555 }, from: { id: 777 } } })
  await waitFor(() => sent.some(s => s.method === 'sendMessage'))
  check('/status answered to IM', sentTexts().includes('远程控制状态'))
  check('/status shows attached session', sentTexts().includes('e2e'))

  // --- tool ticks + summary every 3 ------------------------------------------
  for (let i = 1; i <= 3; i++) {
    ws.send(JSON.stringify({ t: 'tools', count: i, last: 'Edit' }))
  }
  await waitFor(() => sentTexts().includes('3 次工具调用'))
  check('tool-tick summary fires on cadence', true)

  // --- agent teams notice -----------------------------------------------------
  ws.send(JSON.stringify({ t: 'agent', ev: 'teams_on' }))
  await waitFor(() => sentTexts().includes('agent-teams'))
  check('agent-teams notice relayed', true)

  // --- ask relay + callback pick ---------------------------------------------
  ws.send(
    JSON.stringify({
      t: 'perm_req',
      id: 'ask1',
      tool: 'AskUserQuestion',
      title: '选方案',
      detail: '{}',
      ask: { question: '选方案', options: ['甲', '乙'], multi: false },
    }),
  )
  await waitFor(() => sent.some(s => s.body?.reply_markup?.inline_keyboard))
  check('ask rendered with inline keyboard', true)
  mkUpdate({
    callback_query: { id: 'cb1', data: 'pick:2', from: { id: 777 } },
  })
  await waitFor(() => inbound.some(f => f.t === 'perm_res' && f.id === 'ask1'))
  const pickFrame = inbound.find(f => f.t === 'perm_res' && f.id === 'ask1')
  check('callback pick reaches session with picks', JSON.stringify(pickFrame?.picks) === '[2]', JSON.stringify(pickFrame))

  // --- prompt routing ----------------------------------------------------------
  mkUpdate({ message: { message_id: 2, text: '帮我看看主分支', chat: { id: 555 }, from: { id: 777 } } })
  await waitFor(() => inbound.some(f => f.t === 'prompt'))
  check(
    'IM prompt routed to session verbatim',
    inbound.find(f => f.t === 'prompt')?.text === '帮我看看主分支',
  )

  // --- turn report --------------------------------------------------------------
  ws.send(JSON.stringify({ t: 'turn', aborted: false, text: '搞定', durationMs: 3000 }))
  await waitFor(() => sentTexts().includes('回合完成') && sentTexts().includes('搞定'))
  check('turn result relayed to IM', true)

  // --- unpaired user gets pairing hint ------------------------------------------
  const before = sent.length
  mkUpdate({ message: { message_id: 3, text: 'hi', chat: { id: 556 }, from: { id: 888 } } })
  await waitFor(() => sent.length > before)
  check('unpaired user told to pair', sentTexts().includes('未配对'))

  // --- pairing flow (code minted by the daemon via monitor regen_pair) ------
  const pairMonitor = new WebSocket(`ws://127.0.0.1:${daemonPort}/?token=${config.token}`)
  await new Promise<void>(resolve => {
    pairMonitor.onopen = () => resolve()
    setTimeout(resolve, 3000)
  })
  pairMonitor.send(JSON.stringify({ t: 'hello', sessionId: 'mon2', kind: 'monitor', label: '', cwd: '', pid: 0 }))
  await new Promise(r => setTimeout(r, 200))
  pairMonitor.send(JSON.stringify({ t: 'regen_pair' }))
  const pairCode = await waitForAndRead(async () => {
    const onDisk = JSON.parse(await readFile(configPath, 'utf8'))
    return typeof onDisk.pair?.code === 'string' ? onDisk.pair.code : null
  })
  check('monitor regen_pair mints a code', !!pairCode)
  mkUpdate({ message: { message_id: 4, text: `/pair ${pairCode}`, chat: { id: 556 }, from: { id: 888 } } })
  await waitFor(() => sentTexts().includes('配对成功'))
  const persisted = JSON.parse(await readFile(configPath, 'utf8'))
  check('pairing persists allowed user', persisted.allowedUsers.includes('888'))
  check('pair code cleared after use', persisted.pair === undefined)
  pairMonitor.close()

  // Newly paired user can now steer the session.
  const promptsBefore = inbound.filter(f => f.t === 'prompt').length
  mkUpdate({ message: { message_id: 5, text: '再来一轮', chat: { id: 556 }, from: { id: 888 } } })
  await waitFor(() => inbound.filter(f => f.t === 'prompt').length > promptsBefore)
  check('newly paired user prompt routed', true)

  // --- permission allow via text command --------------------------------------------
  ws.send(
    JSON.stringify({ t: 'perm_req', id: 'perm1', tool: 'Bash', title: 'run tests', detail: 'npm test' }),
  )
  await waitFor(() => sent.some(s => s.body?.text?.includes('需要授权')))
  mkUpdate({ message: { message_id: 6, text: '/allow', chat: { id: 555 }, from: { id: 777 } } })
  await waitFor(() => inbound.some(f => f.t === 'perm_res' && f.id === 'perm1' && f.behavior === 'allow'))
  check('/allow answers pending permission', true)

  // --- status file + monitor frame ----------------------------------------------------
  const status = JSON.parse(await readFile(statusPath, 'utf8'))
  check('status file lists session', status.sessions?.some((s: any) => s.sessionId === 's1'))

  const monitor = new WebSocket(`ws://127.0.0.1:${daemonPort}/?token=${config.token}`)
  const monitorInbound: any[] = []
  await new Promise<void>(resolve => {
    monitor.onopen = () => resolve()
    setTimeout(resolve, 3000)
  })
  monitor.onmessage = ev => {
    try {
      monitorInbound.push(JSON.parse(String(ev.data)))
    } catch {}
  }
  monitor.send(JSON.stringify({ t: 'hello', sessionId: 'mon', kind: 'monitor', label: '', cwd: '', pid: 0 }))
  await waitFor(() => monitorInbound.some(f => f.t === 'status'))
  check('monitor receives status broadcast', monitorInbound.some(f => f.t === 'status' && f.running === true))
  monitor.close()

  // --- bad token rejected ---------------------------------------------------------------
  let badRejected = false
  await new Promise<void>(resolve => {
    const bad = new WebSocket(`ws://127.0.0.1:${daemonPort}/?token=WRONG`)
    bad.onopen = () => {
      badRejected = false
      resolve()
    }
    bad.onerror = () => {
      badRejected = true
      resolve()
    }
  })
  check('bad token rejected by daemon', badRejected)

  // --- QR web channel ---------------------------------------------------------
  const page = await fetch(`http://127.0.0.1:${webPort}/`)
  const pageHtml = await page.text()
  check('web channel serves embedded chat page', pageHtml.includes('Doge Code 远程控制'), pageHtml.slice(0, 80))

  const webWs = new WebSocket(`ws://127.0.0.1:${webPort}/?token=${webToken}`)
  const webInbound: any[] = []
  await new Promise<void>((resolve, reject) => {
    webWs.onopen = () => resolve()
    webWs.onerror = e => reject(e)
    setTimeout(() => reject(new Error('web ws timeout')), 5000)
  })
  webWs.onmessage = ev => {
    try {
      webInbound.push(JSON.parse(String(ev.data)))
    } catch {}
  }
  webWs.send(JSON.stringify({ t: 'hello', clientId: 'phone-1' }))
  await waitFor(() => webInbound.some(f => f.t === 'im' && String(f.text).includes('已连接')))

  // Token-gated: no pairing required — the page client drives directly.
  webWs.send(JSON.stringify({ t: 'msg', text: '网页端发来的任务' }))
  await waitFor(() => inbound.some(f => f.t === 'prompt' && f.text === '网页端发来的任务'))
  check('web prompt routed without pairing', true)

  // Dual-channel broadcast: turn results reach BOTH Telegram and the page.
  ws.send(JSON.stringify({ t: 'turn', aborted: false, text: '双频道广播', durationMs: 100 }))
  await waitFor(() => webInbound.some(f => f.t === 'im' && String(f.text).includes('双频道广播')))
  check('turn broadcast reaches web page too', true)

  // Permission options render as page buttons; a button click answers.
  ws.send(
    JSON.stringify({ t: 'perm_req', id: 'wp1', tool: 'Bash', title: 'rm tests', detail: 'rm -rf test' }),
  )
  await waitFor(() => webInbound.some(f => f.t === 'im' && Array.isArray(f.options) && f.options.length > 0))
  const optFrame = webInbound.find(f => f.t === 'im' && Array.isArray(f.options))
  check('permission options pushed to page', optFrame?.options?.some((o: any) => o.data === 'allow'))
  // 按钮点击在页面侧映射回等价指令文本（/allow）——按协议同源验证
  webWs.send(JSON.stringify({ t: 'msg', text: '/allow' }))
  await waitFor(() => inbound.some(f => f.t === 'perm_res' && f.id === 'wp1' && f.behavior === 'allow'))
  check('web /allow answers pending permission', true)

  // no_session: prompt with no session held + monitor notified, then flushed
  // to the first late-attaching session (remote wake-up chain).
  ws.close()
  await new Promise(r => setTimeout(r, 400))
  const wakeMonitor = new WebSocket(`ws://127.0.0.1:${daemonPort}/?token=${config.token}`)
  const wakeMonitorInbound: any[] = []
  await new Promise<void>(resolve => {
    wakeMonitor.onopen = () => resolve()
    setTimeout(resolve, 3000)
  })
  wakeMonitor.onmessage = ev => {
    try {
      wakeMonitorInbound.push(JSON.parse(String(ev.data)))
    } catch {}
  }
  wakeMonitor.send(JSON.stringify({ t: 'hello', sessionId: 'mon3', kind: 'monitor', label: '', cwd: '', pid: 0 }))
  await new Promise(r => setTimeout(r, 200))
  webWs.send(JSON.stringify({ t: 'msg', text: '唤起我' }))
  await waitFor(() => wakeMonitorInbound.some(f => f.t === 'no_session'))
  check('monitor told no_session for wake-up', wakeMonitorInbound.find(f => f.t === 'no_session')?.text === '唤起我')
  await waitFor(() => webInbound.some(f => f.t === 'im' && String(f.text).includes('没有已接入的会话')))
  check('no-session reply explains wake-up', true)

  const ws2 = new WebSocket(`ws://127.0.0.1:${daemonPort}/?token=${config.token}`)
  const inbound2: any[] = []
  await new Promise<void>(resolve => {
    ws2.onopen = () => resolve()
    setTimeout(resolve, 3000)
  })
  ws2.onmessage = ev => {
    try {
      inbound2.push(JSON.parse(String(ev.data)))
    } catch {}
  }
  ws2.send(JSON.stringify({ t: 'hello', sessionId: 's2', kind: 'headless', label: 'woken', cwd: sandbox, pid: process.pid }))
  await waitFor(() => inbound2.some(f => f.t === 'prompt' && f.text === '唤起我'))
  check('held prompt flushed to late session', true)
  await waitFor(() => webInbound.some(f => f.t === 'im' && String(f.text).includes('会话已接入')))
  check('web told the held prompt is being handled', true)

  // Monitor status frame carries the web channel URL (QR payload source).
  const statusFrame = wakeMonitorInbound.find(f => f.t === 'status')
  check(
    'status frame carries webUrl',
    typeof statusFrame?.webUrl === 'string' && statusFrame.webUrl.startsWith('http://') && statusFrame.webUrl.includes('#t='),
    JSON.stringify(statusFrame?.webUrl),
  )
  wakeMonitor.close()
  webWs.close()
  ws2.close()
} finally {
  daemon.kill()
  mockApi.stop(true)
  await rm(sandbox, { recursive: true, force: true }).catch(() => {})
}

console.log(failures === 0 ? '\nE2E OK' : `\nE2E FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)

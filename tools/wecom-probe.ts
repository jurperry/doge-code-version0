/**
 * wecom 适配器 mock-WSS 金样例探针（0.2.94）：协议帧对照官方
 * @wecom/aibot-node-sdk 行为，本地起 Bun.serve ws:// 模拟服务器逐帧验证。
 * Run: bun run tools/wecom-probe.ts (self-cleaning)
 */
import { WecomAdapter } from '../src/utils/imRemote/adapters/wecom.js'
import type { ImInboundMessage } from '../src/utils/imRemote/types.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`(pass) ${name}` + (detail ? ` — ${detail}` : ''))
  } else {
    fail++
    console.log(`(FAIL) ${name}` + (detail ? ` — ${detail}` : ''))
  }
}

type ServerFrame = {
  cmd?: string
  headers?: { req_id?: string }
  body?: Record<string, unknown>
  errcode?: number
  errmsg?: string
}

const PORT = 4891

async function main(): Promise<void> {
  // ---- mock 服务器：记录入站帧、按需回 ack / 推回调 ----
  const inbound: ServerFrame[] = []
  let subscribeReqId = ''
  let callbackReqId = ''
  const server = Bun.serve<{ tag: string }>({
    port: PORT,
    hostname: '127.0.0.1',
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('ws only', { status: 426 })),
    websocket: {
      open: ws => {
        ws.subscribe('all')
      },
      message: (ws, raw) => {
        const frame = JSON.parse(String(raw)) as ServerFrame
        inbound.push(frame)
        if (frame.cmd === 'aibot_subscribe') {
          subscribeReqId = frame.headers?.req_id ?? ''
          ws.send(JSON.stringify({ headers: { req_id: subscribeReqId }, errcode: 0 }))
          return
        }
        if (frame.cmd === 'ping') {
          ws.send(JSON.stringify({ headers: { req_id: frame.headers?.req_id ?? '' }, errcode: 0 }))
          return
        }
        if (frame.cmd === 'aibot_respond_msg' || frame.cmd === 'aibot_send_msg') {
          // 默认回成功 ack；测试可改 injectedAckErrcode
          ws.send(
            JSON.stringify({ headers: { req_id: frame.headers?.req_id ?? '' }, errcode: injectedAckErrcode }),
          )
        }
      },
    },
  })
  let injectedAckErrcode = 0

  const logs: string[] = []
  const messages: ImInboundMessage[] = []
  let stoppedReason = ''
  const adapter = new WecomAdapter(
    { botId: 'bot-123', secret: 'sec-456', wsBase: `ws://127.0.0.1:${PORT}` },
    line => {
      logs.push(line)
    },
    { handshakeTimeoutMs: 700, reconnectBaseMs: 150 },
  )
  await adapter.start({
    onMessage: msg => messages.push(msg),
    onStopped: reason => {
      stoppedReason = reason
    },
  })
  await sleep(300)

  // 1. subscribe 帧形状
  const sub = inbound.find(f => f.cmd === 'aibot_subscribe')
  check(
    'connects and sends aibot_subscribe with credentials + req_id',
    !!sub && sub.body?.bot_id === 'bot-123' && sub.body?.secret === 'sec-456' && !!sub.headers?.req_id?.startsWith('aibot_subscribe'),
  )

  // 2. 认证成功后出站可用：先模拟一条入站回调建立 recentCallback，再 sendText 应透传 req_id
  callbackReqId = 'callback_req_from_server_001'
  const cbFrame = {
    cmd: 'aibot_msg_callback',
    headers: { req_id: callbackReqId },
    body: {
      msgid: 'm-1',
      chattype: 'single',
      from: { userid: 'user-9' },
      msgtype: 'text',
      text: { content: '/status' },
    },
  }
  server.publish('all', JSON.stringify(cbFrame))
  await sleep(200)
  check(
    'inbound aibot_msg_callback routed to onMessage (single chat)',
    messages.length === 1 && messages[0].text === '/status' && messages[0].userId === 'user-9',
    JSON.stringify(messages[0] ?? null),
  )

  // 3. msgid 去重
  server.publish('all', JSON.stringify(cbFrame))
  await sleep(200)
  check('duplicate msgid dropped', messages.length === 1, `count=${messages.length}`)

  // The daemon owns authorization; incoming callbacks alone cannot claim
  // the outbound chat. Simulate its post-pair bind before testing replies.
  await adapter.sendText('尚未配对')
  check('unpaired inbound cannot receive outbound', !inbound.some(f => f.cmd === 'aibot_respond_msg'))
  check('authorized bind claims outbound chat', adapter.bindChat(messages[0].chatId, { force: true }))

  // 4. sendText 透传回调 req_id（respond_msg，24h 窗口）
  await adapter.sendText('第一条回复')
  await sleep(150)
  const resp = inbound.find(f => f.cmd === 'aibot_respond_msg')
  check(
    'sendText replies via aibot_respond_msg with passthrough req_id + markdown',
    !!resp && resp.headers?.req_id === callbackReqId && (resp.body?.markdown as { content?: string })?.content === '第一条回复',
  )

  // 5. 出站 ack errcode≠0 落日志
  injectedAckErrcode = 40050
  await adapter.sendText('第二条回复')
  await sleep(150)
  check(
    'outbound ack errcode surfaces in adapter log',
    logs.some(l => l.includes('出站被拒') && l.includes('40050')),
    logs.slice(-2).join(' | '),
  )
  injectedAckErrcode = 0

  // 6. 串行节流：连发三条，入站 respond 帧间隔 ≥ 120ms（允许 20ms 抖动）
  const before = inbound.filter(f => f.cmd === 'aibot_respond_msg').length
  const t0 = Date.now()
  await Promise.all([adapter.sendText('a'), adapter.sendText('b'), adapter.sendText('c')])
  const stamps = inbound
    .slice()
    .reverse()
    .filter(f => f.cmd === 'aibot_respond_msg')
    .slice(0, 3)
  await sleep(100)
  check(
    'concurrent sendText serialized by rate-limit queue (>=120ms apart)',
    Date.now() - t0 >= 240 && inbound.filter(f => f.cmd === 'aibot_respond_msg').length >= before + 3,
    `elapsed=${Date.now() - t0}ms stamps=${stamps.length}`,
  )

  // 7. disconnected_event → onStopped 终态回传（daemon 据此置 running=false）
  server.publish(
    'all',
    JSON.stringify({
      cmd: 'aibot_event_callback',
      body: { event: { eventtype: 'disconnected_event' } },
    }),
  )
  await sleep(200)
  check(
    'disconnected_event fires onStopped (terminal, no reconnect)',
    stoppedReason.includes('顶替') && logs.some(l => l.includes('disconnected_event')),
    stoppedReason,
  )
  const inboundAfterStop = inbound.length
  await sleep(400)
  check('no reconnect attempt after terminal event', inbound.length === inboundAfterStop)

  // 8. 握手超时：换新适配器连一个「不回 ack」的口
  const silent = Bun.serve({
    port: PORT + 1,
    hostname: '127.0.0.1',
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('x', { status: 426 })),
    websocket: { message: () => {} },
  })
  const silentLogs: string[] = []
  const adapter2 = new WecomAdapter(
    { botId: 'b', secret: 's', wsBase: `ws://127.0.0.1:${PORT + 1}` },
    line => silentLogs.push(line),
    { handshakeTimeoutMs: 400, reconnectBaseMs: 120 },
  )
  await adapter2.start({ onMessage: () => {} })
  // 时间线：~400ms 首次超时 → close(退避 120ms) → ~520ms 重连 → ~920ms
  // 二次超时 → close(退避 240ms)。给足两轮。
  await sleep(1400)
  check(
    'subscribe without ack times out and reconnects',
    silentLogs.some(l => l.includes('无应答')) && silentLogs.filter(l => l.includes('无应答')).length >= 2,
    silentLogs.join(' | '),
  )
  adapter2.stop()

  adapter.stop()
  server.stop(true)
  silent.stop(true)
  await sleep(200)

  console.log(`\n${fail === 0 ? 'WECOM PROBE OK' : 'WECOM PROBE FAIL'}: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('probe crashed:', err)
  process.exit(1)
})

// 飞书长连接探针：pbbp2 帧编解码 golden 对拍 + mock 长连接服务器全链路。
// 运行：bun run test/feishu-ws-probe.ts（自清理，不触碰真实 ~/.doge）
//
// golden 向量由官方 @larksuiteoapi/node-sdk 的 proto-buf/pbbp2.js +
// protobufjs 生成（见 doge-code-app test/lark-ws-ref/gen-golden.mjs），
// 用于钉死手写编解码器的字节格式；mock 服务器复用同一编解码器做自洽回环。
import {
  decodeFeishuFrame,
  encodeFeishuFrame,
  feishuHeaderValue,
} from '../src/utils/imRemote/adapters/feishuProto.js'
import { FeishuLongconn } from '../src/utils/imRemote/adapters/feishuLongconn.js'
import { FeishuAdapter } from '../src/utils/imRemote/adapters/feishu.js'
import { readFileSync } from 'fs'
import { join } from 'path'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}
function hex(u8: Uint8Array): string {
  return Buffer.from(u8).toString('hex')
}
function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'))
}

// ---------------------------------------------------------------------------
// ① golden 对拍（官方编解码器字节基准）
// ---------------------------------------------------------------------------
console.log('① pbbp2 golden vectors')
const GOLDEN = {
  ping: '0800100018c0c40720002a0c0a0474797065120470696e67',
  event:
    '0807100818e70720012a0d0a047479706512056576656e742a150a0a6d6573736167655f696412076d73672d6162632a080a0373756d1201322a080a037365711201312a100a0874726163655f6964120474722d3132046a736f6e3a056576656e7442167b2261223a312c22e4b8ade69687223a22ceb27d227d4a0b6c6f6769642d6e65772d31',
  ack: '08011002182a20012a0d0a047479706512056576656e742a0b0a0662697a5f7274120135420c7b22636f6465223a3230307d',
  pong: '08001000180120002a0c0a04747970651204706f6e6742527b2250696e67496e74657276616c223a33302c225265636f6e6e656374436f756e74223a2d312c225265636f6e6e656374496e74657276616c223a36302c225265636f6e6e6563744e6f6e6365223a33307d',
  empty: '0800100018002000',
}
{
  const ping = decodeFeishuFrame(fromHex(GOLDEN.ping))
  check(
    'decode golden ping',
    ping.service === 123456 && ping.method === 0 && feishuHeaderValue(ping, 'type') === 'ping' && ping.headers.length === 1,
    JSON.stringify(ping),
  )
  check(
    'encode golden ping',
    hex(
      encodeFeishuFrame({
        SeqID: 0,
        LogID: 0,
        service: 123456,
        method: 0,
        headers: [{ key: 'type', value: 'ping' }],
      }),
    ) === GOLDEN.ping,
  )
  const event = decodeFeishuFrame(fromHex(GOLDEN.event))
  check(
    'decode golden event',
    event.SeqID === 7 &&
      event.LogID === 8 &&
      event.service === 999 &&
      event.method === 1 &&
      feishuHeaderValue(event, 'message_id') === 'msg-abc' &&
      feishuHeaderValue(event, 'sum') === '2' &&
      feishuHeaderValue(event, 'seq') === '1' &&
      event.payloadEncoding === 'json' &&
      event.payloadType === 'event' &&
      event.LogIDNew === 'logid-new-1' &&
      Buffer.from(event.payload!).toString('utf8') === '{"a":1,"中文":"β}"}',
    JSON.stringify({ ...event, payload: event.payload && Buffer.from(event.payload).toString() }),
  )
  check(
    'encode golden empty (zero fields still written)',
    hex(encodeFeishuFrame({ SeqID: 0, LogID: 0, service: 0, method: 0, headers: [] })) === GOLDEN.empty,
  )
  const pong = decodeFeishuFrame(fromHex(GOLDEN.pong))
  check(
    'decode golden pong payload config',
    JSON.parse(Buffer.from(pong.payload!).toString('utf8')).PingInterval === 30,
  )
}

// 真实抓包回归：2026-10-01 实连飞书捕获的 pong 帧（含 id≥10 扩展字段与
// frontier/traceparent 头）——钉死 skip() 的长度前缀消费（+= 求值顺序坑）
{
  const real = new Uint8Array(readFileSync(join(import.meta.dir, 'real-feishu-pong.bin')))
  const f = decodeFeishuFrame(real)
  const cfg = f.payload ? (JSON.parse(Buffer.from(f.payload).toString('utf8')) as { PingInterval?: number }) : {}
  check(
    'real captured pong decodes (unknown fields skipped)',
    f.method === 0 && feishuHeaderValue(f, 'type') === 'pong' && feishuHeaderValue(f, 'code') === '0' && cfg.PingInterval === 90,
    JSON.stringify({ method: f.method, type: feishuHeaderValue(f, 'type'), cfg }),
  )
}

// ---------------------------------------------------------------------------
// ② mock 长连接服务器 + 适配器全链路
// ---------------------------------------------------------------------------
console.log('② mock 服务器全链路')
const PORT = 4830
let endpointCalls = 0
let lastEndpointBody: any = null
let pings = 0
let acks = 0
let lastAckFrame: ReturnType<typeof decodeFeishuFrame> | null = null
const sockets = new Set<any>()
let pollItems: any[] = []
const restSends: Array<{ receive_id: string; content: string }> = []

function controlFrame(type: string, payload?: Uint8Array): Uint8Array {
  return encodeFeishuFrame({
    SeqID: 0,
    LogID: 0,
    service: 77,
    method: 0,
    headers: [{ key: 'type', value: type }],
    ...(payload ? { payload } : {}),
  })
}
function eventFrame(messageId: string, seq: number, sum: number, payload: Uint8Array): Uint8Array {
  return encodeFeishuFrame({
    SeqID: 0,
    LogID: 0,
    service: 77,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: messageId },
      { key: 'sum', value: String(sum) },
      { key: 'seq', value: String(seq) },
      { key: 'trace_id', value: 'trace-' + messageId },
    ],
    payload,
  })
}
function receiveEventPayload(messageId: string, chatId: string, text: string, openId = 'ou_9'): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', event_id: 'ev-' + messageId, app_id: 'cli_0123456789abcdef' },
      event: {
        sender: { sender_id: { open_id: openId }, sender_type: 'user' },
        message: {
          message_id: messageId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text }),
        },
      },
    }),
  )
}

const mock = Bun.serve({
  port: PORT,
  fetch: async (req, server) => {
    const path = new URL(req.url).pathname
    if (path === '/ws') {
      if (server.upgrade(req)) return undefined
      return new Response('upgrade failed', { status: 400 })
    }
    if (path === '/callback/ws/endpoint') {
      endpointCalls++
      lastEndpointBody = await req.json()
      return Response.json({
        code: 0,
        data: {
          URL: `ws://127.0.0.1:${PORT}/ws?device_id=dev1&service_id=77`,
          ClientConfig: { PingInterval: 1, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 },
        },
      })
    }
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return Response.json({ code: 0, tenant_access_token: 'tn-probe', expire: 3600 })
    }
    if (path === '/open-apis/im/v1/messages' && req.method === 'POST') {
      // 必须先读完请求体再响应——响应先回、body 未消费时连接可能被回收，
      // req.json() 会以 "connection closed" 挂掉（首轮探针的 AbortError 根因）
      const body = await req.json()
      restSends.push({ receive_id: body.receive_id, content: body.content })
      return Response.json({ code: 0, data: { message_id: 'om-out-' + restSends.length } })
    }
    if (path === '/open-apis/im/v1/messages') {
      return Response.json({ code: 0, data: { items: pollItems, has_more: false } })
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      sockets.add(ws)
      console.log(`    [mock-ws] open (${sockets.size} live)`)
    },
    message(ws, data) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as any)
      const frame = decodeFeishuFrame(bytes)
      const type = feishuHeaderValue(frame, 'type')
      console.log(`    [mock-ws] recv method=${frame.method} type=${type ?? ''} mid=${feishuHeaderValue(frame, 'message_id') ?? ''}`)
      if (frame.method === 0 && type === 'ping') {
        pings++
        ws.send(
          controlFrame(
            'pong',
            new TextEncoder().encode(
              JSON.stringify({ PingInterval: 1, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 }),
            ),
          ),
        )
        return
      }
      if (frame.method === 1) {
        const payload = frame.payload ? Buffer.from(frame.payload).toString('utf8') : ''
        if (payload.includes('"code":200')) {
          acks++
          lastAckFrame = frame
        }
      }
    },
    close(ws) {
      sockets.delete(ws)
      console.log(`    [mock-ws] close (${sockets.size} live)`)
    },
  },
})

// endpoint body 记录在 lastEndpointBody（fetch handler 内 await req.json()）。

const inbound: Array<{ userId: string; chatId: string; text: string }> = []
const logs: string[] = []
const DEBUG = !!process.env.PROBE_DEBUG
const debugLog = (line: string) => {
  if (DEBUG) console.log(`    [probe] ${line}`)
}
// chatId 留空——顺带验证发送目标回退到最近收到消息的会话
const adapter = new FeishuAdapter(
  {
    appId: 'cli_0123456789abcdef',
    appSecret: 'probe-secret',
    apiBase: `http://127.0.0.1:${PORT}`,
    chatId: '',
  },
  line => logs.push(line),
)
if (DEBUG) {
  const proto = FeishuAdapter.prototype as any
  const origHre = proto.handleReceiveEvent
  proto.handleReceiveEvent = function (ev: unknown) {
    console.log('    [hre] enter:', JSON.stringify(ev)?.slice(0, 300))
    origHre.call(this, ev)
    console.log('    [hre] done')
  }
  const origTake = proto.takeInbound
  proto.takeInbound = function (...args: unknown[]) {
    const r = origTake.apply(this, args)
    console.log(`    [take] ${String(args[0])} → ${JSON.stringify(r)}`)
    return r
  }
}
await adapter.start({
  onMessage: m => {
    inbound.push({ userId: m.userId, chatId: m.chatId, text: m.text })
    debugLog(`onMessage ${m.text}`)
  },
})

async function waitFor(desc: string, fn: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await new Promise(r => setTimeout(r, 100))
  }
  console.log(`    (timeout waiting: ${desc})`)
  return false
}

// 协商 + 握手 + ping
check('endpoint negotiated', await waitFor('endpoint', () => endpointCalls >= 1))
check(
  'endpoint body credentials',
  lastEndpointBody?.AppID === 'cli_0123456789abcdef' && lastEndpointBody?.AppSecret === 'probe-secret',
  JSON.stringify(lastEndpointBody),
)
check('ws opened + ping arrived', await waitFor('ping', () => pings >= 1), `pings=${pings}`)

// 单片事件 → onMessage + ACK
;(mock as any).publish = (messageId: string, chatId: string, text: string) => {
  const payload = receiveEventPayload(messageId, chatId, text)
  debugLog(`publish ${messageId} to ${sockets.size} sockets`)
  for (const ws of sockets) {
    try {
      ws.send(eventFrame(messageId, 0, 1, payload))
    } catch (err) {
      debugLog(`publish send failed: ${String(err)}`)
    }
  }
}
;(mock as any).publish('om_1', 'oc_1', '/status')
check(
  'event → onMessage',
  await waitFor('event om_1', () => inbound.some(m => m.text === '/status')),
  JSON.stringify(inbound),
)
{
  const got = inbound.find(m => m.text === '/status')
  check('event fields', !!got && got.userId === 'ou_9' && got.chatId === 'oc_1', JSON.stringify(got))
}
check('event acked', await waitFor('ack', () => acks >= 1), `acks=${acks}`)

// 发送目标回退（cfg.chatId 为空 → 用最近收到消息的 chat）
try {
  await adapter.sendText('hello from probe')
} catch (err) {
  console.log('    sendText threw:', String(err))
}
console.log('    adapter logs:', JSON.stringify(logs))
check(
  'sendText falls back to last inbound chat',
  await waitFor('rest send', () => restSends.some(s => s.receive_id === 'oc_1')),
  JSON.stringify(restSends),
)

// 分片事件（先 seq=1 后 seq=0）→ 只在补齐后触发一次
;(mock as any).publishFragment = (messageId: string, chatId: string, text: string) => {
  const payload = receiveEventPayload(messageId, chatId, text)
  const mid = Math.floor(payload.length / 2)
  const socketsArr = Array.from(sockets)
  for (const ws of socketsArr) {
    ws.send(eventFrame(messageId, 1, 2, payload.slice(mid)))
    ws.send(eventFrame(messageId, 0, 2, payload.slice(0, mid)))
  }
}
const before = inbound.length
const acksBefore = acks
;(mock as any).publishFragment('om_2', 'oc_1', 'fragmented 你好')
check(
  'fragments merged → single onMessage',
  await waitFor('om_2', () => inbound.length === before + 1 && inbound[inbound.length - 1].text === 'fragmented 你好'),
  JSON.stringify(inbound.slice(before)),
)
await new Promise(r => setTimeout(r, 400))
check('fragment acked once', acks === acksBefore + 1, `acks=${acks} prev=${acksBefore}`)

// 双路去重：轮询回看同一条 message_id 不得二次触发
pollItems = [
  {
    message_id: 'om_1', // 已由长连接投递
    chat_id: 'oc_1',
    msg_type: 'text',
    create_time: String(Math.floor(Date.now() / 1000)),
    sender: { id: 'ou_9', type: 'user' },
    body: { content: JSON.stringify({ text: '/status' }) },
  },
  {
    message_id: 'om_3',
    chat_id: 'oc_1',
    msg_type: 'text',
    create_time: String(Math.floor(Date.now() / 1000)),
    sender: { id: 'ou_9', type: 'user' },
    body: { content: JSON.stringify({ text: 'from polling' }) },
  },
]
const statusCount = inbound.filter(m => m.text === '/status').length
await (adapter as any).pollOnce()
check(
  'cross-path dedup',
  (await waitFor('om_3', () => inbound.some(m => m.text === 'from polling'))) &&
    inbound.filter(m => m.text === '/status').length === statusCount,
)

// @占位符剥离
;(mock as any).publish('om_4', 'oc_1', '@_user_1 /help')
check(
  'mention placeholder stripped',
  await waitFor('om_4', () => inbound.some(m => m.text === '/help')),
  JSON.stringify(inbound.map(m => m.text)),
)

// 服务器断开 → 自动重连（重协商）
const endpointBefore = endpointCalls
for (const ws of Array.from(sockets)) {
  try {
    ws.close()
  } catch {}
}
check(
  'reconnect after drop',
  await waitFor('reconnect', () => endpointCalls > endpointBefore && sockets.size >= 1, 8000),
  `endpointCalls=${endpointCalls} sockets=${sockets.size}`,
)

// 停机干净
adapter.stop()
await new Promise(r => setTimeout(r, 300))
check('stop() clean', (adapter as any).longconn === null)

// ---------------------------------------------------------------------------
// ③ 不可重试降级（auth 拒绝 → 长连接禁用 + 轮询仍可用）
// ---------------------------------------------------------------------------
console.log('③ 非长连接模式降级')
const PORT2 = 4831
let endpointCalls2 = 0
let listCalls2 = 0
const mock2 = Bun.serve({
  port: PORT2,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/callback/ws/endpoint') {
      endpointCalls2++
      return Response.json({ code: 514, msg: 'app secret invalid (probe)' })
    }
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return Response.json({ code: 0, tenant_access_token: 'tn-probe2', expire: 3600 })
    }
    if (path === '/open-apis/im/v1/messages') {
      listCalls2++
      return Response.json({ code: 0, data: { items: [], has_more: false } })
    }
    return new Response('not found', { status: 404 })
  },
})
const logs2: string[] = []
const adapter2 = new FeishuAdapter(
  { appId: 'cli_0123456789abcdef', appSecret: 'x', apiBase: `http://127.0.0.1:${PORT2}`, chatId: 'oc_x' },
  line => logs2.push(line),
)
await adapter2.start({ onMessage: () => {} })
await new Promise(r => setTimeout(r, 2500))
check('non-retryable → disabled without retry spam', endpointCalls2 === 1, `calls=${endpointCalls2}`)
check(
  'fallback note logged',
  logs2.some(l => l.includes('长连接不可用')),
  JSON.stringify(logs2),
)
check('polling backstop alive', listCalls2 >= 1, `listCalls2=${listCalls2}`)
adapter2.stop()

// appId 格式守卫
const lc = new FeishuLongconn({ appId: 'not-a-cli-id', appSecret: 'x', onEvent: () => {} })
lc.start()
check('bad appId → disabled', lc.state === 'disabled')
lc.stop()

mock.stop(true)
mock2.stop(true)
console.log(`\n${failed === 0 ? 'PROBE OK' : 'PROBE FAIL'}：${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

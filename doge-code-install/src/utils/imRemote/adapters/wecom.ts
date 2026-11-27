import { randomUUID } from 'crypto'
import type {
  ImAdapter,
  ImAdapterHandlers,
  ImInboundMessage,
  ImOption,
  ImRemoteWecomConfig,
} from '../types.js'

/**
 * 企业微信「智能机器人」长连接适配器（微信通道）。
 *
 * 协议（官方 @wecom/aibot-node-sdk 同款，JSON over WSS）：
 *  - 连接 wss://openws.work.weixin.qq.com，open 后立即发
 *    {cmd:'aibot_subscribe', headers:{req_id}, body:{bot_id, secret}}，
 *    应答为无 cmd 帧 {headers:{req_id}, errcode:0}
 *  - 心跳 30s：{cmd:'ping', headers:{req_id}} → {headers:{req_id}, errcode:0}；
 *    连续 2 次无应答判死重连（指数退避，上限 30s）
 *  - 入站消息 {cmd:'aibot_msg_callback', body:{msgid, chatid?, chattype,
 *    from:{userid}, msgtype:'text', text:{content}}}
 *  - 回复（回调 req_id 透传，24h 内有效）：
 *    {cmd:'aibot_respond_msg', headers:{req_id}, body:{msgtype:'markdown',
 *    markdown:{content}}}
 *  - 主动推送 {cmd:'aibot_send_msg', body:{chatid, msgtype:'markdown', ...}}
 *  - disconnected_event = 新连接顶替，勿自动重连
 *
 * 凭据在管理后台「智能机器人 → API 模式 → 长连接」获取（BotID + Secret，
 * 与回调模式的 Token/AESKey 互斥）。个人微信无合规本地方案，此通道即
 * 「微信」形态的企业级答案；扫码网页通道可覆盖纯个人微信用户。
 */

const DEFAULT_WS_BASE = 'wss://openws.work.weixin.qq.com'
const HEARTBEAT_INTERVAL_MS = 30_000
const MAX_MISSED_PONG = 2
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30_000
const MAX_AUTH_FAILURES = 5
/** subscribe 后等服务器 ack 的上限——服务器收下 WSS 却永不回包时，没有
 * 这个超时适配器会永远吊着：入站收不到、出站全被丢弃且无重连。 */
const HANDSHAKE_TIMEOUT_MS = 15_000
/** 单会话 30 条/分钟限频——主动推送做轻节流防 4xx。 */
const SEND_MIN_INTERVAL_MS = 120

function genReqId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`
}

type WecomFrame = {
  cmd?: string
  headers?: { req_id?: string }
  body?: Record<string, unknown>
  errcode?: number
  errmsg?: string
}

/** Callback message we keep for replying within its 24h req_id window. */
type RecentCallback = {
  reqId: string
  chatId: string
  at: number
}

export class WecomAdapter implements ImAdapter {
  readonly platform = 'wecom'

  private ws: WebSocket | null = null
  private handlers: ImAdapterHandlers | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private missedPong = 0
  private authFailures = 0
  /** 网络级断连计数（与认证失败分开退避——onclose 时 +1、认证成功清零，
   * 否则对端宕机时恒 2s 一连 forever，与头注「指数退避」不符）。 */
  private networkFailures = 0
  private authed = false
  private stopped = false
  /** message_id seen-set（排重），超 2000 裁到 500。 */
  private seenMsgIds = new Set<string>()
  /** Reply windows: chatId -> most recent callback req_id (within 24h). */
  private recentCallbacks = new Map<string, RecentCallback>()
  private lastSendAt = 0
  /** 出站串行链：并发的 deliver 都读同一 lastSendAt 会突发穿透限频节流。 */
  private sendQueue: Promise<void> = Promise.resolve()
  private outboundChat = ''

  constructor(
    private readonly config: ImRemoteWecomConfig,
    private readonly log: (line: string) => void,
    /** 测试注入：缩短握手超时/重连退避，勿在生产路径传。 */
    private readonly timing: { handshakeTimeoutMs?: number; reconnectBaseMs?: number } = {},
  ) {}

  start(handlers: ImAdapterHandlers): Promise<void> {
    this.handlers = handlers
    this.stopped = false
    this.connect()
    // Resolve immediately — the connection retries in the background and a
    // down WeCom must never block the daemon (mirrors feishu longconn).
    return Promise.resolve()
  }

  private connect(): void {
    if (this.stopped) return
    const base = this.config.wsBase || DEFAULT_WS_BASE
    let ws: WebSocket
    try {
      ws = new WebSocket(base)
    } catch (err) {
      this.log(`wecom ws 构造失败：${String(err)}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    this.authed = false
    ws.onopen = () => {
      this.missedPong = 0
      this.send({
        cmd: 'aibot_subscribe',
        headers: { req_id: genReqId('aibot_subscribe') },
        body: { bot_id: this.config.botId, secret: this.config.secret },
      })
      this.armHandshakeTimeout()
    }
    ws.onmessage = ev => this.handleFrame(String(ev.data))
    ws.onclose = () => {
      this.stopHeartbeat()
      this.clearHandshakeTimeout()
      this.ws = null
      this.networkFailures++
      this.scheduleReconnect()
    }
    ws.onerror = () => {}
  }

  /** subscribe 无 ack 兜底：超时判死本连接，close 走统一重连路径。 */
  private armHandshakeTimeout(): void {
    this.clearHandshakeTimeout()
    this.handshakeTimer = setTimeout(() => {
      if (this.authed || this.stopped) return
      this.log('wecom subscribe 无应答——断开重连')
      try {
        this.ws?.close()
      } catch {}
    }, this.timing.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)
    this.handshakeTimer.unref?.()
  }

  private clearHandshakeTimeout(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  private handleFrame(raw: string): void {
    let frame: WecomFrame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    const reqId = frame.headers?.req_id ?? ''

    if (frame.cmd === 'aibot_msg_callback') {
      this.handleCallback(reqId, frame.body ?? {})
      return
    }
    if (frame.cmd === 'aibot_event_callback') {
      if ((frame.body as { event?: { eventtype?: string } })?.event?.eventtype === 'disconnected_event') {
        this.log('wecom 被新连接顶替（disconnected_event）——本连接停用，如需恢复请重启守护进程')
        this.stopHeartbeat()
        this.clearHandshakeTimeout()
        this.stopped = true
        try {
          this.ws?.close()
        } catch {}
        // 终态回传 daemon：否则 running 谎报、后续出站静默黑洞
        this.handlers?.onStopped?.('企业微信连接被新连接顶替（disconnected_event）')
        return
      }
      return
    }
    if (!frame.cmd) {
      if (reqId.startsWith('aibot_subscribe')) {
        this.clearHandshakeTimeout()
        if (frame.errcode !== 0) {
          this.authFailures++
          this.log(`wecom 认证失败 errcode=${frame.errcode} ${String(frame.errmsg ?? '')}（${this.authFailures}/${MAX_AUTH_FAILURES}）`)
          if (this.authFailures >= MAX_AUTH_FAILURES) {
            this.log('wecom 认证连续失败——请核对 BotID/Secret；适配器转入静默重试（每 30s）')
          }
          try {
            this.ws?.close()
          } catch {}
          return
        }
        this.authed = true
        this.authFailures = 0
        this.networkFailures = 0
        this.log('wecom 长连接认证成功')
        this.startHeartbeat()
        return
      }
      if (reqId.startsWith('ping')) {
        if (frame.errcode === 0) this.missedPong = 0
        return
      }
      // 出站应答：errcode≠0 要可见，否则消息黑洞无迹可查。注意 respond_msg
      // 透传的是回调的 req_id（无 aibot_ 前缀），不能按前缀识别——凡无 cmd
      // 且非 subscribe/ping 的失败帧都值得记一条。
      if (frame.errcode !== 0 && !reqId.startsWith('aibot_subscribe') && !reqId.startsWith('ping')) {
        this.log(`wecom 出站被拒 errcode=${frame.errcode} ${String(frame.errmsg ?? '')} req_id=${reqId.slice(0, 40)}`)
      }
    }
  }

  private handleCallback(reqId: string, body: Record<string, unknown>): void {
    const msgtype = String(body.msgtype ?? '')
    const msgid = String(body.msgid ?? '')
    if (msgid) {
      if (this.seenMsgIds.has(msgid)) return
      this.seenMsgIds.add(msgid)
      if (this.seenMsgIds.size > 2000) {
        this.seenMsgIds = new Set([...this.seenMsgIds].slice(-500))
      }
    }
    const from = body.from as { userid?: string } | undefined
    const userId = String(from?.userid ?? '')
    const chattype = String(body.chattype ?? 'single')
    // 单聊的 chatid 即对端 userid；群聊取 body.chatid。
    const chatId = chattype === 'group' ? String(body.chatid ?? '') : userId
    if (!userId || !chatId) return
    let text = ''
    if (msgtype === 'text') {
      text = String((body.text as { content?: string } | undefined)?.content ?? '').trim()
    } else if (msgtype === 'voice') {
      text = String((body.voice as { content?: string } | undefined)?.content ?? '').trim()
    }
    if (!text) return
    this.recentCallbacks.set(chatId, { reqId, chatId, at: Date.now() })
    this.pruneCallbacks()
    // 出站会话绑定不在此处——未配对者的首条消息不能抢占广播通道，绑定由
    // daemon 在配对门之后调 bindChat（recentCallbacks 无条件记录：它只是
    // 24h 回执窗的地址簿，/pair 应答回执仍需按 req_id 直答回来源）。
    this.handlers?.onMessage({ userId, userName: '企微用户', chatId, text })
  }

  /** Claim the outbound chat. Ordinary binds are first-wins, force (fresh
   *  pairing) takes ownership. Returns whether this call changed the target. */
  bindChat(chatId: string, opts?: { force?: boolean }): boolean {
    if (!chatId) return false
    if (this.outboundChat && !opts?.force) return false
    if (this.outboundChat === chatId) return false
    this.outboundChat = chatId
    return true
  }

  private pruneCallbacks(): void {
    const dayAgo = Date.now() - 24 * 3600_000
    for (const [k, v] of this.recentCallbacks) {
      if (v.at < dayAgo) this.recentCallbacks.delete(k)
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.missedPong >= MAX_MISSED_PONG) {
        this.log('wecom 心跳连续无应答——断开重连')
        try {
          this.ws?.close()
        } catch {}
        return
      }
      this.missedPong++
      this.send({ cmd: 'ping', headers: { req_id: genReqId('ping') } })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const attempt = Math.max(1, this.authFailures, this.networkFailures)
    const base = this.timing.reconnectBaseMs ?? RECONNECT_BASE_MS
    const delay = Math.min(base * 2 ** (attempt - 1), RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null
        this.connect()
      },
      delay,
    )
    // Daemon owns the lifetime — timers must not pin a dying process.
    this.reconnectTimer.unref?.()
  }

  private send(frame: WecomFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch (err) {
      this.log(`wecom send 失败：${String(err)}`)
    }
  }

  private targetChat(): string {
    return this.outboundChat
  }

  private async deliver(text: string): Promise<void> {
    if (!this.authed) {
      this.log(`wecom 未就绪，丢弃出站消息（${text.slice(0, 40)}…）`)
      return
    }
    const chatId = this.targetChat()
    if (!chatId) {
      this.log('wecom 尚无出站会话（等待用户先给机器人发消息）')
      return
    }
    const recent = this.recentCallbacks.get(chatId)
    if (recent) {
      this.send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: recent.reqId },
        body: { msgtype: 'markdown', markdown: { content: text } },
      })
    } else {
      this.send({
        cmd: 'aibot_send_msg',
        headers: { req_id: genReqId('aibot_send_msg') },
        body: { chatid: chatId, msgtype: 'markdown', markdown: { content: text } },
      })
    }
  }

  async sendText(text: string): Promise<void> {
    // 串行链 + 轻节流防 30 条/分钟限频：并发调用各自 sleep 会同时读到
    // 同一 lastSendAt 而突发穿透
    this.sendQueue = this.sendQueue.then(async () => {
      const wait = SEND_MIN_INTERVAL_MS - (Date.now() - this.lastSendAt)
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      this.lastSendAt = Date.now()
      await this.deliver(text)
    })
    await this.sendQueue
  }

  /** 智能机器人按钮走模板卡片（5s 内 update），文本通道降级为编号文本。 */
  async sendOptions(text: string, options: ImOption[]): Promise<void> {
    const lines = options.map((o, i) => `${i + 1}. ${o.label}`)
    const hint = options
      .map((o, i) => (o.data.startsWith('pick:') ? `/${o.data.slice(5)}` : `/${o.data}`))
      .join(' / ')
    await this.deliver(`${text}\n${lines.join('\n')}\n回复 ${hint} 进行选择`)
  }

  stop(): void {
    this.stopped = true
    this.stopHeartbeat()
    this.clearHandshakeTimeout()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {}
    this.ws = null
  }
}

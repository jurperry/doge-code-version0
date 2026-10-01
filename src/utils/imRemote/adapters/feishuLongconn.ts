import {
  decodeFeishuFrame,
  encodeFeishuFrame,
  feishuHeaderValue,
  type FeishuWsFrame,
} from './feishuProto.js'

/**
 * Feishu event long-connection channel — the "使用长连接接收事件" mode from
 * the developer console. Mirrors the official SDK WSClient protocol:
 *
 *   1. POST /callback/ws/endpoint {AppID, AppSecret} → {URL, ClientConfig}
 *   2. connect the returned wss URL (device_id/service_id ride in the query)
 *   3. send a control "ping" frame every ClientConfig.PingInterval seconds;
 *      the server answers "pong" whose payload refreshes those intervals
 *   4. data frames with header type=event carry the event JSON payload,
 *      possibly split into fragments (message_id/sum/seq) that must be
 *      reassembled, then ACKed by echoing the frame with a biz_rt header
 *      and a {code:200} payload
 *
 * Wire format: pbbp2 protobuf frames (feishuProto.ts). Failures here never
 * take the daemon down — the adapter keeps its history-polling backstop and
 * this channel just reports state via onLog/onState.
 */

export type FeishuLongconnState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disabled'

type ServerConfig = {
  pingIntervalMs: number
  reconnectIntervalMs: number
  reconnectNonceMs: number
}

const DEFAULT_PING_MS = 30_000
const DEFAULT_RECONNECT_MS = 30_000
const FRAGMENT_TTL_MS = 10_000
const HANDSHAKE_TIMEOUT_MS = 10_000

export type FeishuLongconnOpts = {
  appId: string
  appSecret: string
  /** https://open.feishu.cn by default; tests point this at a mock. */
  apiBase?: string
  /** Complete, reassembled event JSON (schema 2.0 envelope). */
  onEvent: (event: unknown) => void
  onLog?: (line: string) => void
}

export class FeishuLongconn {
  private stopped = false
  private generation = 0
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private serviceId = 0
  private cfg: ServerConfig = {
    pingIntervalMs: DEFAULT_PING_MS,
    reconnectIntervalMs: DEFAULT_RECONNECT_MS,
    reconnectNonceMs: 3_000,
  }
  private fragments = new Map<
    string,
    { parts: Array<Uint8Array | undefined>; createdAt: number }
  >()
  private _state: FeishuLongconnState = 'idle'

  constructor(private opts: FeishuLongconnOpts) {}

  get state(): FeishuLongconnState {
    return this._state
  }

  private setState(next: FeishuLongconnState): void {
    if (this._state === next) return
    this._state = next
    this.opts.onLog?.(`长连接状态：${next}`)
  }

  private log(line: string): void {
    this.opts.onLog?.(line)
  }

  private get api(): string {
    return (this.opts.apiBase ?? 'https://open.feishu.cn').replace(/\/$/, '')
  }

  /** Kick off the connect loop. Never throws — failures are logged and retried. */
  start(): void {
    if (this.stopped) return
    // The official client refuses app ids outside cli_ + 16 hex chars — same
    // guard, logged once, and the channel stays disabled (polling continues).
    if (!/^cli_[0-9a-fA-F]{16}$/.test(this.opts.appId)) {
      this.log(`appId 格式不符（应为 cli_ + 16 位十六进制），长连接未启用`)
      this.setState('disabled')
      return
    }
    this.setState('connecting')
    void this.connect()
    this.sweepTimer = setInterval(() => this.sweepFragments(), FRAGMENT_TTL_MS)
    this.sweepTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    this.generation++
    this.clearTimers()
    this.fragments.clear()
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
    this.setState('idle')
  }

  private clearTimers(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.pingTimer = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
  }

  /** One negotiation + connect attempt; schedules its own retry on failure. */
  private async connect(): Promise<void> {
    const generation = this.generation
    let url: string
    try {
      url = await this.negotiate()
    } catch (err) {
      if (this.stopped || generation !== this.generation) return
      // Auth/config refusals never recover on retry — disable and let the
      // polling backstop carry the adapter (e.g. subscription mode not set
      // to long-connection in the console).
      if (err instanceof NonRetryableError) {
        this.log(`长连接不可用：${err.message}（接收回退为轮询）`)
        this.clearTimers()
        this.setState('disabled')
        return
      }
      this.log(`长连接协商失败，稍后重试：${String(err)}`)
      this.scheduleReconnect(generation)
      return
    }
    if (this.stopped || generation !== this.generation) return
    try {
      this.serviceId = Number(new URL(url).searchParams.get('service_id') ?? '0') || 0
    } catch {
      this.log('长连接地址异常，稍后重试')
      this.scheduleReconnect(generation)
      return
    }
    this.openSocket(url, generation)
  }

  private async negotiate(): Promise<string> {
    const res = await fetch(this.api + '/callback/ws/endpoint', {
      method: 'POST',
      headers: { 'content-type': 'application/json', locale: 'zh' },
      body: JSON.stringify({ AppID: this.opts.appId, AppSecret: this.opts.appSecret }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const json = (await res.json()) as {
      code?: number
      msg?: string
      data?: { URL?: string; ClientConfig?: Record<string, number> }
    }
    if (json.code !== 0 || !json.data?.URL) {
      // 514 auth failed / 403 forbidden / 1000040350 connection limit — a
      // credential or console-config problem, not something retrying fixes.
      if (json.code === 514 || json.code === 403 || json.code === 1000040350) {
        throw new NonRetryableError(`endpoint code=${json.code} ${json.msg ?? ''}`.trim())
      }
      throw new Error(`endpoint code=${json.code ?? 'unknown'} ${json.msg ?? ''}`.trim())
    }
    const c = json.data.ClientConfig
    if (c && Number.isFinite(c.PingInterval) && c.PingInterval > 0) {
      this.cfg = {
        pingIntervalMs: Math.max(1_000, c.PingInterval * 1000),
        reconnectIntervalMs: Math.max(1_000, (c.ReconnectInterval || 30) * 1000),
        reconnectNonceMs: Math.max(0, (c.ReconnectNonce || 3) * 1000),
      }
    }
    return json.data.URL
  }

  private openSocket(url: string, generation: number): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.log(`长连接创建失败：${String(err)}`)
      this.scheduleReconnect(generation)
      return
    }
    // Bun defaults binaryType to nodebuffer; normalize so ev.data is always
    // an ArrayBuffer we can wrap in a Uint8Array.
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.handshakeTimer = setTimeout(() => {
      if (this.ws !== ws) return
      this.log('长连接握手超时，稍后重试')
      try {
        ws.close()
      } catch {}
    }, HANDSHAKE_TIMEOUT_MS)
    this.handshakeTimer.unref?.()
    ws.addEventListener('open', () => {
      if (this.stopped || generation !== this.generation) {
        try {
          ws.close()
        } catch {}
        return
      }
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
      this.log('长连接已建立（开发者后台将显示已连接）')
      this.setState('connected')
      this.sendPing()
    })
    ws.addEventListener('message', ev => {
      if (this.ws !== ws) return
      this.handleMessage(ev.data)
    })
    // 'error' is always followed by 'close' — reconnect scheduling lives in
    // exactly one place, the close handler.
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.pingTimer) clearTimeout(this.pingTimer)
      this.pingTimer = null
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
      if (this.stopped || generation !== this.generation) return
      this.scheduleReconnect(generation)
    })
  }

  private scheduleReconnect(generation: number): void {
    if (this.stopped || generation !== this.generation) return
    if (this._state !== 'disabled') this.setState('reconnecting')
    const jitter = this.cfg.reconnectNonceMs
      ? Math.floor(Math.random() * this.cfg.reconnectNonceMs)
      : 0
    const delay = Math.min(this.cfg.reconnectIntervalMs, 60_000) + jitter
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped || generation !== this.generation) return
      void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private sendPing(): void {
    const ws = this.ws
    if (!ws || this.stopped) return
    this.sendFrame({
      SeqID: 0,
      LogID: 0,
      service: this.serviceId,
      method: 0,
      headers: [{ key: 'type', value: 'ping' }],
    })
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.pingTimer = setTimeout(() => this.sendPing(), this.cfg.pingIntervalMs)
    this.pingTimer.unref?.()
  }

  private sendFrame(frame: FeishuWsFrame): void {
    const ws = this.ws
    if (!ws) return
    try {
      ws.send(encodeFeishuFrame(frame))
    } catch (err) {
      this.log(`长连接发送失败：${String(err)}`)
    }
  }

  private handleMessage(data: unknown): void {
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
    else if (ArrayBuffer.isView(data))
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    else return // text frame — protocol is binary only
    let frame: FeishuWsFrame
    try {
      frame = decodeFeishuFrame(bytes)
    } catch (err) {
      this.log(`长连接帧解析失败：${String(err)}`)
      return
    }
    if (frame.method === 0) {
      this.handleControl(frame)
      return
    }
    this.handleData(frame)
  }

  private handleControl(frame: FeishuWsFrame): void {
    const type = feishuHeaderValue(frame, 'type')
    if (type !== 'pong' || !frame.payload) return
    try {
      const cfg = JSON.parse(new TextDecoder().decode(frame.payload)) as {
        PingInterval?: number
        ReconnectInterval?: number
        ReconnectNonce?: number
      }
      if (Number.isFinite(cfg.PingInterval) && cfg.PingInterval! > 0) {
        this.cfg = {
          ...this.cfg,
          pingIntervalMs: Math.max(1_000, cfg.PingInterval! * 1000),
          reconnectIntervalMs: Math.max(
            1_000,
            (cfg.ReconnectInterval ?? 30) * 1000,
          ),
          reconnectNonceMs: Math.max(0, (cfg.ReconnectNonce ?? 3) * 1000),
        }
      }
    } catch {
      // Malformed pong config — keep current intervals.
    }
  }

  private handleData(frame: FeishuWsFrame): void {
    if (feishuHeaderValue(frame, 'type') !== 'event') return
    const messageId = feishuHeaderValue(frame, 'message_id')
    const sum = Number(feishuHeaderValue(frame, 'sum'))
    const seq = Number(feishuHeaderValue(frame, 'seq'))
    if (!messageId || !frame.payload) return
    if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) {
      this.log(`事件分片元数据异常（sum=${sum} seq=${seq}），已丢弃`)
      return
    }
    const entry = this.fragments.get(messageId)
    if (!entry) {
      this.fragments.set(messageId, {
        parts: Array.from({ length: sum }, () => undefined),
        createdAt: Date.now(),
      })
    } else if (entry.parts.length !== sum) {
      this.log(`事件分片 sum 不一致（${sum} vs ${entry.parts.length}），已丢弃`)
      this.fragments.delete(messageId)
      return
    }
    const cache = this.fragments.get(messageId)!
    cache.parts[seq] = frame.payload
    if (!cache.parts.every(p => p !== undefined)) return
    this.fragments.delete(messageId)
    const merged = concatBytes(cache.parts as Array<Uint8Array>)
    let event: unknown
    try {
      event = JSON.parse(new TextDecoder().decode(merged))
    } catch (err) {
      this.log(`事件负载解析失败：${String(err)}`)
      return
    }
    const startedAt = Date.now()
    try {
      this.opts.onEvent(event)
    } catch (err) {
      this.log(`事件处理异常：${String(err)}`)
    }
    // ACK per protocol: echo the frame plus a biz_rt header and {code:200}.
    this.sendFrame({
      ...frame,
      headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - startedAt) }],
      payload: new TextEncoder().encode(JSON.stringify({ code: 200 })),
    })
  }

  private sweepFragments(): void {
    const now = Date.now()
    for (const [id, entry] of this.fragments) {
      if (now - entry.createdAt > FRAGMENT_TTL_MS) this.fragments.delete(id)
    }
  }
}

class NonRetryableError extends Error {}

function concatBytes(parts: Array<Uint8Array>): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

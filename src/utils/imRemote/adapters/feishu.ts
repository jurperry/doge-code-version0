import type {
  ImAdapter,
  ImAdapterHandlers,
  ImOption,
  ImRemoteFeishuConfig,
} from '../types.js'
import { FeishuLongconn } from './feishuLongconn.js'

/**
 * Feishu/Lark adapter — pure HTTPS + the official event long-connection.
 *
 * Inbound (primary): the console's 「使用长连接接收事件」 mode via
 * FeishuLongconn — push events carrying im.message.receive_v1, which also
 * turns the console's connection status green. Inbound (backstop): history
 * polling (GET /im/v1/messages) for apps whose subscription mode isn't
 * long-connection or while the WS is reconnecting. Both paths share one
 * message_id seen-set so nothing is processed twice. Outbound: POST
 * /im/v1/messages as text; choices are expressed as numbered "/1" lines
 * because plain text bots cannot send interactive cards without extra
 * template work. apiBase is overridable for mocks.
 */

type FeishuMessage = {
  message_id: string
  chat_id: string
  msg_type: string
  create_time: string
  sender: { id?: string; id_type?: string; type?: string }
  body: { content?: string }
}

/** im.message.receive_v1 event payload (schema 2.0 `event` field). */
type FeishuReceiveEvent = {
  sender?: {
    sender_type?: string
    sender_id?: { open_id?: string; user_id?: string; union_id?: string }
  }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: 'p2p' | 'group'
    message_type?: string
    content?: string
    mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>
  }
}

const POLL_INTERVAL_MS = 4000

export class FeishuAdapter implements ImAdapter {
  readonly platform = 'feishu' as const
  private cfg: ImRemoteFeishuConfig
  private handlers: ImAdapterHandlers | null = null
  private abort: AbortController | null = null
  private stopped = false
  private tenantToken = ''
  private tokenExpiresAt = 0
  private seen = new Set<string>()
  private startedAtSec = Math.floor(Date.now() / 1000)
  private lastCreateSec = 0
  private lastInboundChat = ''
  private longconn: FeishuLongconn | null = null
  private pollErrors = 0

  constructor(cfg: ImRemoteFeishuConfig, private onLog?: (line: string) => void) {
    this.cfg = cfg
  }

  private get api(): string {
    return (this.cfg.apiBase ?? 'https://open.feishu.cn').replace(/\/$/, '')
  }

  private log(line: string): void {
    this.onLog?.(line)
  }

  private async tenantAccessToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.tenantToken
    }
    const res = await fetch(this.api + '/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
      signal: this.abort?.signal ?? AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error('feishu token HTTP ' + res.status)
    const json = (await res.json()) as { code: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new Error('feishu token: ' + (json.msg ?? 'unknown error'))
    }
    this.tenantToken = json.tenant_access_token
    this.tokenExpiresAt = Date.now() + (json.expire ?? 3600) * 1000
    return this.tenantToken
  }

  async start(handlers: ImAdapterHandlers): Promise<void> {
    this.handlers = handlers
    this.stopped = false
    this.abort = new AbortController()
    // Fail fast on bad credentials before the daemon reports "running".
    await this.tenantAccessToken()
    // Primary receive path. Never throws — on failure it logs and the
    // polling backstop below carries the adapter.
    this.longconn = new FeishuLongconn({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      apiBase: this.cfg.apiBase,
      onEvent: ev => this.handleReceiveEvent(ev),
      onLog: line => this.log(line),
    })
    this.longconn.start()
    void this.pollLoop()
  }

  /** Long-connection event → inbound message (already deduped by callers). */
  private handleReceiveEvent(ev: unknown): void {
    const envelope = ev as { header?: { event_type?: string }; event?: FeishuReceiveEvent }
    if (envelope?.header?.event_type !== 'im.message.receive_v1') return
    const message = envelope.event?.message
    const sender = envelope.event?.sender
    if (!message?.message_id || !message.chat_id) return
    if (sender?.sender_type === 'app') return // our own sends
    if (message.message_type !== 'text') return
    const inbound = this.takeInbound(message.message_id, message.chat_id, message.content)
    if (!inbound) return
    const userId = sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? ''
    this.handlers?.onMessage({
      userId,
      userName: userId,
      chatId: message.chat_id,
      text: inbound,
    })
  }

  /**
   * Dedup + parse shared by both receive paths. Records the chat, strips
   * @-mention placeholder keys the protocol leaves in the text, and returns
   * the plain text (or null when it's a duplicate / non-text / empty).
   */
  private takeInbound(messageId: string, chatId: string, rawContent?: string): string | null {
    if (this.seen.has(messageId)) return null
    this.seen.add(messageId)
    if (chatId) this.lastInboundChat = chatId
    let text = ''
    try {
      text = String(JSON.parse(rawContent ?? '{}').text ?? '')
    } catch {
      return null
    }
    // "@_user_N" placeholder tokens (bot mentions) are not user input.
    text = text.replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim()
    return text || null
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped && !this.abort?.signal.aborted) {
      try {
        await this.pollOnce()
        this.pollErrors = 0
      } catch (err) {
        // Backstop-only path: keep looping but make prolonged failure
        // visible in the daemon log instead of swallowing it forever.
        this.pollErrors++
        if (this.pollErrors === 1 || this.pollErrors % 20 === 0) {
          this.log(`历史消息轮询连续失败 ${this.pollErrors} 次：${String(err)}`)
        }
      }
      await sleep(POLL_INTERVAL_MS, this.abort?.signal)
    }
  }

  private async pollOnce(): Promise<void> {
    const token = await this.tenantAccessToken()
    // Re-fetch one extra second of overlap — create_time is second-granular
    // and the seen-set de-dups anything re-delivered.
    const since = Math.max(this.startedAtSec, this.lastCreateSec ? this.lastCreateSec - 1 : 0)
    let pageToken = ''
    for (;;) {
      const url =
        this.api +
        '/open-apis/im/v1/messages?container_id_type=chat&container_id=' +
        encodeURIComponent(this.cfg.chatId) +
        '&start_time=' +
        since +
        '&sort_type=ByCreateTimeAsc&page_size=50' +
        (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '')
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
        signal: this.abort?.signal ?? AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error('feishu list HTTP ' + res.status)
      const json = (await res.json()) as {
        code: number
        msg?: string
        data?: { items?: FeishuMessage[]; page_token?: string; has_more?: boolean }
      }
      if (json.code !== 0) throw new Error('feishu list: ' + (json.msg ?? 'unknown'))
      for (const item of json.data?.items ?? []) {
        const createSec = parseInt(item.create_time, 10)
        if (Number.isFinite(createSec)) {
          this.lastCreateSec = Math.max(this.lastCreateSec, createSec)
        }
        // Skip anything the app itself sent.
        if (item.sender?.type === 'app') continue
        if (item.msg_type !== 'text') continue
        const text = this.takeInbound(item.message_id, item.chat_id, item.body.content)
        if (!text) continue
        this.handlers?.onMessage({
          userId: item.sender?.id ?? '',
          userName: item.sender?.id ?? '',
          chatId: item.chat_id,
          text,
        })
      }
      if (!json.data?.has_more || !json.data.page_token) break
      pageToken = json.data.page_token
    }
    // Cap the de-dup set so long-running daemons don't grow it forever.
    if (this.seen.size > 2000) {
      this.seen = new Set(Array.from(this.seen).slice(-500))
    }
  }

  private async send(msgType: string, content: Record<string, unknown>): Promise<void> {
    // Configured chat wins; otherwise fall back to the chat the latest
    // inbound message came from (pairing traffic has nowhere else to go).
    const target = this.cfg.chatId || this.lastInboundChat
    if (!target) {
      throw new Error('feishu send: 没有可用的会话（chatId 未配置且尚未收到任何消息）')
    }
    const token = await this.tenantAccessToken()
    const res = await fetch(
      this.api + '/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          receive_id: target,
          msg_type: msgType,
          content: JSON.stringify(content),
        }),
        signal: this.abort?.signal ?? AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) throw new Error('feishu send HTTP ' + res.status)
    const json = (await res.json()) as { code: number; msg?: string }
    if (json.code !== 0) throw new Error('feishu send: ' + (json.msg ?? 'unknown'))
  }

  async sendText(text: string): Promise<void> {
    await this.send('text', { text })
  }

  /**
   * Plain-text choices — formatAskMessage/formatPermissionMessage already
   * embed numbered "/1 …" lines, so appending another option list would
   * duplicate them (and a trailing "/N 跳过" line would parse as an invalid
   * pick instead of skip). Just send the composed text.
   */
  async sendOptions(text: string, _options: ImOption[]): Promise<void> {
    await this.send('text', { text })
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
    this.longconn?.stop()
    this.longconn = null
    // Keep abort non-null — same resurrection hazard as TelegramAdapter
    // (pollLoop guards on !abort.signal.aborted; null would flip it true).
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}

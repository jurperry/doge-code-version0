import type {
  ImAdapter,
  ImAdapterHandlers,
  ImInboundMessage,
  ImOption,
} from '../types.js'
import type { ImRemoteTelegramConfig } from '../types.js'

/**
 * Telegram adapter — pure HTTPS against the Bot API, no SDK.
 *
 * Inbound: getUpdates long polling (25s server-side hold, offset cursor).
 * Outbound: sendMessage, optionally with an inline keyboard for choices;
 * selections arrive as callback_query updates and are acknowledged so the
 * client stops spinning. apiBase is overridable so black-box tests can
 * point the adapter at a local mock server.
 */

type TgUpdate = {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat: { id: number }
    from?: { id: number; first_name?: string; username?: string }
  }
  callback_query?: {
    id: string
    data?: string
    from?: { id: number; first_name?: string; username?: string }
  }
}

export class TelegramAdapter implements ImAdapter {
  readonly platform = 'telegram' as const
  private cfg: ImRemoteTelegramConfig
  private handlers: ImAdapterHandlers | null = null
  private abort: AbortController | null = null
  private stopped = false
  private offset = 0
  private chatId: string

  constructor(cfg: ImRemoteTelegramConfig) {
    this.cfg = cfg
    this.chatId = cfg.chatId ?? ''
  }

  private get api(): string {
    return (this.cfg.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '')
  }

  private async call(method: string, body: Record<string, unknown>): Promise<any> {
    // 硬超时 10s：loopback/官方 API 偶发连接挂起时快速失败（daemon 侧会退避
    // 重试或退出），绝不无限等待
    const timeout = AbortSignal.timeout(10_000)
    const signal = this.abort?.signal ? AbortSignal.any([this.abort.signal, timeout]) : timeout
    const res = await fetch(this.api + '/bot' + this.cfg.botToken + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      throw new Error('telegram ' + method + ' HTTP ' + res.status)
    }
    const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown }
    if (!json.ok) {
      throw new Error('telegram ' + method + ': ' + (json.description ?? 'unknown error'))
    }
    return json.result
  }

  async start(handlers: ImAdapterHandlers): Promise<void> {
    this.handlers = handlers
    this.stopped = false
    this.abort = new AbortController()
    // Fail fast on a bad token before the daemon reports "running".
    await this.call('getMe', {})
    // Drain the startup backlog so stale group chatter / old commands
    // queued while the daemon was down are not replayed into routing.
    try {
      const backlog = (await this.call('getUpdates', { timeout: 0, offset: this.offset })) as TgUpdate[]
      for (const u of backlog) {
        this.offset = Math.max(this.offset, u.update_id + 1)
      }
    } catch {
      // Non-fatal: worst case the first poll replays old updates.
    }
    void this.pollLoop()
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped && !this.abort?.signal.aborted) {
      try {
        const updates = (await this.call('getUpdates', {
          timeout: 25,
          offset: this.offset,
          allowed_updates: ['message', 'callback_query'],
        })) as TgUpdate[]
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1)
          this.dispatch(u)
        }
        // The real API holds the request ~25s; guards against hot loops
        // when a mock (or a proxy) answers empty immediately.
        if (updates.length === 0) {
          await new Promise(r => setTimeout(r, 1000))
        }
      } catch (err) {
        if (this.abort?.signal.aborted) return
        // Long-poll aborts and transient network errors both land here;
        // back off briefly instead of hammering the API.
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  }

  private dispatch(u: TgUpdate): void {
    const h = this.handlers
    if (!h) return
    if (u.callback_query) {
      const from = u.callback_query.from
      // Normalize button data to the equivalent text command so the
      // daemon's single command parser handles both shapes: pick:2 -> /2,
      // allow -> /allow, skip -> /skip.
      const data = u.callback_query.data ?? ''
      const text = data.startsWith('pick:') ? '/' + data.slice(5) : '/' + data
      const msg: ImInboundMessage = {
        userId: String(from?.id ?? ''),
        userName: from?.username ?? from?.first_name ?? '',
        chatId: '',
        text,
        callbackId: u.callback_query.id,
      }
      h.onMessage(msg)
      return
    }
    const m = u.message
    if (!m?.text) return
    const from = m.from
    h.onMessage({
      userId: String(from?.id ?? ''),
      userName: from?.username ?? from?.first_name ?? '',
      chatId: String(m.chat.id),
      text: m.text,
    })
  }

  /** First inbound chat wins when no explicit chatId was configured. */
  observeChatId(chatId: string): void {
    if (!this.chatId && chatId) {
      this.chatId = chatId
    }
  }

  get targetChatId(): string {
    return this.chatId
  }

  async sendText(text: string): Promise<void> {
    if (!this.chatId) return
    await this.call('sendMessage', {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
    })
  }

  async sendOptions(text: string, options: ImOption[]): Promise<void> {
    if (!this.chatId) return
    await this.call('sendMessage', {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: options.map(o => [{ text: o.label, callback_data: o.data }]),
      },
    })
  }

  async answerCallback(callbackId: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text })
  }

  stop(): void {
    this.stopped = true
    this.abort?.abort()
    // Keep this.abort non-null: pollLoop's guard is !abort.signal.aborted,
    // nulling it here would resurrect the loop (!undefined === true).
  }
}

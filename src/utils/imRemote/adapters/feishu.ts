import type {
  ImAdapter,
  ImAdapterHandlers,
  ImOption,
  ImRemoteFeishuConfig,
} from '../types.js'

/**
 * Feishu/Lark adapter — pure HTTPS, no SDK and no webhook server.
 *
 * Inbound: polls the chat history API (GET /im/v1/messages) every few
 * seconds and tracks a message_id cursor. The app needs im:message read
 * scope. Outbound: POST /im/v1/messages as text; choices are expressed
 * as numbered "/1" lines because plain text bots cannot send interactive
 * cards without extra template work. apiBase is overridable for mocks.
 */

type FeishuMessage = {
  message_id: string
  chat_id: string
  msg_type: string
  create_time: string
  sender: { id?: string; id_type?: string; type?: string }
  body: { content?: string }
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

  constructor(cfg: ImRemoteFeishuConfig) {
    this.cfg = cfg
  }

  private get api(): string {
    return (this.cfg.apiBase ?? 'https://open.feishu.cn').replace(/\/$/, '')
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
    void this.pollLoop()
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped && !this.abort?.signal.aborted) {
      try {
        await this.pollOnce()
      } catch {
        // Transient errors back off; abort signal ends the loop.
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
        if (this.seen.has(item.message_id)) continue
        this.seen.add(item.message_id)
        const createSec = parseInt(item.create_time, 10)
        if (Number.isFinite(createSec)) {
          this.lastCreateSec = Math.max(this.lastCreateSec, createSec)
        }
        // Skip anything the app itself sent.
        if (item.sender?.type === 'app') continue
        if (item.msg_type !== 'text') continue
        let text = ''
        try {
          text = String(JSON.parse(item.body.content ?? '{}').text ?? '')
        } catch {
          continue
        }
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
    const token = await this.tenantAccessToken()
    const res = await fetch(
      this.api + '/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({
          receive_id: this.cfg.chatId,
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

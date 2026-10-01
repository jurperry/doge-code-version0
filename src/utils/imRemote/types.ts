/**
 * IM remote-control — shared types for config, wire protocol and adapters.
 *
 * Architecture (see docs in daemon.ts): a local bridge daemon (`doge im`)
 * owns all IM traffic (Telegram / Feishu HTTPS). CLI sessions — both the
 * TUI and headless stream-json — attach to the daemon over a token-authed
 * localhost WebSocket and act as thin clients: they forward prompts,
 * permission/ask requests, tool ticks and turn results, and receive
 * prompts, permission responses and interrupts back. The Electron shell
 * attaches as a monitor client for tray/taskbar display and settings.
 */

export type ImPlatform = 'telegram' | 'feishu' | 'wecom'

export type ImRemoteTelegramConfig = {
  /** Bot token from @BotFather. */
  botToken: string
  /** API base override (tests point this at a local mock). */
  apiBase?: string
  /** Restrict to one chat; when empty the paired user's chat is used. */
  chatId?: string
}

export type ImRemoteFeishuConfig = {
  appId: string
  appSecret: string
  apiBase?: string
  /** Open chat_id the daemon sends to (oc_xxx — group chat form). */
  chatId: string
}

export type ImRemoteWecomConfig = {
  /** 智能机器人 BotID（企业微信管理后台 → 智能机器人 → API 模式 → 长连接）。 */
  botId: string
  /** 长连接专用 Secret（与回调模式的 Token/AESKey 互斥）。 */
  secret: string
  /** Override the official wss endpoint (tests point this at a local mock). */
  wsBase?: string
  /** 智能机器人的「机器人链接」（企业微信客户端 → 智能机器人 → 分享/二维码
   *  复制，永久有效）：设置页把它渲染成跨网络扫码入口——企微深链无法由
   *  botId 推导，只能由用户从客户端带出。 */
  botLink?: string
}

export type ImRemotePairState = {
  /** Six-character pairing code shown in the app settings page. */
  code: string
  /** Unix ms when the code expires (60 minutes). */
  expires: number
}

/**
 * Per-platform auth tables (2.1.274). Pairing is per-platform BY DESIGN: each
 * running bot platform mints its OWN code, and a code sent via platform A is
 * validated against (and consumed from) platform A only. Likewise the
 * allowlist is keyed per platform — pairing on WeCom grants WeCom, never
 * Feishu. Legacy global `pair`/`allowedUsers` keys are migrated (or dropped
 * when ambiguous) by normalizeImRemoteConfig — see config.ts.
 */
export type ImPlatformPairs = Partial<Record<ImPlatform, ImRemotePairState>>
export type ImPlatformAllowedUsers = Partial<Record<ImPlatform, string[]>>

export type ImRemoteConfig = {
  version: 1
  /** Master switch for the CUSTOM IM bot channels. When false, sessions never
   *  attach for the bots alone and the daemon refuses their adapters — but the
   *  QR web channel (im-remote-web.json) is independent and may still run.
   *  2.1.272: every platform with complete credentials runs CONCURRENTLY;
   *  `platform` below is only a UI hint (last edited) — it no longer gates
   *  which adapter starts. */
  enabled: boolean
  /** UI hint only (2.1.272) — channel selection is per-platform credentials. */
  platform: ImPlatform
  telegram?: ImRemoteTelegramConfig
  feishu?: ImRemoteFeishuConfig
  wecom?: ImRemoteWecomConfig
  /** Paired IM user ids allowed to control sessions, PER PLATFORM (2.1.274). */
  allowedUsersByPlatform?: ImPlatformAllowedUsers
  /** Switch to bypassPermissions ("Auto") when a session attaches. */
  autoMode: boolean
  /** Send a summary notification every N tool calls. */
  summaryEvery: number
  /** Localhost WebSocket port of the bridge daemon. */
  port: number
  /** Localhost auth token (generated on first save). */
  token: string
  /** One pairing code per bot platform (2.1.274) — see ImPlatformPairs. */
  pairs?: ImPlatformPairs
  /**
   * Per-platform outbound chat binding (2.1.274, daemon-owned). Adapter chat
   * targets are in-memory and die with the daemon — without persisting them
   * every daemon restart (every channel-keys settings save!) silently
   * black-holes broadcasts until the next inbound message re-binds. Pairing
   * force-takes ownership; ordinary paired inbounds are first-wins.
   */
  outboundChats?: Partial<Record<ImPlatform, string>>
}

/**
 * QR web channel config — deliberately a SEPARATE file (~/.doge/im-remote-web.json):
 * the scan-to-chat channel owns its lifecycle (enable/port/token) independent of
 * the custom bot credentials, so enabling one never clobbers the other.
 */
export type ImRemoteWebConfig = {
  version: 1
  enabled: boolean
  /** LAN HTTP port serving the embedded chat page + its websocket. */
  port: number
  /** Access token embedded in the QR link; regenerating invalidates old links. */
  token: string
}

// ---------------------------------------------------------------------------
// Wire protocol (client/monitor -> daemon)
// ---------------------------------------------------------------------------

export type ImRemoteSessionKind = 'tui' | 'headless' | 'monitor'

export type ImRemoteClientFrame =
  | {
      t: 'hello'
      sessionId: string
      kind: ImRemoteSessionKind
      label: string
      cwd: string
      pid: number
    }
  | { t: 'turn'; aborted: boolean; text: string; durationMs: number }
  | { t: 'tools'; count: number; last: string }
  | {
      t: 'agent'
      ev: 'started' | 'completed' | 'failed' | 'stopped' | 'teams_on'
      name?: string
      summary?: string
    }
  | {
      t: 'perm_req'
      id: string
      tool: string
      title: string
      detail: string
      /** Present for AskUserQuestion — options to choose from. */
      ask?: {
        question: string
        options: string[]
        multi: boolean
      }
    }
  | { t: 'perm_cancel'; id: string }
  | { t: 'bye' }

/** Monitor-only frames (App main process). */
export type ImRemoteMonitorFrame =
  /**
   * Pin the routing target AND the remote binding to a session. An EMPTY
   * sessionId releases the binding only (desktop-side "stop occupying") —
   * the active routing target is untouched.
   */
  | { t: 'set_active'; sessionId: string }
  | { t: 'get_status' }
  /**
   * Mint a fresh pairing code. With `platform` only that platform's code is
   * regenerated; without it (legacy clients / hand-typed frames) every
   * RUNNING bot platform gets a fresh code.
   */
  | { t: 'regen_pair'; platform?: ImPlatform }

// ---------------------------------------------------------------------------
// Wire protocol (daemon -> client/monitor)
// ---------------------------------------------------------------------------

/** 跨网络扫码块（status.bots 的元素，2.1.272）：一个在跑的 bot 平台一条。 */
export type ImRemoteBotChannelStatus = {
  platform: ImPlatform
  /** Bot display name when the platform exposes one (Telegram getMe). */
  botName: string | null
  /** 扫码直达链接（TG 带 start=配对码 / 飞书 applink / 企微配置的机器人链接） */
  deepLink: string | null
  pairCode: string | null
  /** Unix ms when the pair code expires (null = none/expired). */
  pairExpires: number | null
  /** Count of paired allowed users. */
  paired: number
}

export type ImRemoteDaemonFrame =
  | { t: 'welcome'; sessionId: string }
  | { t: 'prompt'; text: string }
  | {
      t: 'perm_res'
      id: string
      behavior: 'allow' | 'deny'
      /** For AskUserQuestion: chosen 1-based option indices; the client
       *  patches them into `updatedInput.answers` using the input it sent. */
      picks?: number[]
      /** For non-ask tools: the original input patched by the client. */
      updatedInput?: Record<string, unknown>
      message?: string
    }
  | { t: 'interrupt' }
  // A prompt arrived with no session attached — the daemon holds it briefly;
  // the app monitor uses this to wake a new session (settings tab creation).
  | { t: 'no_session'; text: string }
  // Monitor broadcast frames — echoes of client frames plus session list.
  | { t: 'sessions'; active: string | null; sessions: Array<{ sessionId: string; label: string; kind: ImRemoteSessionKind; cwd: string; tools: number }> }
  | {
      t: 'status'
      running: boolean
      platform: ImPlatform | 'none'
      attached: number
      active: string | null
      toolCount: number
      pendingAsk: boolean
      /** Legacy placeholder (2.1.274): pairing is per-platform — real codes
       *  live in `bots[].pairCode`; this stays null for shape compat. */
      pairCode: string | null
      /** Legacy placeholder (2.1.274): union of all platforms' allowlists. */
      allowedUsers: string[]
      /** QR web channel — primary LAN URL for the embedded chat page. */
      webUrl?: string | null
      /** All candidate LAN URLs (multi-NIC machines). */
      webUrls?: string[]
      /** QR web channel port when running. */
      webPort?: number | null
      /** 公网 IPv6 直连地址（web 频道在跑且有全局 v6 时；null = 不可用） */
      webUrl6?: string | null
      /**
       * Remote binding (2.1.270): the session that last RECEIVED a remote
       * prompt (or was pinned via set_active). The app locks that tab's
       * close button — closing it would sever the remote link mid-use.
       * Null when nothing is bound.
       */
      bound?: string | null
      /**
       * Cross-network scan entries (2.1.272): one item per RUNNING bot
       * platform so the settings page can render a QR for each (Telegram
       * t.me/<bot>?start=<pair>, Feishu applink, WeCom user-supplied bot
       * link). Empty when no bot channel is running. (Supersedes the
       * single-bot `bot` field of 2.1.270–2.1.271.)
       */
      bots?: ImRemoteBotChannelStatus[]
    }
  | ImRemoteClientFrame

// ---------------------------------------------------------------------------
// IM adapter interface
// ---------------------------------------------------------------------------

export type ImInboundMessage = {
  userId: string
  userName: string
  chatId: string
  text: string
  /** Platform callback id (Telegram callback_query) when answering an option. */
  callbackId?: string
}

export type ImOption = { label: string; data: string }

export type ImAdapterHandlers = {
  onMessage(msg: ImInboundMessage): void
  /** Adapter-judged terminal state (e.g. wecom disconnected_event =
   *  replaced by a newer connection): daemon must mark the channel
   *  stopped or /status lies and outbound silently black-holes. */
  onStopped?(reason: string): void
}

export interface ImAdapter {
  /** Display id — an ImPlatform or 'web' for the embedded QR chat channel. */
  readonly platform: ImPlatform | 'web'
  start(handlers: ImAdapterHandlers): Promise<void>
  sendText(text: string): Promise<void>
  /**
   * Send a question the user can answer with a choice. `options` carry a
   * machine `data` value echoed back on selection.
   */
  sendOptions(text: string, options: ImOption[]): Promise<void>
  /** Acknowledge a callback selection (clears the Telegram button spinner). */
  answerCallback?(callbackId: string, text: string): Promise<void>
  /**
   * Claim `chatId` as the adapter's outbound target (2.1.274). Called by the
   * daemon ONLY for senders that passed the pairing gate — an unpaired
   * stranger's first message must not hijack the notification channel
   * (Telegram always worked this way; Feishu/WeCom now align). Returns true
   * when this call changed the target (first bind, or a force re-bind from
   * a fresh pairing — the daemon persists those). Ordinary inbounds are
   * first-wins; a configured chatId always outranks any binding.
   */
  bindChat?(chatId: string, opts?: { force?: boolean }): boolean
  stop(): void
}

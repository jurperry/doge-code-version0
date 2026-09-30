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

export type ImPlatform = 'telegram' | 'feishu'

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

export type ImRemotePairState = {
  /** Six-character pairing code shown in the app settings page. */
  code: string
  /** Unix ms when the code expires (60 minutes). */
  expires: number
}

export type ImRemoteConfig = {
  version: 1
  /** Master switch. When false, sessions never attach and the daemon refuses to start. */
  enabled: boolean
  platform: ImPlatform
  telegram?: ImRemoteTelegramConfig
  feishu?: ImRemoteFeishuConfig
  /** Paired IM user ids allowed to control sessions. */
  allowedUsers: string[]
  /** Switch to bypassPermissions ("Auto") when a session attaches. */
  autoMode: boolean
  /** Send a summary notification every N tool calls. */
  summaryEvery: number
  /** Localhost WebSocket port of the bridge daemon. */
  port: number
  /** Localhost auth token (generated on first save). */
  token: string
  pair?: ImRemotePairState
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
  | { t: 'set_active'; sessionId: string }
  | { t: 'get_status' }
  | { t: 'regen_pair' }

// ---------------------------------------------------------------------------
// Wire protocol (daemon -> client/monitor)
// ---------------------------------------------------------------------------

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
  // Monitor broadcast frames — echoes of client frames plus session list.
  | { t: 'sessions'; active: string | null; sessions: Array<{ sessionId: string; label: string; kind: ImRemoteSessionKind; cwd: string; tools: number }> }
  | {
      t: 'status'
      running: boolean
      platform: ImPlatform
      attached: number
      active: string | null
      toolCount: number
      pendingAsk: boolean
      pairCode: string | null
      allowedUsers: string[]
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
}

export interface ImAdapter {
  readonly platform: ImPlatform
  start(handlers: ImAdapterHandlers): Promise<void>
  sendText(text: string): Promise<void>
  /**
   * Send a question the user can answer with a choice. `options` carry a
   * machine `data` value echoed back on selection.
   */
  sendOptions(text: string, options: ImOption[]): Promise<void>
  /** Acknowledge a callback selection (clears the Telegram button spinner). */
  answerCallback?(callbackId: string, text: string): Promise<void>
  stop(): void
}

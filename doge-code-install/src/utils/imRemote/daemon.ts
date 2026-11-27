import { appendFile, writeFile } from 'fs/promises'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { unlinkSync } from 'node:fs'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { logForDebugging } from '../debug.js'
import { FeishuAdapter } from './adapters/feishu.js'
import { TelegramAdapter } from './adapters/telegram.js'
import { WecomAdapter } from './adapters/wecom.js'
import { WebChatAdapter, publicV6UrlCandidates, webUrlCandidates } from './adapters/webChat.js'
import {
  imRemoteConfigPath,
  imRemoteConfigReady,
  selectBotPlatforms,
  allowedUsersFor,
  BOT_PLATFORMS,
  canConsumePair,
  loadImRemoteConfig,
  loadImRemoteWebConfig,
  imRemoteWebReady,
  pairCodeFor,
  PAIR_CODE_TTL_MS,
  generatePairCode,
  saveImRemoteConfig,
} from './config.js'
import {
  buildBotDeepLink,
  formatAgentEvent,
  formatAskMessage,
  formatPermissionMessage,
  formatToolSummary,
  formatTurnMessage,
  IM_HELP_TEXT,
  isUserAllowed,
  parseImCommand,
  summaryDue,
} from './format.js'
import type {
  ImAdapter,
  ImInboundMessage,
  ImPlatform,
  ImRemoteBotChannelStatus,
  ImOption,
  ImRemoteClientFrame,
  ImRemoteConfig,
  ImRemoteDaemonFrame,
  ImRemoteMonitorFrame,
  ImRemotePairState,
  ImRemoteWebConfig,
} from './types.js'

/**
 * IM remote-control bridge daemon (`doge im`).
 *
 * Owns all outbound channels and exposes a token-authed localhost WebSocket
 * where CLI sessions (TUI or headless) and the Electron shell's monitor
 * attach. Channels (any subset may run at once):
 *  - custom IM bot (im-remote.json): Telegram / Feishu / WeCom longconn
 *  - QR web chat (im-remote-web.json): LAN page + websocket, token-gated
 *
 * Routing model: prompts go to the active session (last hello wins; the app
 * monitor may pin one via set_active). Permission/ask requests are pushed to
 * EVERY channel; the first answer — remote or the local UI racing inside the
 * session — wins, the losers dismiss via perm_cancel. Command replies go back
 * to the channel the command came from (origin routing).
 */

type DaemonSocket = import('bun').ServerWebSocket<unknown>

type SessionConn = {
  sessionId: string
  kind: 'tui' | 'headless'
  label: string
  cwd: string
  pid: number
  toolCount: number
  socket: DaemonSocket
}

type PendingRelay = {
  id: string
  sessionId: string
  ask?: { question: string; options: string[]; multi: boolean }
}

/** A prompt that arrived with no session attached — held for a late attach. */
type HeldPrompt = {
  text: string
  channel: string
  at: number
}

const HELD_PROMPT_TTL_MS = 90_000

const BOT_PLATFORM_SET = new Set<ImPlatform>(BOT_PLATFORMS)

function statusFilePath(): string {
  return process.env.DOGE_IM_REMOTE_STATUS ?? join(getClaudeConfigHomeDir(), 'im-remote-status.json')
}

/** Daemon-side log file — the shell spawns us with stdio:ignore (pipes +
 *  windowsHide from a GUI parent can wedge a console exe at bootstrap), so
 *  lifecycle lines also land next to the status file for diagnosis. */
function daemonLogFile(): string {
  return join(getClaudeConfigHomeDir(), 'im-remote-daemon.log')
}

async function logLine(line: string): Promise<void> {
  const stamped = `[${new Date().toISOString()}] ${line}`
  try {
    process.stdout.write(stamped + '\n')
  } catch {}
  await appendFile(daemonLogFile(), stamped + '\n').catch(() => {})
}

/** 日志里脱敏扫码 URL 的令牌（报障时 im-remote-daemon.log 常被整份分享；
 * 状态文件与 monitor 帧保留完整 URL——那是 App 二维码的数据源）。 */
function redactWebUrl(url: string): string {
  return url.replace(/(#t=)[0-9a-f]+/i, '$1<redacted>')
}

/** Crash-path variant — the process exits right after this call. */
function logLineSync(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`
  try {
    process.stdout.write(stamped + '\n')
    appendFileSync(daemonLogFile(), stamped + '\n')
  } catch {}
}

/** 失败硬退出：CLI 引导期驻留的 watcher/interval 会让只设 exitCode 的进程
 *  永生（外部看就是「spawn 成功但全静默」的假挂起）。模块级——daemon 类
 *  的 run() catch 也用它，放函数体内会 ReferenceError（曾令适配器连接失败
 *  的退出路径二次抛错）。 */
const fail = async (code: number, msg: string): Promise<number> => {
  await logLine(msg)
  setTimeout(() => process.exit(code), 100).unref?.()
  return code
}

/** Entry point behind the `doge im` subcommand. Resolves the exit code. */
export async function runImRemoteDaemon(): Promise<number> {
  await logLine(`daemon entry pid=${process.pid} argvTail=${process.argv.slice(-3).join(' ')}`)
  const config = await loadImRemoteConfig()
  const web = await loadImRemoteWebConfig()
  const customReady = !!config?.enabled && imRemoteConfigReady(config)
  const webReady = !!web && imRemoteWebReady(web)
  if (!config && !web) {
    return fail(1, `未找到远程控制配置（${imRemoteConfigPath()} / im-remote-web.json），退出`)
  }
  if (!customReady && !webReady) {
    if (config?.enabled || web?.enabled) {
      return fail(1, '所选频道的凭据不完整，退出（自定义平台缺凭据，扫码网页缺令牌）')
    }
    return fail(1, '所有频道均未启用（enabled=false），退出')
  }
  const tokens = [config?.token, web?.token].filter((t): t is string => !!t && t.length >= 16)
  if (tokens.length === 0) {
    // An empty token would pass the "?token=" equality check — auth by blank.
    return fail(1, '配置缺少 localhost 鉴权 token，退出')
  }
  // 崩溃可见性：任何未接住的异常必须先落盘再死/继续——0.2.87 现场里
  // daemon 被一个飞书发送失败的 rejection 静默击杀，之后所有消息石沉大海。
  process.on('unhandledRejection', reason => {
    void logLine(`未处理的异步 rejection（已忽略）：${String(reason)}`)
  })
  process.on('uncaughtException', err => {
    logLineSync(
      `未捕获异常，守护进程退出：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    )
    setTimeout(() => process.exit(1), 100).unref?.()
  })
  return new ImRemoteDaemon(config, web).run()
}

type ChannelRuntime = {
  id: string
  adapter: ImAdapter
  /** false when the adapter failed to start (web port busy etc.). */
  running: boolean
}

class ImRemoteDaemon {
  private config: ImRemoteConfig | null
  private webConfig: ImRemoteWebConfig | null
  private channels: ChannelRuntime[] = []
  private webAdapter: WebChatAdapter | null = null
  private sessions = new Map<string, SessionConn>() // keyed by sessionId
  private monitors = new Set<DaemonSocket>()
  private activeSessionId: string | null = null
  /**
   * Remote binding (2.1.270): the session that last RECEIVED a remote prompt
   * (or was pinned via set_active). Distinct from activeSessionId — every
   * new CLI attach overwrites "active" (last hello wins), but the binding
   * only moves when remote traffic actually lands on another session. The
   * app locks the bound tab's close button so the remote link can't be
   * severed by closing its tab; a set_active with an empty sessionId
   * releases it (desktop-side "stop occupying").
   */
  private boundSessionId: string | null = null
  private pending: PendingRelay[] = []
  private server: ReturnType<typeof Bun.serve> | null = null
  private startedAt = new Date().toISOString()
  private shutdownResolve: (() => void) | null = null
  private unpairedWarnAt = new Map<string, number>()
  /** 本进程已消耗的配对码（platform:code）——封「验码与持久化之间隔 await」
   *  的同批双 /pair 双配对 TOCTOU；容量有界（码每次重铸随机，旧 key 无用）。 */
  private consumedPairCodes = new Set<string>()
  private heldPrompt: HeldPrompt | null = null

  constructor(config: ImRemoteConfig | null, web: ImRemoteWebConfig | null) {
    this.config = config
    this.webConfig = web
  }

  private buildChannels(): ChannelRuntime[] {
    const out: ChannelRuntime[] = []
    const cfg = this.config
    // 2.1.272 多平台并发：凭据齐备的 bot 平台各起一个频道（channel id 即平台
    // 名），扫码卡按平台逐一出二维码——用户手机上有什么就扫什么。`platform`
    // 字段只是 UI 提示，不再决定哪个 adapter 启动。
    if (cfg && cfg.enabled) {
      for (const platform of selectBotPlatforms(cfg)) {
        const adapter =
          platform === 'feishu'
            ? new FeishuAdapter(cfg.feishu!, line => void logLine(`[feishu] ${line}`))
            : platform === 'wecom'
              ? new WecomAdapter(cfg.wecom!, line => void logLine(`[wecom] ${line}`))
              : new TelegramAdapter(cfg.telegram!, line => void logLine(`[telegram] ${line}`))
        out.push({ id: platform, adapter, running: false })
      }
    }
    if (this.webConfig && imRemoteWebReady(this.webConfig)) {
      const adapter = new WebChatAdapter(
        { port: this.webConfig.port, token: this.webConfig.token },
        line => void logLine(`[web] ${line}`),
      )
      this.webAdapter = adapter
      out.push({ id: 'web', adapter, running: false })
    }
    return out
  }

  /** 在跑的 bot 平台频道（不含 web）。 */
  private botChannels(): ChannelRuntime[] {
    return this.channels.filter(c => c.id !== 'web')
  }

  /** 按 id 取在跑频道的 adapter（发指令性回执/记录用）。 */
  private runningAdapter(id: string): ImAdapter | undefined {
    const ch = this.channels.find(c => c.id === id)
    return ch?.running ? ch.adapter : undefined
  }

  async run(): Promise<number> {
    this.channels = this.buildChannels()
    if (this.channels.length === 0) {
      return fail(1, '没有可用的远程控制频道（凭据不完整或未启用）')
    }
    let started = 0
    for (const ch of this.channels) {
      try {
        await ch.adapter.start({
          onMessage: msg =>
            void this.onImMessage(msg, ch.id).catch(err =>
              logLine(`IM 消息处理异常（已忽略）：${String(err)}`),
            ),
          // 适配器自判终态（如企业微信 disconnected_event=被顶替）时回传：
          // 不回传则 running 谎报、后续出站静默黑洞
          onStopped: reason => this.markChannelStopped(ch, reason),
        })
        ch.running = true
        started++
      } catch (err) {
        // 单频道失败不拖垮其余频道（如 web 端口被占）。
        await logLine(`频道 ${ch.id} 启动失败（已跳过）：${String(err)}`)
      }
    }
    if (started === 0) {
      return fail(1, '所有频道启动失败，退出')
    }

    try {
      this.server = Bun.serve({
        hostname: '127.0.0.1',
        port: this.localhostPort(),
        fetch: (req, server) => {
          const url = new URL(req.url)
          if (url.pathname !== '/' || !this.authTokens().has(url.searchParams.get('token') ?? '')) {
            return new Response('forbidden', { status: 403 })
          }
          if (server.upgrade(req)) {
            return undefined
          }
          return new Response('upgrade required', { status: 426 })
        },
        websocket: {
          message: (ws, raw) => {
            try {
              this.handleSocketMessage(ws, typeof raw === 'string' ? raw : String(raw))
            } catch (err) {
              void logLine(`[daemon] frame error: ${String(err)}`)
            }
          },
          close: ws => this.handleSocketClose(ws),
        },
      })
    } catch (err) {
      // localhost 端口被占（Bun.serve 同步抛）：适配器已在跑、状态文件不再
      // 更新——正是 0.2.87 打过的「spawn 成功但全静默」僵尸形态，必须硬退
      await this.stopChannels()
      return fail(1, `localhost 端口 ${this.localhostPort()} 被占（可能已有守护进程在跑），退出：${String(err)}`)
    }

    // main.tsx owns a global SIGINT → exit(0); register in front so the
    // status-file cleanup actually runs before the process dies.
    process.prependListener('SIGINT', () => this.shutdown())
    process.prependListener('SIGTERM', () => this.shutdown())

    const channelNote = this.channels.filter(c => c.running).map(c => c.id).join('+')
    const botsInfo = this.botsChannelInfo()
    // 深链里的 start=<配对码> 与同行已明文打印的「配对码=」同源同级——此处不
    // 额外脱敏；若日后收紧配对码日志，这里要同步处理
    const pairNote = this.botChannels()
      .filter(c => c.running)
      .map(c => `${c.id}=${this.pairCode(c.id as ImPlatform) ?? '未生成'}`)
      .join(' ')
    await logLine(
      `远程控制守护进程已启动：channels=${channelNote} port=${this.localhostPort()} ` +
        (pairNote ? `配对码：${pairNote}` : '') +
        (botsInfo.length > 0 ? ` 跨网络扫码=${botsInfo.map(b => b.platform).join('/')}` : '') +
        (this.primaryWebUrl() ? ' web=' + redactWebUrl(this.primaryWebUrl()) : ''),
    )
    await this.writeStatus()

    // 自动铸配对码（2.1.271，2.1.274 起每平台一份）：在跑的 bot 平台各自的
    // 码为空/过期时启动即铸——扫码卡的跨网络二维码（Telegram start=<码>）
    // 开箱即扫即配对，不再要求用户先到设置页点「生成配对码」。已配对消耗/
    // 手动重铸路径不受影响。
    for (const ch of this.botChannels()) {
      if (ch.running && !this.pairCode(ch.id as ImPlatform)) {
        await this.regeneratePairCode(ch.id as ImPlatform)
      }
    }
    // 恢复持久化的出站会话绑定：适配器绑定是内存态，daemon 重启即丢——
    // 不恢复则重启后（改任一频道键的设置保存都会重启）已配对平台的广播
    // 静默黑洞，直到该平台来下一条入站
    this.restoreChatBindings()

    const heartbeat = setInterval(() => {
      this.reapDeadSessions()
      this.broadcastStatus()
      void this.writeStatus()
    }, 5000)

    await new Promise<void>(resolve => {
      this.shutdownResolve = resolve
    })
    clearInterval(heartbeat)
    return 0
  }

  private localhostPort(): number {
    return this.config?.port ?? 4763
  }

  /** Localhost WS accepts the im token OR the web token (either grants attach). */
  private authTokens(): Set<string> {
    const set = new Set<string>()
    if (this.config?.token) set.add(this.config.token)
    if (this.webConfig?.token) set.add(this.webConfig.token)
    return set
  }

  private shutdown(): void {
    for (const ch of this.channels) ch.adapter.stop()
    this.server?.stop(true)
    try {
      // Sync unlink: an async one loses the race with process exit.
      unlinkSync(statusFilePath())
    } catch {}
    this.shutdownResolve?.()
  }

  /** 该平台当前有效配对码（2.1.274 每平台一份；过期/未铸 → null）。 */
  private pairCode(platform: ImPlatform): string | null {
    return this.config ? pairCodeFor(this.config, platform) : null
  }

  // -----------------------------------------------------------------
  // Outbound fan-out
  // -----------------------------------------------------------------

  /** Reply to the channel a command/prompt came from. */
  private async reply(channelId: string, text: string): Promise<void> {
    const ch = this.channels.find(c => c.id === channelId && c.running)
    if (!ch) return
    await ch.adapter.sendText(text).catch(err => {
      // 出站失败要进 daemon 日志（logForDebugging 非 --debug 下是 no-op，
      // 与「未捕获异常先落盘」的硬化纪律不一致）
      void logLine(`reply(${channelId}) 发送失败：${String(err)}`)
    })
  }

  /**
   * Push a notification to every eligible channel (turn/summary/perm...).
   * Bot platforms are PAIRED-ONLY (2.1.274): a platform with zero paired
   * users receives nothing — configuring WeCom + Feishu credentials no
   * longer makes both buzz on every turn; each is silent until its own user
   * pairs on it. The QR web channel is token-gated (the link IS the
   * authorization) and always passes.
   */
  private broadcastIm(text: string, options?: ImOption[]): void {
    for (const ch of this.channels) {
      if (!ch.running) continue
      if (
        ch.id !== 'web' &&
        (!this.config || allowedUsersFor(this.config, ch.id as ImPlatform).length === 0)
      ) {
        continue
      }
      const p = options ? ch.adapter.sendOptions(text, options) : ch.adapter.sendText(text)
      void p.catch(err => {
        void logLine(`broadcast(${ch.id}) 发送失败：${String(err)}`)
      })
    }
  }

  /** 适配器自判终态（onStopped 回调）：置停 + 广播，让 /status 与状态文件
   * 不再谎报该频道在跑。 */
  private markChannelStopped(ch: ChannelRuntime, reason: string): void {
    if (!ch.running) return
    ch.running = false
    void logLine(`频道 ${ch.id} 已停止：${reason}`)
    this.broadcastIm(`⚠️ 「${ch.id}」频道已断开（${reason}），该通道暂不可用；其余频道不受影响。`)
    this.broadcastStatus()
    void this.writeStatus()
  }

  private stopChannels(): Promise<void[]> {
    return Promise.all(
      this.channels.map(ch => {
        try {
          ch.adapter.stop()
          ch.running = false
        } catch {}
        return Promise.resolve()
      }),
    )
  }

  // -----------------------------------------------------------------
  // Localhost WebSocket handling
  // -----------------------------------------------------------------

  private sendToSession(sessionId: string, frame: object): boolean {
    const conn = this.sessions.get(sessionId)
    if (!conn) return false
    try {
      conn.socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  private broadcastToMonitors(frame: object): void {
    const data = JSON.stringify(frame)
    for (const ws of this.monitors) {
      try {
        ws.send(data)
      } catch {}
    }
  }

  private handleSocketMessage(ws: DaemonSocket, raw: string): void {
    let frame: ImRemoteClientFrame | ImRemoteMonitorFrame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (frame.t === 'hello') {
      if (frame.kind === 'monitor') {
        this.monitors.add(ws)
        this.broadcastStatus()
        return
      }
      const isNew = !this.sessions.has(frame.sessionId)
      this.sessions.set(frame.sessionId, {
        sessionId: frame.sessionId,
        kind: frame.kind,
        label: frame.label,
        cwd: frame.cwd,
        pid: frame.pid,
        toolCount: 0,
        socket: ws,
      })
      this.activeSessionId = frame.sessionId
      ws.send(JSON.stringify({ t: 'welcome', sessionId: frame.sessionId }))
      if (isNew) {
        this.broadcastIm(
          '📥 会话「' +
            frame.label +
            '」（' +
            (frame.kind === 'tui' ? '终端' : '对话') +
            '）已接入远程控制' +
            (this.config?.autoMode !== false ? '，已自动切换 Auto 模式' : '') +
            '。',
        )
        this.flushHeldPrompt(frame.sessionId)
      }
      this.broadcastSessions()
      return
    }
    if (this.monitors.has(ws)) {
      this.handleMonitorFrame(frame)
      return
    }
    // Session frames are attributed via their socket, not the active id,
    // so a background tab reporting tools never misattributes.
    const conn = this.connBySocket(ws)
    if (conn) {
      this.handleSessionFrame(conn, frame)
    }
  }

  /** A session attached late — deliver the prompt that woke it, if any. */
  private flushHeldPrompt(sessionId: string): void {
    const held = this.heldPrompt
    if (!held) return
    this.heldPrompt = null
    if (Date.now() - held.at > HELD_PROMPT_TTL_MS) {
      void this.reply(held.channel, '⌛ 你刚才的消息暂存超时（超过 90 秒无人接入），请重发。')
      return
    }
    if (this.sendToSession(sessionId, { t: 'prompt', text: held.text })) {
      this.boundSessionId = sessionId
      void this.reply(held.channel, '✅ 会话已接入，正在处理你刚才的消息。')
    } else {
      // 发送失败也告知来源——「消息要么到、要么有回音」，不能静默丢
      void this.reply(held.channel, '⚠️ 会话接入但消息投递失败，请重发一次。')
    }
  }

  private connBySocket(ws: DaemonSocket): SessionConn | undefined {
    for (const conn of this.sessions.values()) {
      if (conn.socket === ws) return conn
    }
    return undefined
  }

  /** active/bound 指向的会话消失后的顺延规则（socket close / bye / 探活
   *  收割三处共用）：active 顺延到剩余会话的迭代序第一个，bound 直接清空
   *  ——占用随被占用会话的消失自然解除，不会拴到别的会话上。 */
  private demoteGoneSessions(): void {
    if (this.activeSessionId && !this.sessions.has(this.activeSessionId)) {
      this.activeSessionId = this.sessions.keys().next().value ?? null
    }
    if (this.boundSessionId && !this.sessions.has(this.boundSessionId)) {
      this.boundSessionId = null
    }
  }

  private handleSocketClose(ws: DaemonSocket): void {
    this.monitors.delete(ws)
    for (const [id, conn] of this.sessions) {
      if (conn.socket === ws) {
        this.sessions.delete(id)
        // Drop that session's pending relays — a later IM /allow would
        // otherwise confirm an answer nobody received.
        const dropped = this.pending.filter(relay => relay.sessionId === id)
        if (dropped.length > 0) {
          this.pending = this.pending.filter(relay => relay.sessionId !== id)
          this.broadcastIm('ℹ️ 会话「' + conn.label + '」已断开，其待应答请求已取消。')
        }
      }
    }
    this.demoteGoneSessions()
    this.broadcastSessions()
  }

  private handleMonitorFrame(frame: ImRemoteClientFrame | ImRemoteMonitorFrame): void {
    switch (frame.t) {
      case 'set_active':
        if (frame.sessionId === '') {
          // Desktop-side "stop occupying": release the binding only — the
          // routing target stays as-is (a running turn is not interrupted).
          if (this.boundSessionId !== null) {
            this.boundSessionId = null
            this.broadcastStatus()
          }
          break
        }
        if (this.sessions.has(frame.sessionId)) {
          this.activeSessionId = frame.sessionId
          this.boundSessionId = frame.sessionId
          this.broadcastSessions()
          this.broadcastStatus()
        }
        break
      case 'get_status':
        this.broadcastStatus()
        break
      case 'regen_pair':
        // 指定平台只重铸该平台；缺省（旧客户端/手敲帧）重铸全部在跑平台
        if (frame.platform && BOT_PLATFORM_SET.has(frame.platform)) {
          void this.regeneratePairCode(frame.platform)
        } else {
          for (const ch of this.botChannels()) {
            if (ch.running) void this.regeneratePairCode(ch.id as ImPlatform)
          }
        }
        break
      default:
        break
    }
  }

  private handleSessionFrame(conn: SessionConn, frame: ImRemoteClientFrame | ImRemoteMonitorFrame): void {
    switch (frame.t) {
      case 'turn':
        this.broadcastIm(formatTurnMessage(frame.text, frame.aborted, frame.durationMs))
        this.broadcastToMonitors(frame)
        break
      case 'tools':
        conn.toolCount = frame.count
        this.broadcastToMonitors(frame)
        if (summaryDue(frame.count, this.config?.summaryEvery ?? 10)) {
          this.broadcastIm(formatToolSummary(frame.count, frame.last))
        }
        break
      case 'agent':
        this.broadcastIm(formatAgentEvent(frame.ev, frame.name, frame.summary))
        this.broadcastToMonitors(frame)
        break
      case 'perm_req':
        this.handleRelayRequest(conn, frame)
        break
      case 'perm_cancel': {
        const idx = this.pending.findIndex(p => p.id === frame.id)
        if (idx >= 0) {
          this.pending.splice(idx, 1)
          this.broadcastIm('ℹ️ 之前的请求已在本地处理，可忽略。')
          this.broadcastStatus()
        }
        break
      }
      case 'bye':
        this.sessions.delete(conn.sessionId)
        this.demoteGoneSessions()
        this.broadcastSessions()
        break
      default:
        break
    }
  }

  private handleRelayRequest(conn: SessionConn, frame: Extract<ImRemoteClientFrame, { t: 'perm_req' }>): void {
    this.pending = this.pending.filter(p => p.id !== frame.id)
    const entry: PendingRelay = { id: frame.id, sessionId: conn.sessionId }
    if (frame.ask) {
      entry.ask = frame.ask
      const options: ImOption[] = frame.ask.options.map((label, i) => ({
        label,
        data: 'pick:' + (i + 1),
      }))
      options.push({ label: '跳过', data: 'skip' })
      this.broadcastIm(formatAskMessage(frame.ask.question, frame.ask.options, frame.ask.multi), options)
    } else {
      this.broadcastIm(formatPermissionMessage(frame.tool, frame.title, frame.detail), [
        { label: '✅ 允许', data: 'allow' },
        { label: '❌ 拒绝', data: 'deny' },
      ])
    }
    this.pending.push(entry)
    this.broadcastToMonitors(frame)
    this.broadcastStatus()
  }

  // -----------------------------------------------------------------
  // IM inbound
  // -----------------------------------------------------------------

  /**
   * Re-read the keys the APP may have written since startup (pair codes,
   * per-platform allowlists, knobs). The daemon loads config once at boot —
   * without this, a pair code generated in the settings page after the
   * daemon started is invisible and every /pair fails as "invalid".
   */
  private async refreshAuthState(): Promise<void> {
    if (!this.config) return
    const disk = await loadImRemoteConfig()
    if (!disk) return
    this.config.pairs = disk.pairs
    this.config.allowedUsersByPlatform = disk.allowedUsersByPlatform
    this.config.outboundChats = disk.outboundChats
    this.config.summaryEvery = disk.summaryEvery
    this.config.autoMode = disk.autoMode
  }

  /**
   * 门后绑定出站会话（三平台统一入口）：配对门通过、或配对成功时由
   * onImMessage 调用——未配对者的消息不能抢占广播通道。返回本次调用是否
   * 变更了绑定（变更要持久化：适配器绑定是内存态，daemon 重启即丢，
   * 不落盘则每次重启后广播静默黑洞到下一条入站）。
   */
  private applyChatBinding(platform: ImPlatform, chatId: string, force: boolean): boolean {
    if (!chatId) return false
    const adapter = this.runningAdapter(platform)
    return adapter?.bindChat?.(chatId, { force }) ?? false
  }

  /** daemon 重启后恢复各平台持久化的出站会话绑定（run() 末尾调用）。 */
  private restoreChatBindings(): void {
    for (const ch of this.botChannels()) {
      const saved = this.config?.outboundChats?.[ch.id as ImPlatform]
      if (ch.running && saved) ch.adapter.bindChat?.(saved)
    }
  }

  private async onImMessage(msg: ImInboundMessage, channelId: string): Promise<void> {
    if (channelId === 'telegram') {
      const tg = this.runningAdapter('telegram')
      if (tg instanceof TelegramAdapter && msg.callbackId) {
        await tg.answerCallback(msg.callbackId, '已收到').catch(() => {})
      }
    }
    await this.refreshAuthState()

    // The web channel is token-gated (the QR link IS the authorization) —
    // the per-platform allowlists only govern the custom IM bots.
    const platform = channelId as ImPlatform
    const platformAllowed = this.config ? allowedUsersFor(this.config, platform) : []
    if (channelId !== 'web' && !isUserAllowed(msg.userId, platformAllowed)) {
      const cmd = parseImCommand(msg.text)
      if (cmd?.kind === 'pair') {
        // 2.1.274：码按平台各铸各的——飞书的码在飞书验、企微的码在企微验，
        // 消耗与授权也只落在本平台，跨平台互不可见。验码+耗码必须是同一
        // 同步块（canConsumePair 判定即入 consumedPairCodes 集合）——中间
        // 隔着任何 await 都会让同批第二条同码 /pair 双双过关
        const pairState = this.config?.pairs?.[platform]
        if (this.config && canConsumePair(pairState, platform, cmd.code, this.consumedPairCodes)) {
          const consumedKey = platform + ':' + cmd.code.toLowerCase()
          this.consumedPairCodes.add(consumedKey)
          if (this.consumedPairCodes.size > 100) {
            this.consumedPairCodes.delete(this.consumedPairCodes.values().next().value!)
          }
          // 内存立即耗码（磁盘由持久化队列补写）：后续任何磁盘重读都复活不了它
          if (this.config.pairs) delete this.config.pairs[platform]
          await logLine(`IM 配对成功：platform=${platform} user=${msg.userId}`)
          // 配对即接管出站会话（force）：全新 daemon 的首条消息就是配对指令，
          // 不绑则「配对成功」回执无处可去（配对消息本身已满足各平台「用户
          // 先发过消息才能收推送」的前置，绑定为平台规则所允许）
          const tookChat = this.applyChatBinding(platform, msg.chatId, true)
          await this.persistDaemonKeys({
            pairs: { [platform]: undefined },
            addAllowedUser: { platform, userId: msg.userId },
            ...(tookChat ? { outboundChats: { [platform]: msg.chatId } } : {}),
          })
          await this.reply(channelId, '🔗 配对成功！现在可以直接发消息控制会话。发送 /help 查看指令。')
          this.broadcastStatus()
        } else {
          await logLine(`IM 配对失败（${platform}）：配对码无效或已过期`)
          await this.reply(channelId, '❌ 配对码无效或已过期（60 分钟有效，各平台独立），请在设置页重新生成本平台的配对码。')
        }
        return
      }
      // Throttle the warning per user+platform — a chatty group must not turn
      // the bot into an unpaired-warning spammer.
      const warnKey = channelId + ':' + msg.userId
      const last = this.unpairedWarnAt.get(warnKey) ?? 0
      if (Date.now() - last > 10 * 60_000) {
        this.unpairedWarnAt.set(warnKey, Date.now())
        await this.reply(
          channelId,
          '⚠️ 本账号未配对。请在桌面端「设置 → 远程控制」生成本平台配对码后发送 /pair <配对码>。',
        )
      }
      return
    }

    // 已配对用户的首条入站若改变了绑定（重启后恢复前），持久化之——
    // fire-and-forget：persistDaemonKeys 内部写串行，不会撕裂
    if (this.applyChatBinding(platform, msg.chatId, false)) {
      void this.persistDaemonKeys({ outboundChats: { [platform]: msg.chatId } })
    }
    const cmd = parseImCommand(msg.text)
    if (!cmd) {
      this.routePrompt(msg.text, channelId)
      return
    }
    switch (cmd.kind) {
      case 'help':
        await this.reply(channelId, IM_HELP_TEXT)
        break
      case 'status':
        await this.sendStatusToIm(channelId)
        break
      case 'stop':
        if (this.activeSessionId && this.sendToSession(this.activeSessionId, { t: 'interrupt' })) {
          await this.reply(channelId, '🛑 已请求中断当前回合。')
        } else {
          await this.reply(channelId, '当前没有已接入的会话。')
        }
        break
      case 'allow':
        await this.answerPending('allow', '✅ 已允许。', channelId)
        break
      case 'deny':
        await this.answerPending('deny', '🚫 已拒绝。', channelId)
        break
      case 'skip':
        await this.answerPending('deny', '⏭️ 已跳过。', channelId)
        break
      case 'pick':
        await this.answerPick(cmd.indices, channelId)
        break
      case 'pair':
        await this.reply(channelId, '该账号已配对，无需重复操作。')
        break
    }
  }

  private routePrompt(text: string, channelId: string): void {
    const target = this.activeSessionId
    if (!target || !this.sendToSession(target, { t: 'prompt', text })) {
      // Hold the prompt for a late-attaching session and ask the app monitor
      // to wake one (the shell auto-creates a chat tab on no_session).
      if (this.heldPrompt) {
        void this.reply(
          this.heldPrompt.channel,
          '📭 上一条暂存消息已被本条替换（同一时间只保留一条），未处理的消息请稍后重发。',
        )
      }
      this.heldPrompt = { text, channel: channelId, at: Date.now() }
      this.broadcastToMonitors({ t: 'no_session', text })
      this.broadcastStatus()
      void this.reply(
        channelId,
        this.monitors.size > 0
          ? '📭 当前没有已接入的会话——已请求 App 唤起新会话，接入后会自动处理本条消息。'
          : '📭 当前没有已接入的会话——请先在电脑上打开 Doge Code（CLI 或对话），随后重发本条消息。',
      )
      return
    }
    // 成功送达即形成远程占用：App 会锁住该会话标签的关闭按钮
    if (this.boundSessionId !== target) {
      this.boundSessionId = target
      this.broadcastStatus()
    }
  }

  private async answerPending(
    behavior: 'allow' | 'deny',
    doneNote: string,
    channelId: string,
  ): Promise<void> {
    const pending = this.pending[this.pending.length - 1]
    if (!pending) {
      await this.reply(channelId, '当前没有待应答的请求。')
      return
    }
    this.pending.pop()
    const delivered = this.sendToSession(pending.sessionId, {
      t: 'perm_res',
      id: pending.id,
      behavior,
      message: behavior === 'allow' ? undefined : '用户在远程端拒绝了该操作',
    })
    await this.reply(channelId, delivered ? doneNote : '⚠️ 目标会话已不在，应答未送达。')
    this.broadcastStatus()
  }

  private async answerPick(indices: number[], channelId: string): Promise<void> {
    const pending = [...this.pending].reverse().find(p => p.ask)
    if (!pending?.ask) {
      await this.reply(channelId, '当前没有待选择的提问。')
      return
    }
    this.pending = this.pending.filter(p => p.id !== pending.id)
    const picked = indices.map(i => pending.ask!.options[i - 1]).filter(Boolean)
    if (picked.length === 0) {
      this.sendToSession(pending.sessionId, {
        t: 'perm_res',
        id: pending.id,
        behavior: 'deny',
        message: '远程选择编号无效，已按跳过处理',
      })
      await this.reply(channelId, '⚠️ 选项编号无效，已跳过该提问。')
      return
    }
    // The client holds the original AskUserQuestion input — pass the pick
    // indices and let it build updatedInput.answers.
    const delivered = this.sendToSession(pending.sessionId, {
      t: 'perm_res',
      id: pending.id,
      behavior: 'allow',
      picks: indices,
    })
    await this.reply(
      channelId,
      delivered ? '✅ 已选择：' + picked.join(', ') : '⚠️ 目标会话已不在，应答未送达。',
    )
    this.broadcastStatus()
  }

  private primaryWebUrl(): string | null {
    if (!this.webAdapter || !this.webConfig || !this.channels.find(c => c.id === 'web')?.running) {
      return null
    }
    return webUrlCandidates(this.webConfig.port, this.webConfig.token)[0] ?? null
  }

  /** 公网 IPv6 直连地址（2.1.273）：web 频道在跑且有全局 v6 时给出——手机
   *  流量可跨网络直连同一聊天页（零配置跨网）。可能为 null（无全局 v6）。 */
  private publicV6WebUrl(): string | null {
    if (!this.webAdapter || !this.webConfig || !this.channels.find(c => c.id === 'web')?.running) {
      return null
    }
    return publicV6UrlCandidates(this.webConfig.port, this.webConfig.token)[0] ?? null
  }

  private async sendStatusToIm(channelId: string): Promise<void> {
    const lines = ['📊 远程控制状态']
    if (this.config) {
      const runningBots = this.botChannels().filter(c => c.running).map(c => c.id)
      if (runningBots.length > 0) lines.push('平台：' + runningBots.join(' + '))
    }
    const webUrl = this.primaryWebUrl()
    if (webUrl) {
      lines.push('扫码网页：' + webUrl)
    }
    lines.push('接入会话：' + this.sessions.size)
    for (const s of this.sessions.values()) {
      lines.push(
        ' · ' +
          s.label +
          '（' +
          (s.kind === 'tui' ? '终端' : '对话') +
          (s.sessionId === this.activeSessionId ? '，当前活跃' : '') +
          '，工具调用 ' +
          s.toolCount +
          '）',
      )
    }
    if (this.pending.length > 0) {
      lines.push('待应答请求：' + this.pending.length)
    }
    lines.push('Auto 模式：' + (this.config?.autoMode !== false ? '开' : '关'))
    await this.reply(channelId, lines.join('\n'))
  }

  // -----------------------------------------------------------------
  // Monitor broadcast + status file
  // -----------------------------------------------------------------

  private broadcastSessions(): void {
    this.broadcastToMonitors({
      t: 'sessions',
      active: this.activeSessionId,
      sessions: Array.from(this.sessions.values()).map(s => ({
        sessionId: s.sessionId,
        label: s.label,
        kind: s.kind,
        cwd: s.cwd,
        tools: s.toolCount,
      })),
    })
    // 会话集变化必然牵动 status 快照（active/bound/attached）——monitor 侧
    // 两个帧一起刷新，消费方不必猜先后
    this.broadcastStatus()
    void this.writeStatus()
  }

  private broadcastStatus(): void {
    const webUrl = this.primaryWebUrl()
    const cfg = this.config
    this.broadcastToMonitors({
      t: 'status',
      running: true,
      platform: cfg?.platform ?? 'none',
      attached: this.sessions.size,
      active: this.activeSessionId,
      toolCount: this.activeSessionId
        ? (this.sessions.get(this.activeSessionId)?.toolCount ?? 0)
        : 0,
      pendingAsk: this.pending.some(p => p.ask),
      // 2.1.274 起配对按平台分键——真实码在 bots[].pairCode；顶层两字段是
      // 旧帧形状的占位（无消费方），保持结构不变以防旧端解帧炸裂
      pairCode: null,
      allowedUsers: cfg ? BOT_PLATFORMS.flatMap(p => allowedUsersFor(cfg, p)) : [],
      webUrl,
      webUrls: webUrl
        ? webUrlCandidates(this.webConfig!.port, this.webConfig!.token)
        : [],
      webPort: webUrl ? this.webConfig!.port : null,
      webUrl6: this.publicV6WebUrl(),
      bound: this.boundSessionId,
      bots: this.botsChannelInfo(),
    })
  }

  /**
   * Cross-network scan entries (2.1.272): one per RUNNING bot platform — the
   * settings page renders a QR for each so the user scans with whichever app
   * they have. Pair codes and paired counts are PER-PLATFORM (2.1.274) —
   * each entry reads only its own platform's auth state. Entries whose
   * deepLink can't be built (e.g. WeCom without the user-supplied bot link)
   * still appear with deepLink null so the UI can show the per-platform
   * fix-up form.
   */
  private botsChannelInfo(): ImRemoteBotChannelStatus[] {
    const cfg = this.config
    if (!cfg) return []
    return this.botChannels()
      .filter(ch => ch.running)
      .map(ch => {
        const platform = ch.id as ImPlatform
        const pairCode = pairCodeFor(cfg, platform)
        const pairState = cfg.pairs?.[platform]
        const base = {
          pairCode,
          pairExpires: pairCode && pairState ? pairState.expires : null,
          paired: allowedUsersFor(cfg, platform).length,
        }
        if (platform === 'telegram') {
          const a = ch.adapter instanceof TelegramAdapter ? ch.adapter : null
          return {
            platform,
            botName: a?.botName || null,
            deepLink: buildBotDeepLink('telegram', { botUsername: a?.botUsername, pairCode }),
            ...base,
          }
        }
        if (platform === 'feishu') {
          return {
            platform,
            botName: null,
            deepLink: buildBotDeepLink('feishu', { appId: cfg.feishu?.appId }),
            ...base,
          }
        }
        return {
          platform,
          botName: null,
          deepLink: buildBotDeepLink('wecom', { botLink: cfg.wecom?.botLink }),
          ...base,
        }
      })
  }

  /** 为指定平台重铸配对码（持久化 + 广播）。 */
  private async regeneratePairCode(platform: ImPlatform): Promise<void> {
    if (!this.config) return
    await this.persistDaemonKeys({
      pairs: { [platform]: { code: generatePairCode(), expires: Date.now() + PAIR_CODE_TTL_MS } },
    })
    this.broadcastStatus()
  }

  /**
   * Persist ONLY the keys the daemon owns (pairs / per-platform allowlists /
   * outbound chat bindings), re-reading the file first — a full-config
   * writeback would clobber credentials the user just changed in the app
   * settings page. The merged result becomes the daemon's live config
   * (single assignment, callers never mutate this.config around it).
   * Serialized: overlapping read-merge-write invocations would lose updates.
   */
  private persistQueue: Promise<void> = Promise.resolve()

  private persistDaemonKeys(patch: {
    /** Per-platform pair-state patch; `undefined` consumes (deletes) a code. */
    pairs?: Partial<Record<ImPlatform, ImRemotePairState | undefined>>
    addAllowedUser?: { platform: ImPlatform; userId: string }
    /** Per-platform outbound chat bindings to upsert. */
    outboundChats?: Partial<Record<ImPlatform, string>>
  }): Promise<void> {
    const apply = async (): Promise<void> => {
      const disk = await loadImRemoteConfig()
      const base = disk ?? this.config
      if (!base) return
      const next: ImRemoteConfig = {
        ...base,
        pairs: { ...(base.pairs ?? {}) },
        allowedUsersByPlatform: { ...(base.allowedUsersByPlatform ?? {}) },
        outboundChats: { ...(base.outboundChats ?? {}) },
      }
      if (patch.pairs) {
        for (const p of BOT_PLATFORMS) {
          if (!(p in patch.pairs)) continue
          const st = patch.pairs[p]
          if (st) next.pairs![p] = st
          else delete next.pairs![p]
        }
      }
      if (patch.addAllowedUser) {
        const { platform, userId } = patch.addAllowedUser
        const list = next.allowedUsersByPlatform![platform] ?? []
        if (!list.includes(userId)) {
          next.allowedUsersByPlatform![platform] = [...list, userId]
        }
      }
      if (patch.outboundChats) {
        for (const p of BOT_PLATFORMS) {
          if (p in patch.outboundChats) {
            next.outboundChats![p] = patch.outboundChats[p]
          }
        }
      }
      await saveImRemoteConfig(next)
      this.config = next
    }
    // 每调用独立兑现：失败要让调用方（如配对路径）看见——否则落盘失败仍回
    // 「配对成功」；队列尾巴只自愈不外抛，后续持久化不被一次失败堵死
    const run = this.persistQueue.catch(() => {}).then(apply)
    this.persistQueue = run.catch(err => {
      void logLine(`daemon 键持久化失败（已跳过）：${String(err)}`)
    })
    return run
  }

  /** Belt-and-braces: reap sessions whose OS process died without a close. */
  private reapDeadSessions(): void {
    let changed = false
    for (const [id, s] of this.sessions) {
      try {
        process.kill(s.pid, 0)
      } catch {
        this.sessions.delete(id)
        changed = true
      }
    }
    const prevActive = this.activeSessionId
    const prevBound = this.boundSessionId
    this.demoteGoneSessions()
    if (changed || prevActive !== this.activeSessionId || prevBound !== this.boundSessionId) {
      this.broadcastSessions()
    }
  }

  /** 串行化写：5s 心跳与多点触发并发交叠时 async writeFile 会撕裂 JSON
   * （壳 readJsonRelaxed 容错，但别生产脏读）。 */
  private writeStatusQueue: Promise<void> = Promise.resolve()

  private writeStatus(): Promise<void> {
    this.writeStatusQueue = this.writeStatusQueue.then(() => this.doWriteStatus()).catch(() => {})
    return this.writeStatusQueue
  }

  private async doWriteStatus(): Promise<void> {
    const webUrl = this.primaryWebUrl()
    const status = {
      running: true,
      pid: process.pid,
      startedAt: this.startedAt,
      platform: this.config?.platform ?? 'none',
      port: this.localhostPort(),
      channels: this.channels.filter(c => c.running).map(c => c.id),
      web: webUrl
        ? { port: this.webConfig!.port, url: webUrl }
        : null,
      webUrl6: this.publicV6WebUrl(),
      active: this.activeSessionId,
      bound: this.boundSessionId,
      bots: this.botsChannelInfo(),
      sessions: Array.from(this.sessions.values()).map(s => ({
        sessionId: s.sessionId,
        label: s.label,
        kind: s.kind,
        cwd: s.cwd,
        pid: s.pid,
        tools: s.toolCount,
      })),
    }
    await writeFile(statusFilePath(), JSON.stringify(status, null, 2), 'utf8').catch(() => {})
  }
}

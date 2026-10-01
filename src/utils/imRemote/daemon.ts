import { appendFile, writeFile } from 'fs/promises'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { unlinkSync } from 'node:fs'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { logForDebugging } from '../debug.js'
import { FeishuAdapter } from './adapters/feishu.js'
import { TelegramAdapter } from './adapters/telegram.js'
import {
  imRemoteConfigPath,
  imRemoteConfigReady,
  loadImRemoteConfig,
  PAIR_CODE_TTL_MS,
  generatePairCode,
  saveImRemoteConfig,
} from './config.js'
import {
  buildAskAnswers,
  formatAgentEvent,
  formatAskMessage,
  formatPermissionMessage,
  formatToolSummary,
  formatTurnMessage,
  IM_HELP_TEXT,
  isPairCodeValid,
  isUserAllowed,
  parseImCommand,
  summaryDue,
} from './format.js'
import type {
  ImAdapter,
  ImInboundMessage,
  ImOption,
  ImRemoteClientFrame,
  ImRemoteConfig,
  ImRemoteMonitorFrame,
} from './types.js'

/**
 * IM remote-control bridge daemon (`doge im`).
 *
 * Owns all IM traffic (Telegram / Feishu HTTPS) and exposes a
 * token-authed localhost WebSocket where CLI sessions (TUI or headless)
 * and the Electron shell's monitor attach. Routing model: IM prompts go
 * to the active session (last hello wins; the app monitor may pin one
 * via set_active). Permission/ask requests are relayed to IM and the
 * first answer — remote or the local UI racing inside the session —
 * wins; the loser dismisses via perm_cancel.
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
  process.stdout.write(stamped + '\n')
  await appendFile(daemonLogFile(), stamped + '\n').catch(() => {})
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
 * 永生（外部看就是「spawn 成功但全静默」的假挂起）。模块级——daemon 类
 * 的 run() catch 也用它，放函数体内会 ReferenceError（曾令适配器连接失败
 * 的退出路径二次抛错）。 */
const fail = async (code: number, msg: string): Promise<number> => {
  await logLine(msg)
  setTimeout(() => process.exit(code), 100).unref?.()
  return code
}

/** Entry point behind the `doge im` subcommand. Resolves the exit code. */
export async function runImRemoteDaemon(): Promise<number> {
  await logLine(`daemon entry pid=${process.pid} argvTail=${process.argv.slice(-3).join(' ')}`)
  const config = await loadImRemoteConfig()
  if (!config) {
    return fail(1, `未找到远程控制配置（${imRemoteConfigPath()}），退出`)
  }
  if (!config.enabled) {
    return fail(1, '远程控制当前未启用（enabled=false），退出')
  }
  if (!imRemoteConfigReady(config)) {
    return fail(1, '所选平台的凭据不完整，退出')
  }
  if (!config.token || config.token.length < 16) {
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
  return new ImRemoteDaemon(config).run()
}

class ImRemoteDaemon {
  private config: ImRemoteConfig
  private adapter: ImAdapter
  private sessions = new Map<string, SessionConn>() // keyed by sessionId
  private monitors = new Set<DaemonSocket>()
  private activeSessionId: string | null = null
  private pending: PendingRelay[] = []
  private server: ReturnType<typeof Bun.serve> | null = null
  private startedAt = new Date().toISOString()
  private shutdownResolve: (() => void) | null = null
  private unpairedWarnAt = new Map<string, number>()

  constructor(config: ImRemoteConfig) {
    this.config = config
    this.adapter =
      config.platform === 'feishu' && config.feishu
        ? new FeishuAdapter(config.feishu, line => void logLine(`[feishu] ${line}`))
        : new TelegramAdapter(config.telegram!)
  }

  async run(): Promise<number> {
    try {
      await this.adapter.start({
        onMessage: msg =>
          void this.onImMessage(msg).catch(err =>
            logLine(`IM 消息处理异常（已忽略）：${String(err)}`),
          ),
      })
    } catch (err) {
      return fail(1, `IM 平台连接失败：${String(err)}`)
    }

    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: this.config.port,
      fetch: (req, server) => {
        const url = new URL(req.url)
        if (url.pathname !== '/' || url.searchParams.get('token') !== this.config.token) {
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
            logForDebugging(`[im-remote daemon] frame error: ${String(err)}`)
          }
        },
        close: ws => this.handleSocketClose(ws),
      },
    })

    // main.tsx owns a global SIGINT → exit(0); register in front so the
    // status-file cleanup actually runs before the process dies.
    process.prependListener('SIGINT', () => this.shutdown())
    process.prependListener('SIGTERM', () => this.shutdown())

    await logLine(
      `远程控制守护进程已启动：platform=${this.config.platform} port=${this.config.port} ` +
        `配对码=${this.currentPairCode() ?? '未生成'}`,
    )
    await this.writeStatus()

    const heartbeat = setInterval(() => {
      this.reapDeadSessions()
      void this.writeStatus()
    }, 5000)

    await new Promise<void>(resolve => {
      this.shutdownResolve = resolve
    })
    clearInterval(heartbeat)
    return 0
  }

  private shutdown(): void {
    this.adapter.stop()
    this.server?.stop(true)
    try {
      // Sync unlink: an async one loses the race with process exit.
      unlinkSync(statusFilePath())
    } catch {}
    this.shutdownResolve?.()
  }

  private currentPairCode(): string | null {
    if (this.config.pair && this.config.pair.expires > Date.now()) {
      return this.config.pair.code
    }
    return null
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

  private connBySocket(ws: DaemonSocket): SessionConn | undefined {
    for (const conn of this.sessions.values()) {
      if (conn.socket === ws) return conn
    }
    return undefined
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
          this.safeSend('ℹ️ 会话「' + conn.label + '」已断开，其待应答请求已取消。')
        }
      }
    }
    if (this.activeSessionId && !this.sessions.has(this.activeSessionId)) {
      this.activeSessionId = this.sessions.keys().next().value ?? null
    }
    this.broadcastSessions()
  }

  private handleMonitorFrame(frame: ImRemoteClientFrame | ImRemoteMonitorFrame): void {
    switch (frame.t) {
      case 'set_active':
        if (this.sessions.has(frame.sessionId)) {
          this.activeSessionId = frame.sessionId
          this.broadcastSessions()
        }
        break
      case 'get_status':
        this.broadcastStatus()
        break
      case 'regen_pair':
        void this.regeneratePairCode()
        break
      default:
        break
    }
  }

  private handleSessionFrame(conn: SessionConn, frame: ImRemoteClientFrame | ImRemoteMonitorFrame): void {
    switch (frame.t) {
      case 'turn':
        this.safeSend(
          formatTurnMessage(frame.text, frame.aborted, frame.durationMs),
        )
        this.broadcastToMonitors(frame)
        break
      case 'tools':
        conn.toolCount = frame.count
        this.broadcastToMonitors(frame)
        if (summaryDue(frame.count, this.config.summaryEvery)) {
          this.safeSend(formatToolSummary(frame.count, frame.last))
        }
        break
      case 'agent':
        this.safeSend(formatAgentEvent(frame.ev, frame.name, frame.summary))
        this.broadcastToMonitors(frame)
        break
      case 'perm_req':
        this.handleRelayRequest(conn, frame)
        break
      case 'perm_cancel': {
        const idx = this.pending.findIndex(p => p.id === frame.id)
        if (idx >= 0) {
          this.pending.splice(idx, 1)
          this.safeSend('ℹ️ 之前的请求已在本地处理，可忽略。')
          this.broadcastStatus()
        }
        break
      }
      case 'bye':
        this.sessions.delete(conn.sessionId)
        if (this.activeSessionId === conn.sessionId) {
          this.activeSessionId = this.sessions.keys().next().value ?? null
        }
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
      this.safeOptions(
        formatAskMessage(frame.ask.question, frame.ask.options, frame.ask.multi),
        options,
      )
    } else {
      this.safeOptions(
        formatPermissionMessage(frame.tool, frame.title, frame.detail),
        [
          { label: '✅ 允许', data: 'allow' },
          { label: '❌ 拒绝', data: 'deny' },
        ],
      )
    }
    this.pending.push(entry)
    this.broadcastToMonitors(frame)
    this.broadcastStatus()
  }

  // -----------------------------------------------------------------
  // IM inbound
  // -----------------------------------------------------------------

  /** Best-effort IM send — network errors must never become unhandled rejections. */
  private safeSend(text: string, options?: ImOption[]): void {
    void this.adapter
      .sendText(text)
      .then(undefined, err => {
        logForDebugging(`[im-remote daemon] send failed: ${String(err)}`)
      })
  }

  private safeOptions(text: string, options: ImOption[]): void {
    void this.adapter
      .sendOptions(text, options)
      .then(undefined, err => {
        logForDebugging(`[im-remote daemon] sendOptions failed: ${String(err)}`)
      })
  }

  /**
   * Re-read the keys the APP may have written since startup (pair code,
   * allowed users, knobs). The daemon loads config once at boot — without
   * this, a pair code generated in the settings page after the daemon
   * started is invisible and every /pair fails as "invalid".
   */
  private async refreshAuthState(): Promise<void> {
    const disk = await loadImRemoteConfig()
    if (!disk) return
    this.config.pair = disk.pair
    this.config.allowedUsers = disk.allowedUsers
    this.config.summaryEvery = disk.summaryEvery
    this.config.autoMode = disk.autoMode
  }

  private async onImMessage(msg: ImInboundMessage): Promise<void> {
    // Chat binding happens ONLY for allowed users (below) — letting a
    // stranger's first message lock the outbound chat would redirect all
    // subsequent replies/prompts to their chat.
    if (this.adapter instanceof TelegramAdapter) {
      if (msg.callbackId) {
        await this.adapter.answerCallback(msg.callbackId, '已收到').catch(() => {})
      }
    }
    await this.refreshAuthState()

    if (!isUserAllowed(msg.userId, this.config.allowedUsers)) {
      const cmd = parseImCommand(msg.text)
      if (cmd?.kind === 'pair') {
        if (isPairCodeValid(this.config, cmd.code, Date.now())) {
          await logLine(`IM 配对成功：user=${msg.userId}`)
          this.config.allowedUsers = [...this.config.allowedUsers, msg.userId]
          this.config.pair = undefined
          await this.persistDaemonKeys({ pair: undefined, addAllowedUser: msg.userId })
          await this.adapter.sendText('🔗 配对成功！现在可以直接发消息控制会话。发送 /help 查看指令。')
          this.broadcastStatus()
        } else {
          await logLine('IM 配对失败：配对码无效或已过期')
          await this.adapter.sendText('❌ 配对码无效或已过期（60 分钟有效），请在设置页重新生成。')
        }
        return
      }
      // Throttle the warning per user — a chatty group must not turn the
      // bot into an unpaired-warning spammer.
      const last = this.unpairedWarnAt.get(msg.userId) ?? 0
      if (Date.now() - last > 10 * 60_000) {
        this.unpairedWarnAt.set(msg.userId, Date.now())
        await this.adapter.sendText(
          '⚠️ 本账号未配对。请在桌面端「设置 → 远程控制」生成配对码后发送 /pair <配对码>。',
        )
      }
      return
    }

    if (this.adapter instanceof TelegramAdapter) {
      this.adapter.observeChatId(msg.chatId)
    }
    const cmd = parseImCommand(msg.text)
    if (!cmd) {
      this.routePrompt(msg.text)
      return
    }
    switch (cmd.kind) {
      case 'help':
        await this.adapter.sendText(IM_HELP_TEXT)
        break
      case 'status':
        await this.sendStatusToIm()
        break
      case 'stop':
        if (this.activeSessionId && this.sendToSession(this.activeSessionId, { t: 'interrupt' })) {
          await this.adapter.sendText('🛑 已请求中断当前回合。')
        } else {
          await this.adapter.sendText('当前没有已接入的会话。')
        }
        break
      case 'allow':
        await this.answerPending('allow', '✅ 已允许。')
        break
      case 'deny':
        await this.answerPending('deny', '🚫 已拒绝。')
        break
      case 'skip':
        await this.answerPending('deny', '⏭️ 已跳过。')
        break
      case 'pick':
        await this.answerPick(cmd.indices)
        break
      case 'pair':
        await this.adapter.sendText('该账号已配对，无需重复操作。')
        break
    }
  }

  private routePrompt(text: string): void {
    const target = this.activeSessionId
    if (!target || !this.sendToSession(target, { t: 'prompt', text })) {
      this.safeSend('当前没有已接入的会话——请先在电脑上打开 Doge Code（或等待会话自动接入）。')
    }
  }

  private async answerPending(behavior: 'allow' | 'deny', doneNote: string): Promise<void> {
    const pending = this.pending[this.pending.length - 1]
    if (!pending) {
      await this.adapter.sendText('当前没有待应答的请求。')
      return
    }
    this.pending.pop()
    const delivered = this.sendToSession(pending.sessionId, {
      t: 'perm_res',
      id: pending.id,
      behavior,
      message: behavior === 'allow' ? undefined : '用户在远程端拒绝了该操作',
    })
    await this.adapter.sendText(delivered ? doneNote : '⚠️ 目标会话已不在，应答未送达。')
    this.broadcastStatus()
  }

  private async answerPick(indices: number[]): Promise<void> {
    const pending = [...this.pending].reverse().find(p => p.ask)
    if (!pending?.ask) {
      await this.adapter.sendText('当前没有待选择的提问。')
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
      await this.adapter.sendText('⚠️ 选项编号无效，已跳过该提问。')
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
    await this.adapter.sendText(delivered ? '✅ 已选择：' + picked.join(', ') : '⚠️ 目标会话已不在，应答未送达。')
    this.broadcastStatus()
  }

  private async sendStatusToIm(): Promise<void> {
    const lines = ['📊 远程控制状态']
    lines.push('平台：' + this.config.platform)
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
    lines.push('Auto 模式：' + (this.config.autoMode ? '开' : '关'))
    await this.adapter.sendText(lines.join('\n'))
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
    void this.writeStatus()
  }

  private broadcastStatus(): void {
    this.broadcastToMonitors({
      t: 'status',
      running: true,
      platform: this.config.platform,
      attached: this.sessions.size,
      active: this.activeSessionId,
      toolCount: this.activeSessionId
        ? (this.sessions.get(this.activeSessionId)?.toolCount ?? 0)
        : 0,
      pendingAsk: this.pending.some(p => p.ask),
      pairCode: this.currentPairCode(),
      allowedUsers: this.config.allowedUsers,
    })
  }

  private async regeneratePairCode(): Promise<void> {
    this.config.pair = { code: generatePairCode(), expires: Date.now() + PAIR_CODE_TTL_MS }
    await this.persistDaemonKeys({ pair: this.config.pair })
    this.broadcastStatus()
  }

  /**
   * Persist ONLY the keys the daemon owns (pair / allowedUsers), re-reading
   * the file first — a full-config writeback would clobber credentials the
   * user just changed in the app settings page.
   */
  private async persistDaemonKeys(patch: {
    pair?: ImRemoteConfig['pair'] | undefined
    addAllowedUser?: string
  }): Promise<void> {
    const disk = await loadImRemoteConfig()
    const base = disk ?? this.config
    const next: ImRemoteConfig = {
      ...base,
      // 'pair' in patch 才动 pair —— pair: undefined 表示「清除配对码」，
      // 不能用 !== undefined 三元（会把清除误当保留）
      pair: 'pair' in patch ? patch.pair : base.pair,
      allowedUsers: patch.addAllowedUser
        ? [...base.allowedUsers, patch.addAllowedUser]
        : base.allowedUsers,
    }
    await saveImRemoteConfig(next)
    this.config = next
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
    if (this.activeSessionId && !this.sessions.has(this.activeSessionId)) {
      this.activeSessionId = this.sessions.keys().next().value ?? null
      changed = true
    }
    if (changed) {
      this.broadcastSessions()
    }
  }

  private async writeStatus(): Promise<void> {
    const status = {
      running: true,
      pid: process.pid,
      startedAt: this.startedAt,
      platform: this.config.platform,
      port: this.config.port,
      active: this.activeSessionId,
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


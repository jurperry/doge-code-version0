import { getSessionId } from '../../bootstrap/state.js'
import type { BridgePermissionCallbacks } from '../../bridge/bridgePermissionCallbacks.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { logForDebugging } from '../debug.js'
import { buildAskAnswers, parseAskPayload, safeJsonPreview } from './format.js'
import { setSdkEventTap } from '../sdkEventQueue.js'
import { loadImRemoteConfig } from './config.js'
import type {
  ImRemoteClientFrame,
  ImRemoteConfig,
  ImRemoteDaemonFrame,
  ImRemoteSessionKind,
} from './types.js'

/**
 * Session-side client of the IM remote-control bridge daemon.
 *
 * One singleton per CLI process. attach() is a no-op unless the user
 * enabled remote control in ~/.doge/im-remote.json AND the local daemon
 * is reachable — ordinary sessions pay one failed localhost connection
 * at most. Everything is best-effort: when the daemon is down the client
 * silently drops outbound events and never blocks the session.
 */

type PermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  message?: string
}

type ClientHandlers = {
  onPrompt?: (text: string) => void
  onPermissionResponse?: (id: string, response: PermissionResponse) => void
  onInterrupt?: () => void
  onConnected?: (config: ImRemoteConfig) => void
}

type AttachState = 'idle' | 'attached' | 'detached'

const CONNECT_TIMEOUT_MS = 800
/** Daemon may come up after the session started (user enables remote
 *  later) — keep probing localhost at a relaxed cadence. */
const RETRY_INTERVAL_MS = 8000
/** Cap probes for machines with no config file (~2.5 min) — after that a
 *  restart re-attaches; sessions shouldn't poll a missing file forever. */
const MISSING_CONFIG_RETRY_CAP = 20

class ImRemoteClient {
  private state: AttachState = 'idle'
  private ws: WebSocket | null = null
  private handlers: ClientHandlers = {}
  private config: ImRemoteConfig | null
  private attaching: Promise<boolean> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryKind: ImRemoteSessionKind | null = null
  private retryLabel = ''
  /** Probes while the config file doesn't exist at all (never configured). */
  private missingConfigRetries = 0
  /** TUI permission relay: pending request ids -> response handler. */
  private pendingPermissions = new Map<string, (res: PermissionResponse) => void>()
  /** Original AskUserQuestion inputs per pending request id. */
  private pendingAskInputs = new Map<string, Record<string, unknown>>()
  private toolCount = 0

  setHandlers(handlers: ClientHandlers): void {
    this.handlers = { ...this.handlers, ...handlers }
  }

  isConnected(): boolean {
    return this.state === 'attached' && this.ws?.readyState === WebSocket.OPEN
  }

  getConfig(): ImRemoteConfig | null {
    return this.config
  }

  /**
   * Try to attach to the local bridge daemon. Resolves true when the
   * session is attached. Idempotent — concurrent calls share one attempt.
   * Failed attempts reschedule themselves so a daemon that comes up later
   * (user enabling remote after sessions opened) still gets this session.
   */
  attach(kind: ImRemoteSessionKind, label: string): Promise<boolean> {
    if (process.env.DOGE_IM_REMOTE_DEBUG) console.error(`[im-remote] attach enter state=${this.state} attaching=${!!this.attaching}`)
    if (this.state === 'attached') return Promise.resolve(true)
    this.retryKind = kind
    this.retryLabel = label
    if (this.attaching) return this.attaching
    this.attaching = (async () => {
      try {
        if (process.env.DOGE_IM_REMOTE_DISABLE) return false
        const config = await loadImRemoteConfig()
        if (process.env.DOGE_IM_REMOTE_DEBUG) {
          // Never log the full config — the first 160 chars would cover the
          // WS token and bot credentials.
          console.error(
            `[im-remote] attach config=${
              config
                ? JSON.stringify({ enabled: config.enabled, platform: config.platform, port: config.port, hasToken: !!config.token })
                : 'null'
            }`,
          )
        }
        if (!config?.enabled || !config.token) {
          // Remote may be enabled AFTER this session started (settings page
          // or `doge im` coming up later) — keep a slow probe alive, but
          // cap it for never-configured machines so idle sessions aren't
          // stuck reading a nonexistent file forever.
          if (config || this.missingConfigRetries < MISSING_CONFIG_RETRY_CAP) {
            if (!config) this.missingConfigRetries++
            this.scheduleRetry()
          }
          return false
        }
        this.config = config
        try {
          const ok = await this.connect(config, kind, label)
          this.state = ok ? 'attached' : 'detached'
          if (ok) {
            this.registerSdkTap()
            this.handlers.onConnected?.(config)
          } else {
            this.scheduleRetry()
          }
          return ok
        } catch (err) {
          this.state = 'detached'
          logForDebugging(`[im-remote] attach failed: ${String(err)}`)
          this.scheduleRetry()
          return false
        }
      } finally {
        // MUST clear on every exit path (the config-missing early return
        // used to skip the inner finally and wedge every later attach).
        this.attaching = null
      }
    })()
    return this.attaching
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.state === 'attached' || this.retryKind === null) return
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null
        void this.attach(this.retryKind!, this.retryLabel)
      },
      RETRY_INTERVAL_MS,
    )
    // One-shot `doge -p` sessions must not be pinned alive by the probe.
    this.retryTimer.unref?.()
  }

  private connect(config: ImRemoteConfig, kind: ImRemoteSessionKind, label: string): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!ok) {
          try {
            this.ws?.close()
          } catch {}
          this.ws = null
        }
        resolve(ok)
      }
      const url =
        process.env.DOGE_IM_REMOTE_WS ??
        'ws://127.0.0.1:' + config.port + '/?token=' + encodeURIComponent(config.token)
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch {
        finish(false)
        return
      }
      this.ws = ws
      const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS)
      ws.onopen = () => {
        if (process.env.DOGE_IM_REMOTE_DEBUG) console.error('[im-remote] ws open')
        const frame: ImRemoteClientFrame = {
          t: 'hello',
          sessionId: getSessionId(),
          kind,
          label,
          cwd: process.cwd(),
          pid: process.pid,
        }
        ws.send(JSON.stringify(frame))
        finish(true)
      }
      ws.onmessage = ev => {
        this.handleFrame(String(ev.data))
      }
      ws.onclose = () => {
        if (process.env.DOGE_IM_REMOTE_DEBUG) console.error('[im-remote] ws closed')
        this.state = 'detached'
        this.ws = null
        this.pendingPermissions.clear()
        this.pendingAskInputs.clear()
        // Daemon restarted / dropped — try to reattach.
        this.scheduleRetry()
      }
      ws.onerror = () => {
        if (process.env.DOGE_IM_REMOTE_DEBUG) console.error('[im-remote] ws error')
        finish(false)
      }
    })
  }

  private handleFrame(raw: string): void {
    let frame: ImRemoteDaemonFrame
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    switch (frame.t) {
      case 'prompt':
        this.handlers.onPrompt?.(frame.text)
        break
      case 'perm_res': {
        const pending = this.pendingPermissions.get(frame.id)
        this.pendingPermissions.delete(frame.id)
        const response = this.resolvePermissionResponse(frame)
        pending?.(response)
        this.handlers.onPermissionResponse?.(frame.id, response)
        break
      }
      case 'interrupt':
        this.handlers.onInterrupt?.()
        break
      default:
        break
    }
  }

  /**
   * Turn a daemon perm_res into the response shape callers expect. Ask
   * picks are expanded into `updatedInput.answers` here because only the
   * client still holds the original tool input.
   */
  private resolvePermissionResponse(
    frame: Extract<ImRemoteDaemonFrame, { t: 'perm_res' }>,
  ): PermissionResponse {
    if (frame.behavior === 'allow' && frame.picks && this.pendingAskInputs.has(frame.id)) {
      const input = this.pendingAskInputs.get(frame.id)!
      const updated = buildAskAnswers(input, frame.picks)
      if (updated) {
        return { behavior: 'allow', updatedInput: updated }
      }
    }
    return {
      behavior: frame.behavior,
      updatedInput: frame.updatedInput,
      message: frame.message,
    }
  }

  private send(frame: ImRemoteClientFrame): void {
    if (!this.isConnected()) return
    try {
      this.ws?.send(JSON.stringify(frame))
    } catch (err) {
      logForDebugging(`[im-remote] send failed: ${String(err)}`)
    }
  }

  reportTurn(text: string, aborted: boolean, durationMs: number): void {
    this.send({ t: 'turn', aborted, text, durationMs })
  }

  /** Increment the process tool-call counter and report the tick. */
  nextToolTick(toolName: string): void {
    this.toolCount += 1
    this.toolTick(this.toolCount, toolName)
  }

  toolTick(count: number, lastTool: string): void {
    this.send({ t: 'tools', count, last: lastTool })
  }

  agentEvent(
    ev: 'started' | 'completed' | 'failed' | 'stopped' | 'teams_on',
    name?: string,
    summary?: string,
  ): void {
    this.send({ t: 'agent', ev, name, summary })
  }

  permissionRequest(params: {
    id: string
    tool: string
    title: string
    detail: string
    ask?: { question: string; options: string[]; multi: boolean }
    /** Original tool input when `ask` is set — used to patch answers. */
    askInput?: Record<string, unknown>
    onResponse: (res: PermissionResponse) => void
  }): void {
    const { onResponse, askInput, ...frame } = params
    this.pendingPermissions.set(params.id, onResponse)
    if (askInput) {
      this.pendingAskInputs.set(params.id, askInput)
    }
    this.send(frame)
  }

  /** Dismiss a pending relay (local side won the race / request aborted). */
  permissionCancel(id: string): void {
    this.pendingPermissions.delete(id)
    this.pendingAskInputs.delete(id)
    this.send({ t: 'perm_cancel', id })
  }

  /**
   * BridgePermissionCallbacks-compatible relay for the TUI permission
   * flow — interactiveHandler races it alongside the local dialog, hooks
   * and classifier via claim(), exactly like the claude.ai bridge.
   */
  buildPermissionCallbacks(): BridgePermissionCallbacks {
    return {
      sendRequest: (requestId, toolName, input, _toolUseId, description) => {
        let ask: { question: string; options: string[]; multi: boolean } | undefined
        let title = description || toolName
        if (toolName === 'AskUserQuestion') {
          const parsed = parseAskPayload(input)
          if (parsed) {
            ask = parsed
            title = parsed.question
          }
        }
        this.permissionRequest({
          id: requestId,
          tool: toolName,
          title,
          detail: safeJsonPreview(input),
          ask,
          askInput: ask ? input : undefined,
          onResponse: () => {},
        })
      },
      // Local user answered first — dismiss the pending IM prompt. The
      // daemon annotates the IM thread with the local outcome.
      sendResponse: (requestId, response) => {
        void response
        this.permissionCancel(requestId)
      },
      cancelRequest: requestId => {
        this.permissionCancel(requestId)
      },
      onResponse: (requestId, handler) => {
        this.pendingPermissions.set(requestId, handler)
        return () => {
          this.pendingPermissions.delete(requestId)
        }
      },
    }
  }

  /** Forward task_* SDK events (both TUI and headless) as agent events. */
  private registerSdkTap(): void {
    setSdkEventTap(event => {
      if (event.type !== 'system') return
      if (event.subtype === 'task_started') {
        if (event.task_type === 'shell_bg') return
        this.agentEvent('started', event.description || event.task_type)
      } else if (event.subtype === 'task_notification') {
        const ev =
          event.status === 'completed'
            ? 'completed'
            : event.status === 'failed'
              ? 'failed'
              : ('stopped' as const)
        this.agentEvent(ev, undefined, event.summary || undefined)
      }
    })
  }

  destroy(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.retryKind = null
    if (this.state === 'attached') {
      this.send({ t: 'bye' })
    }
    setSdkEventTap(undefined)
    try {
      this.ws?.close()
    } catch {}
    this.ws = null
    this.state = 'idle'
    this.pendingPermissions.clear()
    this.pendingAskInputs.clear()
  }
}

export const imRemote = new ImRemoteClient()

/** Wrap any CanUseToolFn so every tool call reports a tick to the daemon. */
export function wrapImRemoteToolCounter(canUseTool: CanUseToolFn): CanUseToolFn {
  return async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    imRemote.nextToolTick(tool.name)
    return canUseTool(tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision)
  }
}

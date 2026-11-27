import { randomUUID } from 'crypto'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest, StdoutMessage } from '../entrypoints/sdk/controlTypes.js'
import type { RemotePermissionResponse } from '../remote/RemoteSessionManager.js'
import { tunnelCredentialEnvironment } from './sshCommand.js'
import { sshReasoningEnvironment } from '../utils/model/sshReasoningPolicy.js'
import { PERMISSION_MODES, type PermissionMode } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import { killProcessTree } from '../utils/processTree.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

export type SSHSessionCallbacks = {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (request: SDKControlPermissionRequest, requestId: string) => void
  onPermissionCancelled?: (requestId: string, toolUseId?: string) => void
  onPermissionMode?: (mode: PermissionMode) => void
  onPermissionModeError?: (mode: PermissionMode, error: string) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

export type SSHSessionBootstrap = {
  proxyToken?: string
  initializeTimeoutMs?: number
  cleanup?: () => void
}

function isStdoutMessage(value: unknown): value is StdoutMessage {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
}

function readPermissionMode(value: unknown): PermissionMode | undefined {
  return PERMISSION_MODES.find(mode => mode === value)
}

type Outgoing =
  | { type: 'user'; content: RemoteMessageContent; opts?: { uuid?: string } }
  | { type: 'mode'; requestId: string; mode: PermissionMode }
  | { type: 'model'; model: string; env: Record<string, string> }
  | { type: 'effort'; level: string }

export class SSHSessionManager {
  private buffer = ''
  private connected = false
  private disconnecting = false
  private disconnected = false
  private initializeTimer: NodeJS.Timeout | undefined
  private readonly initializeRequestId = `ssh-init-${randomUUID()}`
  private readonly pendingPermissions = new Map<string, SDKControlPermissionRequest>()
  private readonly queuedMessages: Outgoing[] = []
  private readonly pendingModes = new Map<string, PermissionMode>()
  private remoteMode: PermissionMode | undefined

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly callbacks: SSHSessionCallbacks,
    private readonly bootstrap: SSHSessionBootstrap = {},
  ) {}

  connect(): void {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      this.fail(new Error(`Remote CLI exited before initialization (code=${this.proc.exitCode ?? this.proc.signalCode})`))
      return
    }
    this.initializeTimer = setTimeout(() => {
      this.fail(new Error(`Remote CLI initialization timed out after ${this.bootstrap.initializeTimeoutMs ?? 15_000}ms`))
    }, this.bootstrap.initializeTimeoutMs ?? 15_000)
    this.initializeTimer.unref()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.proc.stdin.on('error', error => this.fail(error))
    this.proc.once('error', error => this.fail(error))
    this.proc.once('exit', () => {
      this.cleanupResources()
      this.finishDisconnect()
    })
    if (!this.write({
      type: 'control_request',
      request_id: this.initializeRequestId,
      request: { subtype: 'initialize' },
    })) this.fail(new Error('Failed to write the initialize request'))
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim()) this.consumeLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private consumeLine(line: string): void {
    let value: unknown
    try {
      value = jsonParse(line)
    } catch {
      this.fail(new Error('Remote CLI emitted invalid stream-json output'))
      return
    }
    if (!isStdoutMessage(value)) {
      this.fail(new Error('Remote CLI emitted an invalid protocol message'))
      return
    }

    if (value.type === 'control_response') {
      const requestId = typeof value.response?.request_id === 'string'
        ? value.response.request_id
        : typeof value.request_id === 'string' ? value.request_id : undefined
      if (requestId === this.initializeRequestId) {
        if (value.response?.subtype === 'error') {
          this.fail(new Error(String(value.response.error ?? 'Remote CLI initialization failed')))
          return
        }
        if (!this.connected) {
          if (this.initializeTimer) clearTimeout(this.initializeTimer)
          this.initializeTimer = undefined
          if (this.bootstrap.proxyToken && !this.write({
            type: 'update_environment_variables',
            variables: { ...tunnelCredentialEnvironment(this.bootstrap.proxyToken), ...sshReasoningEnvironment() },
          })) {
            this.fail(new Error('Failed to forward the SSH tunnel credentials'))
            return
          }
          this.connected = true
          this.updateRemoteMode(value.response?.response?.permissionMode)
          for (const message of this.queuedMessages.splice(0)) {
            if (!this.writeOutgoing(message)) return
          }
          this.callbacks.onConnected?.()
        }
      } else if (requestId) {
        const requested = this.pendingModes.get(requestId)
        if (requested === undefined) return
        this.pendingModes.delete(requestId)
        if (value.response?.subtype === 'success') {
          this.updateRemoteMode(readPermissionMode(value.response.response?.mode) ?? requested)
        } else {
          this.callbacks.onPermissionModeError?.(requested, String(value.response?.error ?? 'Remote CLI rejected the permission mode change'))
          if (!this.pendingModes.size) this.callbacks.onPermissionMode?.(this.remoteMode ?? 'default')
        }
      }
      return
    }

    if (value.type === 'control_request') {
      const requestId = typeof value.request_id === 'string' ? value.request_id : ''
      if (!requestId) return
      if (value.request?.subtype === 'can_use_tool') {
        this.pendingPermissions.set(requestId, value.request)
        this.callbacks.onPermissionRequest(value.request, requestId)
      } else {
        this.sendErrorResponse(requestId, `Unsupported control request subtype: ${String(value.request?.subtype ?? '')}`)
      }
      return
    }

    if (value.type === 'control_cancel_request') {
      const requestId = String(value.request_id ?? '')
      const pending = this.pendingPermissions.get(requestId)
      this.pendingPermissions.delete(requestId)
      this.callbacks.onPermissionCancelled?.(requestId, pending?.tool_use_id)
      return
    }

    if (value.type === 'keep_alive' || value.type === 'streamlined_text' || value.type === 'streamlined_tool_use_summary') return
    if (value.type === 'system' && (value.subtype === 'status' ||
      (value.subtype === 'init' && this.remoteMode === undefined))) {
      this.updateRemoteMode(value.permissionMode)
    }
    this.callbacks.onMessage(value as SDKMessage)
  }

  private updateRemoteMode(value: unknown): void {
    const mode = readPermissionMode(value)
    if (mode === undefined) return
    this.remoteMode = mode
    if (!this.pendingModes.size) this.callbacks.onPermissionMode?.(mode)
  }

  async sendMessage(content: RemoteMessageContent, opts?: { uuid?: string }): Promise<boolean> {
    return this.enqueue({ type: 'user', content, opts })
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.disconnected || this.disconnecting) return
    if (readPermissionMode(mode) === undefined) return
    const requestId = randomUUID()
    this.pendingModes.set(requestId, mode)
    if (!this.enqueue({ type: 'mode', requestId, mode })) this.pendingModes.delete(requestId)
  }

  /**
   * 把本机的模型选择同步到远端：先推模型环境白名单（空串 = 删除远端旧值），
   * 再 set_model。两者在已连接的 stdin 上有序送达，先于下一条用户消息。
   */
  setModel(model: string, env: Record<string, string>): void {
    this.enqueue({ type: 'model', model, env })
  }

  setEffort(level: string): void {
    this.enqueue({ type: 'effort', level })
  }

  private enqueue(message: Outgoing): boolean {
    if (this.disconnected || this.disconnecting) return false
    if (!this.connected) {
      if (this.proc.stdin.destroyed) return false
      this.queuedMessages.push(message)
      return true
    }
    return this.writeOutgoing(message)
  }

  private writeOutgoing(message: Outgoing): boolean {
    if (message.type === 'effort') {
      const sent = this.write({
        type: 'update_environment_variables',
        variables: { CLAUDE_CODE_EFFORT_LEVEL: message.level },
      })
      if (!sent) this.fail(new Error('Failed to send the effort change'))
      return sent
    }
    if (message.type === 'model') {
      const sent = this.write({ type: 'update_environment_variables', variables: {
        ...message.env,
        ...(this.bootstrap.proxyToken ? sshReasoningEnvironment() : {}),
      } }) &&
        this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_model', model: message.model } })
      if (!sent) this.fail(new Error('Failed to send the model change'))
      return sent
    }
    const sent = this.write(message.type === 'mode' ? {
      type: 'control_request',
      request_id: message.requestId,
      request: { subtype: 'set_permission_mode', mode: message.mode },
    } : {
      type: 'user',
      ...(message.opts?.uuid ? { uuid: message.opts.uuid } : {}),
      session_id: '',
      message: { role: 'user', content: message.content },
      parent_tool_use_id: null,
    })
    if (!sent) this.fail(new Error(message.type === 'mode'
      ? 'Failed to send the permission mode change' : 'Failed to send the user message'))
    return sent
  }

  respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void {
    if (!this.pendingPermissions.delete(requestId)) return
    if (!this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: result.behavior,
          ...(result.behavior === 'allow' ? { updatedInput: result.updatedInput } : { message: result.message }),
        },
      },
    })) this.fail(new Error('Failed to answer the permission request'))
  }

  sendInterrupt(): void {
    if (this.disconnected || this.disconnecting) return
    if (!this.connected) {
      for (let i = this.queuedMessages.length - 1; i >= 0; i--) {
        if (this.queuedMessages[i]?.type === 'user') this.queuedMessages.splice(i, 1)
      }
      return
    }
    if (!this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    })) this.fail(new Error('Failed to send the interrupt request'))
  }

  private sendErrorResponse(requestId: string, error: string): void {
    if (!this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })) {
      this.fail(new Error('Failed to send the control error response'))
    }
  }

  private write(message: Record<string, unknown>): boolean {
    if (this.proc.stdin.destroyed || !this.proc.stdin.writable) return false
    try {
      this.proc.stdin.write(`${jsonStringify(message)}\n`)
      return true
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  private cleanupResources(): void {
    if (this.bootstrap.cleanup) this.bootstrap.cleanup()
    else killProcessTree(this.proc)
  }

  private fail(error: Error): void {
    if (this.disconnected) return
    this.callbacks.onError?.(error)
    this.finishDisconnect()
    this.cleanupResources()
  }

  private finishDisconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    this.connected = false
    if (this.initializeTimer) clearTimeout(this.initializeTimer)
    this.initializeTimer = undefined
    this.pendingPermissions.clear()
    this.pendingModes.clear()
    this.queuedMessages.length = 0
    if (!this.disconnecting) this.callbacks.onDisconnected?.()
  }

  disconnect(): void {
    if (this.disconnecting || this.disconnected) return
    this.disconnecting = true
    if (this.initializeTimer) clearTimeout(this.initializeTimer)
    this.initializeTimer = undefined
    this.pendingPermissions.clear()
    logForDebugging('[SSHSessionManager] disconnecting')
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'end_session' } })
    this.proc.stdin.end()
    const timer = setTimeout(() => {
      if (this.proc.exitCode === null && this.proc.signalCode === null) this.cleanupResources()
    }, 1000)
    timer.unref()
    this.finishDisconnect()
  }

  isConnected(): boolean {
    return this.connected && !this.disconnected
  }
}

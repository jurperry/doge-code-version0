import { randomUUID } from 'crypto'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest, StdoutMessage } from '../entrypoints/sdk/controlTypes.js'
import type { RemotePermissionResponse } from '../remote/RemoteSessionManager.js'
import { logForDebugging } from '../utils/debug.js'
import { killProcessTree } from '../utils/processTree.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

export type SSHSessionCallbacks = {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (request: SDKControlPermissionRequest, requestId: string) => void
  onPermissionCancelled?: (requestId: string, toolUseId?: string) => void
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

export class SSHSessionManager {
  private buffer = ''
  private connected = false
  private disconnecting = false
  private disconnected = false
  private initializeTimer: NodeJS.Timeout | undefined
  private readonly initializeRequestId = `ssh-init-${randomUUID()}`
  private readonly pendingPermissions = new Map<string, SDKControlPermissionRequest>()
  private readonly queuedMessages: { content: RemoteMessageContent; opts?: { uuid?: string } }[] = []

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
            variables: {
              DOGE_SSH_PROXY_TOKEN: this.bootstrap.proxyToken,
              ANTHROPIC_CUSTOM_HEADERS: `x-doge-ssh-proxy: ${this.bootstrap.proxyToken}`,
            },
          })) {
            this.fail(new Error('Failed to forward the SSH tunnel credentials'))
            return
          }
          this.connected = true
          for (const message of this.queuedMessages.splice(0)) {
            if (!this.writeUserMessage(message.content, message.opts)) {
              this.fail(new Error('Failed to forward the queued user message'))
              return
            }
          }
          this.callbacks.onConnected?.()
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
    this.callbacks.onMessage(value as SDKMessage)
  }

  async sendMessage(content: RemoteMessageContent, opts?: { uuid?: string }): Promise<boolean> {
    if (this.disconnected || this.disconnecting || this.proc.stdin.destroyed) return false
    if (!this.connected) {
      this.queuedMessages.push({ content, opts })
      return true
    }
    return this.writeUserMessage(content, opts)
  }

  private writeUserMessage(content: RemoteMessageContent, opts?: { uuid?: string }): boolean {
    const sent = this.write({
      type: 'user',
      ...(opts?.uuid ? { uuid: opts.uuid } : {}),
      session_id: '',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    })
    if (!sent) this.fail(new Error('Failed to send the user message'))
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
      this.queuedMessages.length = 0
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

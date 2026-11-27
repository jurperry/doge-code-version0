import { randomUUID } from 'crypto'
import { killProcessTree } from '../utils/processTree.js'
import type { SSHSession } from './createSSHSession.js'
import { remoteModelEnvironment } from './sshCommand.js'
import { sshReasoningEnvironment } from '../utils/model/sshReasoningPolicy.js'

export type RelayIO = {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

type WireMessage = {
  type?: unknown
  request_id?: unknown
  request?: { subtype?: unknown }
  response?: { request_id?: unknown; subtype?: unknown }
  variables?: unknown
}

const INITIALIZE_TIMEOUT_MS = 15_000
const parse = (line: string): WireMessage | undefined => {
  try { return JSON.parse(line) as WireMessage } catch { return undefined }
}

/**
 * `doge ssh <host> <dir> --stream`：把本进程的 stdio 接到远端 headless CLI 的
 * stream-json 通道，宿主（桌面壳）因此用与本地会话完全相同的协议驱动远端。
 *
 * 中继只做三件事：代为握手并把应答归还给宿主的 initialize、把宿主的 env
 * 更新同步为远端的模型环境白名单、其余消息原样双向透传。密钥与真实端点
 * 留在本进程的认证代理里，不会随 env 更新发往远端。
 */
export class SSHStreamRelay {
  private readonly initializeRequestId = `ssh-relay-${randomUUID()}`
  private hostInitializeId: unknown
  private buffers = { host: '', remote: '' }
  private queued = { host: [] as string[], remote: [] as string[] }
  private ready = false
  private stopped = false
  private exitCode = 0
  private initializeTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly session: SSHSession,
    private readonly io: RelayIO,
  ) {}

  /** 宿主的 initialize 行通常先于中继就绪到达（管道缓冲），就绪前的行一律暂存。 */
  start(): Promise<number> {
    const proc = this.session.proc
    const exited = new Promise<number | null>(resolve => {
      proc.once('error', () => resolve(1))
      proc.once('exit', code => resolve(code))
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => this.io.stderr.write(chunk))
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.pump('remote', chunk))
    const stdin = this.io.stdin as NodeJS.ReadableStream & { setEncoding?: (encoding: 'utf8') => void }
    stdin.setEncoding?.('utf8')
    stdin.on('data', (chunk: string | Buffer) => this.pump('host', chunk.toString()))
    // 宿主先关闭管道：让远端读到 EOF 自行收尾，不必等它被强杀
    stdin.on('end', () => { if (!this.stopped) proc.stdin.end() })
    stdin.on('error', () => {})
    this.io.stdout.on('error', () => {})
    this.io.stderr.on('error', () => {})

    this.initializeTimer = setTimeout(
      () => this.abort('Remote CLI initialization timed out'),
      INITIALIZE_TIMEOUT_MS,
    )
    this.initializeTimer.unref?.()
    this.send({
      type: 'control_request',
      request_id: this.initializeRequestId,
      request: { subtype: 'initialize' },
    })
    return exited.then(code => {
      // 远端在握手完成前退出：原因作为 initialize 的错误应答交给宿主呈现
      if (!this.ready && !this.stopped) {
        this.abort(`Remote CLI exited before initialization (code=${proc.exitCode ?? proc.signalCode ?? 'unknown'})`)
      }
      this.io.stdout.end()
      return this.stopped ? this.exitCode : code ?? 0
    })
  }

  private pump(side: 'host' | 'remote', chunk: string): void {
    this.buffers[side] += chunk
    let newline = this.buffers[side].indexOf('\n')
    while (newline !== -1) {
      const line = this.buffers[side].slice(0, newline).replace(/\r$/, '')
      this.buffers[side] = this.buffers[side].slice(newline + 1)
      if (line.trim()) {
        if (side === 'host') this.onHostLine(line)
        else this.onRemoteLine(line)
      }
      newline = this.buffers[side].indexOf('\n')
    }
  }

  private onHostLine(line: string): void {
    const message = parse(line)
    // 握手由中继代为完成：宿主的 initialize 只留下 request_id 用于配对应答
    if (message?.type === 'control_request' && message.request?.subtype === 'initialize') {
      this.hostInitializeId = message.request_id
      return
    }
    if (!this.ready) {
      this.queued.host.push(line)
      return
    }
    if (message?.type === 'update_environment_variables') {
      if (!this.applyEnvironment(message.variables)) return
      this.send({ type: 'update_environment_variables', variables: {
        ...remoteModelEnvironment(process.env, true),
        ...sshReasoningEnvironment(),
      } })
      return
    }
    this.forward(line)
  }

  private onRemoteLine(line: string): void {
    if (this.ready) {
      this.emit(line)
      return
    }
    const message = parse(line)
    const handshake = message?.type === 'control_response' &&
      (message.response?.request_id ?? message.request_id) === this.initializeRequestId
    // 握手应答之前到达的远端输出（keep_alive、旧版的状态帧）按序暂存
    if (!handshake) {
      this.queued.remote.push(line)
      return
    }
    if (this.initializeTimer) clearTimeout(this.initializeTimer)
    this.initializeTimer = undefined
    const response = message.response!
    response.request_id = this.hostInitializeId ?? response.request_id
    this.emit(JSON.stringify(message))
    if (response.subtype !== 'success') {
      this.stop(1)
      return
    }
    this.send({ type: 'update_environment_variables', variables: {
      ...this.session.tunnelCredentials,
      ...(this.session.tunnelCredentials.DOGE_SSH_PROXY_TOKEN ? sshReasoningEnvironment() : {}),
    } })
    this.ready = true
    for (const queued of this.queued.remote.splice(0)) this.emit(queued)
    for (const queued of this.queued.host.splice(0)) this.onHostLine(queued)
  }

  /** 空串即删除（与 headless 的 structuredIO 同义）；形状非法的更新直接终止，避免两端状态分叉。 */
  private applyEnvironment(variables: unknown): boolean {
    const entries = variables && typeof variables === 'object' && !Array.isArray(variables)
      ? Object.entries(variables)
      : undefined
    if (!entries || entries.some(([, value]) => typeof value !== 'string')) {
      this.io.stderr.write('SSH relay: Invalid environment update from the host\n')
      this.stop(1)
      return false
    }
    for (const [key, value] of entries as [string, string][]) {
      if (value === '') delete process.env[key]
      else process.env[key] = value
    }
    return true
  }

  /** 握手期失败：原因作为 initialize 的错误应答交给宿主，并回收远端进程。 */
  private abort(reason: string): void {
    if (this.ready || this.stopped) return
    this.io.stderr.write(`SSH relay: ${reason}\n`)
    this.emit(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: this.hostInitializeId ?? this.initializeRequestId, error: reason },
    }))
    this.stop(1)
  }

  private stop(code: number): void {
    this.stopped = true
    this.exitCode = code
    if (this.initializeTimer) clearTimeout(this.initializeTimer)
    this.initializeTimer = undefined
    const proc = this.session.proc
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.stdin.end() } catch { /* already closed */ }
      killProcessTree(proc)
    }
  }

  private send(message: Record<string, unknown>): void {
    this.forward(JSON.stringify(message))
  }

  private forward(line: string): void {
    const stdin = this.session.proc.stdin
    if (stdin.destroyed || !stdin.writable) return
    stdin.write(`${line}\n`)
  }

  private emit(line: string): void {
    this.io.stdout.write(`${line}\n`)
  }
}

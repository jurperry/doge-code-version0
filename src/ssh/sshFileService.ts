import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import {
  identityPath,
  remoteFileServiceScript,
  sshExecutable,
  sshHostArgs,
  sshRemoteCommand,
  validateSSHHost,
  type SSHHostOptions,
} from './sshCommand.js'

/**
 * `doge ssh <host> --files`：一条常驻 SSH 连接上的远端文件服务。
 *
 * 宿主（桌面壳）经 stdin/stdout 与本进程按 NDJSON 一问一答；本进程把请求
 * 翻译成 remoteFileServiceScript 认得的单行指令。远端循环串行处理，应答
 * 因此与请求同序——这里按先进先出配对，不依赖远端回显 id。
 *
 * 读取面（home/list/stat/read/gitRoot）收任意绝对路径；项目管理面（归档、删除
 * 会话/项目/记忆）只收结构化参数——单段项目目录名与会话号，路径由远端循环按
 * 固定布局拼出，改动因此钉在 <配置目录>/projects 与以会话号命名的附属数据之内。
 */
export type FileServiceRequest =
  | { id: number; op: 'home' }
  | { id: number; op: 'list'; path: string }
  | { id: number; op: 'stat'; path: string }
  | { id: number; op: 'read'; path: string; offset: number; limit: number }
  | { id: number; op: 'gitRoot'; path: string }
  | { id: number; op: 'projects' }
  | { id: number; op: 'archive'; dir: string; sessionId: string; restore: boolean }
  | { id: number; op: 'removeSession'; dir: string; sessionId: string }
  | { id: number; op: 'removeProject' | 'removeMemory'; dir: string }

export type FileServiceResponse =
  | { event: 'ready' }
  | { event: 'down'; code: number | null; stderr: string }
  | { id: number; ok: true; home: string; configDir: string }
  | { id: number; ok: true; entries: { name: string; dir: boolean; size: number; mtimeMs: number }[] }
  | { id: number; ok: true; size: number; mtimeMs: number; dir: boolean }
  | { id: number; ok: true; size: number; data: string }
  | { id: number; ok: true; root: string | null }
  | { id: number; ok: true; projects: { dir: string; memory: boolean; archived: boolean }[] }
  | { id: number; ok: true }
  | { id: number; ok: false; error: string }

export type FileServiceIO = {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

/** 服务进程的运行时开关，测试注入伪 ssh。 */
export type FileServiceRuntime = { sshExecutable?: string; env?: NodeJS.ProcessEnv }

const REQUEST_TIMEOUT_MS = 30_000
const MAX_READ_BYTES = 8 * 1024 * 1024
const STDERR_TAIL_CHARS = 4000
const STDERR_DRAIN_MS = 500
const EXIT_GRACE_MS = 1500
/** 远端循环就绪时打出的问候行 */
const GREETING = '@ready'

/** 项目目录名是 CLI 的 v2 编码（字母数字与 ~ % . _ -）；单独的 . 与 .. 另行拒绝 */
const SAFE_PROJECT_DIR = /^(?!\.\.?$)[A-Za-z0-9~%._-]+$/
/** memory 与 archived 是项目目录里另有含义的子目录名，不能当会话号 */
const SAFE_SESSION_ID = /^(?!memory$|archived$)[A-Za-z0-9_-]+$/

export function parseFileServiceRequest(value: unknown): FileServiceRequest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { id, op, path, offset, limit, dir, sessionId, restore } = value as Record<string, unknown>
  if (!Number.isSafeInteger(id) || (id as number) < 0) return undefined
  if (op === 'home' || op === 'projects') return { id: id as number, op }
  if (op === 'archive' || op === 'removeSession' || op === 'removeProject' || op === 'removeMemory') {
    if (typeof dir !== 'string' || !SAFE_PROJECT_DIR.test(dir)) return undefined
    if (op === 'removeProject' || op === 'removeMemory') return { id: id as number, op, dir }
    if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) return undefined
    if (op === 'removeSession') return { id: id as number, op, dir, sessionId }
    return typeof restore === 'boolean' ? { id: id as number, op, dir, sessionId, restore } : undefined
  }
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return undefined
  if (op === 'list' || op === 'stat' || op === 'gitRoot') return { id: id as number, op, path }
  if (op !== 'read' || !Number.isSafeInteger(offset) || (offset as number) < 0) return undefined
  const bounded = Math.min(Math.max(Math.trunc((limit as number) || 0), 1), MAX_READ_BYTES)
  return { id: id as number, op, path, offset: offset as number, limit: bounded }
}

/** 远端一行指令：路径与目录名恒 base64，shell 元字符不进入命令行。 */
export function fileServiceCommand(request: FileServiceRequest): string {
  const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
  switch (request.op) {
    case 'home': return 'H'
    case 'list': return `L ${encode(request.path)}`
    case 'stat': return `S ${encode(request.path)}`
    case 'read': return `R ${encode(request.path)} ${request.offset} ${request.limit}`
    case 'gitRoot': return `G ${encode(request.path)}`
    case 'projects': return 'P'
    case 'archive': return `A ${encode(request.dir)} ${request.sessionId} ${request.restore ? 1 : 0}`
    case 'removeSession': return `X ${encode(request.dir)} ${request.sessionId}`
    case 'removeProject': return `D ${encode(request.dir)}`
    case 'removeMemory': return `M ${encode(request.dir)}`
  }
}

export type FileFrame = { ok: true; extra?: string; lines: string[] } | { ok: false }

/** 远端帧流 → 完整帧：`@ok[ extra]` / `@err` 起头，`@end` 收尾；帧可跨 chunk。 */
export class FileFrameParser {
  private buffer = ''
  private lines: string[] | undefined
  private ok = false
  private extra: string | undefined

  push(chunk: string): FileFrame[] {
    this.buffer += chunk
    const frames: FileFrame[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      const frame = this.line(line)
      if (frame) frames.push(frame)
      newline = this.buffer.indexOf('\n')
    }
    return frames
  }

  private line(line: string): FileFrame | undefined {
    if (this.lines === undefined) {
      if (line === '@err') {
        this.lines = []
        this.ok = false
      } else if (line.startsWith('@ok')) {
        this.lines = []
        this.ok = true
        this.extra = line.slice(3).trim() || undefined
      }
      return undefined
    }
    if (line !== '@end') {
      this.lines.push(line)
      return undefined
    }
    const frame: FileFrame = this.ok ? { ok: true, extra: this.extra, lines: this.lines } : { ok: false }
    this.lines = undefined
    this.extra = undefined
    return frame
  }
}

export function parseFileFrame(request: FileServiceRequest, frame: FileFrame): FileServiceResponse {
  const { id } = request
  if (!frame.ok) return { id, ok: false, error: '远端无法完成该文件操作' }
  switch (request.op) {
    case 'home': {
      const [home, configDir] = frame.lines
      return home && configDir ? { id, ok: true, home, configDir } : { id, ok: false, error: '远端未返回主目录' }
    }
    case 'list': {
      const entries: { name: string; dir: boolean; size: number; mtimeMs: number }[] = []
      for (const line of frame.lines) {
        const [kind, size, mtime, name] = line.split('\t')
        if ((kind !== 'd' && kind !== 'f') || !name) continue
        entries.push({ name, dir: kind === 'd', size: Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000 })
      }
      return { id, ok: true, entries }
    }
    case 'stat': {
      const [kind, size, mtime] = frame.lines[0]?.split(' ') ?? []
      if (kind === 'dir') return { id, ok: true, size: 0, mtimeMs: 0, dir: true }
      if (kind !== 'file') return { id, ok: false, error: '远端路径不存在或不是文件' }
      return { id, ok: true, size: Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000, dir: false }
    }
    case 'read':
      return { id, ok: true, size: Number(frame.extra) || 0, data: frame.lines[0] ?? '' }
    case 'gitRoot':
      return { id, ok: true, root: frame.lines[0] || null }
    case 'projects': {
      const projects: { dir: string; memory: boolean; archived: boolean }[] = []
      for (const line of frame.lines) {
        const [dir, memory, archived] = line.split('\t')
        if (SAFE_PROJECT_DIR.test(dir ?? '')) projects.push({ dir, memory: memory === '1', archived: archived === '1' })
      }
      return { id, ok: true, projects }
    }
    case 'archive':
    case 'removeSession':
    case 'removeProject':
    case 'removeMemory':
      return { id, ok: true }
  }
}

/** 请求与应答的先进先出配对；单个请求超时即判定通道失序并整体中止。 */
class RequestQueue {
  private waiting: { request: FileServiceRequest; timer: NodeJS.Timeout }[] = []

  constructor(
    private readonly respond: (response: FileServiceResponse) => void,
    private readonly stall: () => void,
  ) {}

  send(request: FileServiceRequest, write: (command: string) => void): void {
    const timer = setTimeout(this.stall, REQUEST_TIMEOUT_MS)
    this.waiting.push({ request, timer })
    write(`${fileServiceCommand(request)}\n`)
  }

  settle(frame: FileFrame): void {
    const next = this.waiting.shift()
    if (!next) return
    clearTimeout(next.timer)
    this.respond(parseFileFrame(next.request, frame))
  }

  failAll(error: string): void {
    for (const entry of this.waiting.splice(0)) {
      clearTimeout(entry.timer)
      this.respond({ id: entry.request.id, ok: false, error })
    }
  }
}

/** 在既有的远端循环进程上提供 NDJSON 问答，直到 stdin 关闭或远端退出；返回退出码。 */
export async function serveFileChannel(proc: ChildProcessWithoutNullStreams, io: FileServiceIO): Promise<number> {
  const emit = (response: FileServiceResponse): void => { io.stdout.write(`${JSON.stringify(response)}\n`) }
  let stderrTail = ''
  let onStderr: (() => void) | undefined
  const stderrSeen = new Promise<void>(resolve => { onStderr = resolve })
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS)
    onStderr?.()
  })
  // 宿主先于本进程退出时管道已断，写入错误无需处理
  proc.stdin.on('error', () => {})
  io.stdout.on('error', () => {})
  io.stderr.on('error', () => {})

  let exited = false
  const queue = new RequestQueue(emit, () => {
    queue.failAll('SSH 文件通道响应超时')
    proc.kill()
  })
  const exitedPromise = new Promise<number | null>(resolve => {
    proc.once('error', () => {
      exited = true
      io.stderr.write('无法启动 SSH 文件通道\n')
      resolve(1)
    })
    proc.once('exit', async code => {
      exited = true
      queue.failAll('SSH 文件通道已断开')
      // OpenSSH 的连接错误可能略晚于退出到达，留一小段时间收齐诊断
      if (!stderrTail) {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([stderrSeen, new Promise<void>(done => { timer = setTimeout(done, STDERR_DRAIN_MS) })])
        clearTimeout(timer)
      }
      if (stderrTail) io.stderr.write(stderrTail)
      emit({ event: 'down', code, stderr: stderrTail })
      resolve(code ?? 0)
    })
  })
  const parser = new FileFrameParser()
  let greeted = false
  let greetedResolve: () => void = () => {}
  const greetedPromise = new Promise<void>(resolve => { greetedResolve = resolve })
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    // 远端循环的问候先于任何帧到达；在它之前 ready 只代表本进程已启动
    if (!greeted && chunk.includes(GREETING)) {
      greeted = true
      greetedResolve()
    }
    for (const frame of parser.push(chunk)) queue.settle(frame)
  })
  if (exited) return exitedPromise
  // SSH 连不上时进程带着诊断退出：ready 只在远端问候后发出
  await Promise.race([greetedPromise, exitedPromise])
  if (exited) return exitedPromise
  emit({ event: 'ready' })

  const input = createInterface({ input: io.stdin as NodeJS.ReadableStream, crlfDelay: Infinity })
  for await (const line of input) {
    if (exited) break
    if (!line.trim()) continue
    let request: FileServiceRequest | undefined
    let id: unknown
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      id = parsed.id
      request = parseFileServiceRequest(parsed)
    } catch { /* 非 JSON 行按无效请求处理 */ }
    if (!request) {
      if (Number.isSafeInteger(id)) emit({ id: id as number, ok: false, error: '无效的文件通道请求' })
      continue
    }
    queue.send(request, command => { proc.stdin.write(command) })
  }
  if (!exited) {
    // 宿主关闭管道 → 远端循环读到 EOF 自行退出；迟迟不退（远端仍有进程占用通道）再强杀
    proc.stdin.end()
    const killer = setTimeout(() => { if (!exited) proc.kill() }, EXIT_GRACE_MS)
    exitedPromise.then(() => clearTimeout(killer))
  }
  return exitedPromise
}

export async function runSSHFileService(options: SSHHostOptions, io: FileServiceIO, runtime: FileServiceRuntime = {}): Promise<number> {
  let host: string
  try {
    host = validateSSHHost(options.host)
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const normalized = { ...options, host, identityFile: identityPath(options.identityFile) }
  const proc = spawn((runtime.sshExecutable ?? sshExecutable()), [
    ...sshHostArgs(normalized), '-T', host, ...sshRemoteCommand(remoteFileServiceScript()),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: runtime.env ?? process.env,
  }) as ChildProcessWithoutNullStreams
  return serveFileChannel(proc, io)
}

export type { SSHHostOptions }

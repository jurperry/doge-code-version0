import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { isClaudeAISubscriber } from '../utils/auth.js'
import { isInBundledMode } from '../utils/bundledMode.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { getModelConnection, getModelEnvironment } from '../utils/model/runtimeModelContext.js'
import { killProcessTree } from '../utils/processTree.js'
import type { RemotePermissionResponse } from '../remote/RemoteSessionManager.js'
import { SSHSessionManager, type SSHSessionCallbacks } from './SSHSessionManager.js'
import { startSSHAuthProxy, type SSHAuthProxy } from './sshAuthProxy.js'
import {
  identityPath,
  parseSSHProbeOutput,
  remoteModelEnvironment,
  remoteProbeScript,
  remoteSessionScript,
  sshExecutable,
  sshHostArgs,
  sshRemoteCommand,
  tunnelCredentialEnvironment,
  validateSSHHost,
  type SSHHostOptions,
  type SSHProbeResult,
} from './sshCommand.js'

export type SSHSessionOptions = SSHHostOptions & {
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  extraCliArgs?: string[]
}

export type SSHSession = {
  proc: ChildProcessWithoutNullStreams
  remoteCwd: string
  proxy: { stop: () => void }
  /** 远端握手成功后下发的隧道凭据（无令牌的本地测试会话为空对象） */
  tunnelCredentials: Record<string, string>
  createManager: (callbacks: SSHSessionCallbacks) => SSHSessionManager
  getStderrTail: () => string
}

export class SSHSessionError extends Error {
  constructor(message: string, readonly probe?: SSHProbeResult) {
    super(message)
    this.name = 'SSHSessionError'
  }
}

export async function probeSSHHost(options: SSHHostOptions): Promise<SSHProbeResult> {
  const host = validateSSHHost(options.host)
  const normalized = { ...options, host, identityFile: identityPath(options.identityFile) }
  const result = await execFileNoThrow(
    sshExecutable(),
    [...sshHostArgs(normalized), host, ...sshRemoteCommand(remoteProbeScript(normalized))],
    { timeout: 20_000, useCwd: false, stdin: 'ignore' },
  )
  return parseSSHProbeOutput(host, result.stdout, [result.stderr, result.error].filter(Boolean).join('\n'), result.code)
}

function remoteArgs(options: SSHSessionOptions): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--include-partial-messages',
    '--replay-user-messages',
  ]
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode)
  if (options.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions')
  const extra = options.extraCliArgs ?? []
  args.push(...extra)
  if (!extra.includes('--model') && !extra.some(arg => arg.startsWith('--model='))) args.push('--model', getMainLoopModel())
  return args
}

export function createSSHRemoteEnvironment(socketPath: string): Record<string, string> {
  const connection = getModelConnection()
  const env: Record<string, string> = {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER: connection.provider,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1',
    ANTHROPIC_UNIX_SOCKET: socketPath,
    DOGE_HEADLESS_BUILTIN_MCP: '0',
    // 与壳的本地 headless 会话同口径：逐轮文件回滚与自动记忆在远端可用
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
    DOGE_HEADLESS_AUTO_MEMORY: '1',
  }
  if (connection.authTokenType === 'ANTHROPIC_AUTH_TOKEN') env.ANTHROPIC_AUTH_TOKEN = 'ssh-tunnel-placeholder'
  else env.DOGE_API_KEY = 'ssh-tunnel-placeholder'
  if (isClaudeAISubscriber()) env.CLAUDE_CODE_OAUTH_TOKEN = 'ssh-tunnel-placeholder'
  return { ...env, ...remoteModelEnvironment(getModelEnvironment()) }
}

function attachStderrTail(proc: ChildProcessWithoutNullStreams): () => string {
  let tail = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    tail = `${tail}${chunk}`.slice(-8000)
  })
  return () => tail
}

export function sessionFromProcess(
  proc: ChildProcessWithoutNullStreams,
  remoteCwd: string,
  proxy: { stop: () => void },
  proxyToken?: string,
): SSHSession {
  const getStderrTail = attachStderrTail(proc)
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    killProcessTree(proc)
    proxy.stop()
    process.off('exit', cleanup)
  }
  proc.once('exit', cleanup)
  process.once('exit', cleanup)
  return {
    proc,
    remoteCwd,
    proxy,
    tunnelCredentials: proxyToken ? tunnelCredentialEnvironment(proxyToken) : {},
    getStderrTail,
    createManager: callbacks => new SSHSessionManager(proc, {
      ...callbacks,
      onDisconnected: () => {
        proxy.stop()
        callbacks.onDisconnected?.()
      },
    }, { proxyToken, cleanup }),
  }
}

export function buildSSHSessionArgs(options: {
  host: SSHHostOptions
  socketPath: string
  proxyPort: number
  command: string
}): string[] {
  return [
    ...sshHostArgs(options.host),
    '-T',
    '-o', 'StreamLocalBindUnlink=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', `${options.socketPath}:127.0.0.1:${options.proxyPort}`,
    options.host.host,
    ...sshRemoteCommand(options.command),
  ]
}

export async function createSSHSession(
  options: SSHSessionOptions,
  hooks: { onProgress?: (message: string) => void } = {},
): Promise<SSHSession> {
  hooks.onProgress?.('正在检查 SSH 连接与远程 Doge Code CLI…')
  const probe = await probeSSHHost(options)
  if (!probe.ok || !probe.remoteCwd || !probe.cliPath) {
    throw new SSHSessionError(`${probe.message}${probe.details ? `\n${probe.details}` : ''}`, probe)
  }
  hooks.onProgress?.(`已发现 ${probe.version}，正在建立安全隧道…`)

  let proxy: SSHAuthProxy | undefined
  try {
    proxy = await startSSHAuthProxy()
    const socketPath = `/tmp/doge-ssh-${randomUUID()}.sock`
    const normalized = { ...options, host: probe.host, identityFile: identityPath(options.identityFile) }
    const command = remoteSessionScript({
      cliPath: probe.cliPath,
      cwd: probe.remoteCwd,
      socketPath,
      env: createSSHRemoteEnvironment(socketPath),
      args: remoteArgs(options),
    })
    const proc = spawn(sshExecutable(), buildSSHSessionArgs({
      host: normalized,
      socketPath,
      proxyPort: proxy.port,
      command,
    }), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    }) as ChildProcessWithoutNullStreams
    proc.once('error', () => proxy?.stop())
    return sessionFromProcess(proc, probe.remoteCwd, proxy, proxy.token)
  } catch (error) {
    proxy?.stop()
    if (error instanceof SSHSessionError) throw error
    throw new SSHSessionError(`无法启动 SSH 会话：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function createLocalSSHSession(options: {
  cwd?: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  extraCliArgs?: string[]
}): SSHSession {
  const cwd = resolve(options.cwd ?? process.cwd())
  const executableArgs = isInBundledMode() ? [] : [process.argv[1]]
  const proc = spawn(process.execPath, [
    ...executableArgs,
    ...remoteArgs(options),
  ], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env,
  }) as ChildProcessWithoutNullStreams
  return sessionFromProcess(proc, cwd, { stop: () => {} })
}

export type { SSHSessionCallbacks, SSHProbeResult, RemotePermissionResponse, SDKMessage }

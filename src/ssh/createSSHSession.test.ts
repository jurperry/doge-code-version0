import { expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { resolve } from 'path'
import { buildSSHSessionArgs, createLocalSSHSession, createSSHRemoteEnvironment, sessionFromProcess } from './createSSHSession.js'
import { startSSHAuthProxy } from './sshAuthProxy.js'
import { remoteSessionScript, sshRemoteCommand } from './sshCommand.js'

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(25)
  }
}

test('--local test session spawns the CLI in the requested cwd without tunnel credentials', async () => {
  const session = createLocalSSHSession({ cwd: process.cwd() })
  try {
    expect(session.remoteCwd).toBe(resolve(process.cwd()))
    expect(session.tunnelCredentials).toEqual({})
    // 结束 stdin 即结束子进程：本地测试会话不能留下孤儿
    const exited = new Promise<unknown>(done => session.proc.once('exit', code => done(code)))
    session.proc.stdin.end()
    expect(await Promise.race([exited, Bun.sleep(8000).then(() => 'timeout')])).not.toBe('timeout')
  } finally {
    session.proxy.stop()
  }
})

test('remote startup environment forwards model routing but never host paths or credentials', () => {
  const previous = { ...process.env }
  try {
    Object.assign(process.env, {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      ANTHROPIC_MODEL: 'm2',
      CLAUDE_CODE_SUBAGENT_MODEL: 'small',
      DOGE_API_KEY: 'sk-real-secret',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.doge',
      CLAUDE_CODE_GIT_BASH_PATH: 'E:\\Git\\bin\\bash.exe',
      ANTHROPIC_CUSTOM_HEADERS: 'x-internal: 1',
    })
    delete process.env.ANTHROPIC_AUTH_TOKEN
    const env = createSSHRemoteEnvironment('/tmp/doge-ssh-unit.sock')
    expect(env.ANTHROPIC_MODEL).toBe('m2')
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('small')
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1')
    expect(env.ANTHROPIC_UNIX_SOCKET).toBe('/tmp/doge-ssh-unit.sock')
    expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1')
    expect(env.DOGE_HEADLESS_BUILTIN_MCP).toBe('0')
    // 远端只拿占位符：真实密钥留在本机代理
    expect(env.DOGE_API_KEY).toBe('ssh-tunnel-placeholder')
    expect(JSON.stringify(env)).not.toContain('sk-real-secret')
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'ANTHROPIC_CUSTOM_HEADERS']) expect(env[key]).toBeUndefined()
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
  }
})

test('production spawn arguments enforce forwarding failure without embedding the real tunnel token', async () => {
  const proxy = await startSSHAuthProxy()
  try {
    const socketPath = '/tmp/doge-test.sock'
    const command = remoteSessionScript({
      cliPath: '/opt/doge',
      cwd: '/work',
      socketPath,
      env: createSSHRemoteEnvironment(socketPath),
      args: [],
    })
    const args = buildSSHSessionArgs({ host: { host: 'host' }, socketPath, proxyPort: proxy.port, command })
    expect(args).toContain('ExitOnForwardFailure=yes')
    expect(args.join(' ')).toContain(`/tmp/doge-test.sock:127.0.0.1:${proxy.port}`)
    expect(args.slice(-3)).toEqual(sshRemoteCommand(command))
    expect(args.join(' ')).not.toContain(proxy.token)
    expect(command).not.toContain(proxy.token)
  } finally {
    proxy.stop()
  }
})

test('root exit reclaims surviving descendants and stops the proxy', async () => {
  const root = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process')
    for (let index = 0; index < 2; index++) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log(child.pid)
    }
    setTimeout(() => process.exit(0), 100)
  `], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
  const descendants: number[] = []
  let output = ''
  root.stdout.setEncoding('utf8')
  root.stdout.on('data', chunk => {
    output += chunk
    const lines = output.split(/\r?\n/)
    output = lines.pop() ?? ''
    for (const line of lines) if (/^\d+$/.test(line)) descendants.push(Number(line))
  })
  let proxyStopped = false
  const session = sessionFromProcess(root, process.cwd(), { stop: () => { proxyStopped = true } })
  try {
    await until(() => descendants.length === 2 && root.exitCode !== null, 'root and descendants started')
    await until(() => descendants.every(pid => {
      try { process.kill(pid, 0); return false } catch { return true }
    }), 'descendants reclaimed after root exit')
    expect(proxyStopped).toBe(true)
  } finally {
    session.proxy.stop()
    for (const pid of descendants) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }
})

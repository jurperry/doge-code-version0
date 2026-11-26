import { expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { buildSSHSessionArgs, createSSHRemoteEnvironment, sessionFromProcess } from './createSSHSession.js'
import { startSSHAuthProxy } from './sshAuthProxy.js'
import { remoteSessionScript, sshRemoteCommand } from './sshCommand.js'

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(25)
  }
}

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

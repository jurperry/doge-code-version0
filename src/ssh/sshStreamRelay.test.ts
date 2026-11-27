import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createServer } from 'http'
import { PassThrough } from 'stream'
import type { SSHSession } from './createSSHSession.js'
import { SSHStreamRelay } from './sshStreamRelay.js'
import { startSSHAuthProxy } from './sshAuthProxy.js'

/** 伪远端：initialize 即应答；其余每行 stdin 以 assistant 帧回显，user 另回 result。 */
const remoteScript = String.raw`
const echo = line => process.stdout.write(JSON.stringify({ type: 'assistant', text: line }) + '\n')
const reply = value => process.stdout.write(JSON.stringify(value) + '\n')
if (process.env.TEST_SSH_FAIL_INIT) {
  process.stderr.write('remote: permission prompt tool unavailable\n')
  process.stdin.once('data', chunk => {
    const message = JSON.parse(chunk.toString().split('\n')[0])
    reply({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'remote refused' } })
    setInterval(() => {}, 1000)
  })
} else if (process.env.TEST_SSH_EXIT_EARLY) {
  process.stderr.write('ssh: connect to host port 22: Connection refused\n')
  process.exit(255)
} else {
  let buffer = ''
  process.stdin.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.type === 'control_request' && message.request.subtype === 'initialize') {
        reply({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [] } } })
        echo(line)
      } else if (message.type === 'control_request' && message.request.subtype === 'end_session') {
        process.exit(0)
      } else {
        echo(line)
        if (message.type === 'user') reply({ type: 'result', subtype: 'success', result: 'done', session_id: 'remote-session' })
      }
    }
  })
}
`

type LineSink = { lines: string[]; stream: PassThrough }

function sink(): LineSink {
  const stream = new PassThrough()
  const result: LineSink = { lines: [], stream }
  let pending = ''
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString()
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    result.lines.push(...parts.filter(Boolean))
  })
  return result
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(10)
  }
}

let proc: ChildProcessWithoutNullStreams | undefined
let exitCode: Promise<number> | undefined
const envSnapshot = { ...process.env }

function launch(extraEnv: Record<string, string> = {}): { host: LineSink; out: LineSink; err: LineSink } {
  proc = spawn(process.execPath, ['-e', remoteScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  }) as ChildProcessWithoutNullStreams
  const host = sink()
  const out = sink()
  const err = sink()
  const session: SSHSession = {
    proc,
    remoteCwd: '/remote/work',
    proxy: { stop: () => {} },
    tunnelCredentials: { DOGE_SSH_PROXY_TOKEN: 'tunnel-token', ANTHROPIC_CUSTOM_HEADERS: 'x-doge-ssh-proxy: tunnel-token' },
    createManager: () => { throw new Error('not used by the relay') },
    getStderrTail: () => '',
  }
  exitCode = new SSHStreamRelay(session, { stdin: host.stream, stdout: out.stream, stderr: err.stream }).start()
  return { host, out, err }
}

const send = (host: LineSink, value: unknown): void => { host.stream.write(`${JSON.stringify(value)}\n`) }
const initialize = (host: LineSink): void => {
  send(host, { type: 'control_request', request_id: 'host-init', request: { subtype: 'initialize' } })
}
/** 远端实际收到的 stdin 行（按到达顺序）。 */
const received = (out: LineSink): Record<string, any>[] => out.lines
  .map(line => JSON.parse(line) as { type?: string; text?: string })
  .filter(message => message.type === 'assistant')
  .map(message => JSON.parse(message.text!) as Record<string, any>)

afterEach(() => {
  if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill()
  proc = undefined
  exitCode = undefined
  for (const key of Object.keys(process.env)) if (!(key in envSnapshot)) delete process.env[key]
  Object.assign(process.env, envSnapshot)
})

test('relay handshakes for the host, injects tunnel credentials and keeps host order', async () => {
  const { host, out } = launch()
  // 宿主在中继就绪前就写完了 initialize 与后续消息（与 ChatService 的行为一致）
  initialize(host)
  send(host, { type: 'control_response', response: { subtype: 'success', request_id: 'perm-1', response: { behavior: 'allow' } } })
  send(host, { type: 'user', message: { role: 'user', content: 'hello' }, session_id: '' })
  await until(() => out.lines.some(line => line.includes('"result":"done"')), 'turn completes through the relay')

  expect(out.lines[0]).toBe(JSON.stringify({
    type: 'control_response', response: { subtype: 'success', request_id: 'host-init', response: { commands: [] } },
  }))
  const lines = received(out)
  expect(lines[0]?.type).toBe('control_request')
  expect(lines[1]).toMatchObject({ type: 'update_environment_variables', variables: {
    DOGE_SSH_PROXY_TOKEN: 'tunnel-token', ANTHROPIC_CUSTOM_HEADERS: 'x-doge-ssh-proxy: tunnel-token',
  } })
  // 宿主自己的 initialize 不再转发，其余消息保持原序
  expect(lines.slice(2).map(message => message.type)).toEqual(['control_response', 'user'])

  send(host, { type: 'control_request', request_id: 'end', request: { subtype: 'end_session' } })
  expect(await exitCode).toBe(0)
})

test('host environment updates apply locally and reach the remote as a credential-free snapshot', async () => {
  const { host, out } = launch()
  initialize(host)
  send(host, { type: 'update_environment_variables', variables: {
    ANTHROPIC_MODEL: 'deepseek-flash',
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'anthropic',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'sk-real-secret',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.doge',
    CLAUDE_CODE_EFFORT_LEVEL: '',
  } })
  await until(() => received(out).some(message => message.type === 'update_environment_variables'), 'snapshot forwarded')

  // 本机代理按进程 env 选上游：真实端点与密钥必须已在本进程生效
  expect(process.env.ANTHROPIC_MODEL).toBe('deepseek-flash')
  expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-real-secret')
  expect(process.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()

  const snapshot = received(out).find(message => message.type === 'update_environment_variables' &&
    (message.variables as Record<string, unknown>).ANTHROPIC_MODEL === 'deepseek-flash')!
  const variables = snapshot.variables as Record<string, string>
  expect(variables.ANTHROPIC_MODEL).toBe('deepseek-flash')
  expect(variables.CLAUDE_CODE_COMPATIBLE_API_PROVIDER).toBe('anthropic')
  // 本机未设置的档位以空串下发，远端据此删除启动时继承的旧值
  expect(variables.CLAUDE_CODE_EFFORT_LEVEL).toBe('')
  const wire = JSON.stringify(snapshot)
  expect(wire).not.toContain('sk-real-secret')
  expect(wire).not.toContain('api.deepseek.com')
  expect(wire).not.toContain('Users')
})

test('remote stderr is forwarded and a refused handshake exits non-zero with the host request id', async () => {
  const { host, out, err } = launch({ TEST_SSH_FAIL_INIT: '1' })
  initialize(host)
  expect(await exitCode).toBe(1)
  expect(out.lines).toContain(JSON.stringify({
    type: 'control_response', response: { subtype: 'error', request_id: 'host-init', error: 'remote refused' },
  }))
  expect(err.lines.join('\n')).toContain('remote: permission prompt tool unavailable')
})

test('switching model and provider updates the same tunnel to the selected upstream route', async () => {
  const requests: unknown[] = []
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({
      path: req.url, key: req.headers['x-api-key'], authorization: req.headers.authorization,
      model: JSON.parse(Buffer.concat(chunks).toString()).model,
    })
    res.end('ok')
  })
  await new Promise<void>(resolve => { upstream.listen(0, '127.0.0.1', resolve) })
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No upstream port')
  const base = `http://127.0.0.1:${address.port}`
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  const proxy = await startSSHAuthProxy()
  try {
    const { host, out } = launch()
    initialize(host)
    const switchAndRequest = async (model: string, provider: string, root: string, key: string, path: string): Promise<void> => {
      send(host, { type: 'update_environment_variables', variables: {
        ANTHROPIC_MODEL: model, CLAUDE_CODE_COMPATIBLE_API_PROVIDER: provider,
        ANTHROPIC_BASE_URL: base + root, DOGE_API_KEY: key, ANTHROPIC_AUTH_TOKEN: '',
      } })
      send(host, { type: 'control_request', request_id: model, request: { subtype: 'set_model', model } })
      await until(() => received(out).some(message => message.request_id === model), model)
      expect(out.lines.join('')).not.toContain(key)
      expect(out.lines.join('')).not.toContain(base)
      const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
        method: 'POST',
        headers: { 'x-doge-ssh-proxy': proxy.token, 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      expect(await response.text()).toBe('ok')
    }
    await switchAndRequest('main-upstream', 'anthropic', '/anthropic', 'fixture-key-a', '/v1/messages')
    await switchAndRequest('secondary-upstream', 'openai', '/openai/v1', 'fixture-key-b', '/chat/completions')
    expect(requests).toEqual([
      { path: '/anthropic/v1/messages', key: 'fixture-key-a', authorization: undefined, model: 'main-upstream' },
      { path: '/openai/v1/chat/completions', key: undefined, authorization: 'Bearer fixture-key-b', model: 'secondary-upstream' },
    ])
    send(host, { type: 'control_request', request_id: 'end', request: { subtype: 'end_session' } })
    expect(await exitCode).toBe(0)
  } finally {
    proxy.stop()
    upstream.close()
  }
})

test('a remote that dies before the handshake yields an initialize error instead of a hang', async () => {
  const { host, out, err } = launch({ TEST_SSH_EXIT_EARLY: '1' })
  initialize(host)
  expect(await exitCode).toBe(1)
  const response = JSON.parse(out.lines[0]!) as { response: { request_id: string; subtype: string; error: string } }
  expect(response.response.request_id).toBe('host-init')
  expect(response.response.subtype).toBe('error')
  expect(response.response.error).toContain('exited before initialization')
  expect(err.lines.join('\n')).toContain('Connection refused')
})

test('a malformed environment update aborts the session before any message reaches the remote', async () => {
  const { host, out } = launch()
  initialize(host)
  await until(() => out.lines.length > 0, 'initialize')
  send(host, { type: 'update_environment_variables', variables: { ANTHROPIC_MODEL: 42 } })
  send(host, { type: 'user', message: { role: 'user', content: 'late' }, session_id: '' })
  expect(await exitCode).toBe(1)
  expect(received(out).some(message => message.type === 'user')).toBe(false)
})

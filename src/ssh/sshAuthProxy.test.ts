import { afterEach, expect, test } from 'bun:test'
import { createServer, type Server } from 'http'
import { captureModelEnvironment, runWithModelEnvironment } from '../utils/model/runtimeModelContext.js'
import { modelCompatFetch } from '../utils/proxy.js'
import { startSSHAuthProxy, type SSHAuthProxy } from './sshAuthProxy.js'

let upstream: Server | undefined
let proxy: SSHAuthProxy | undefined

afterEach(() => {
  proxy?.stop()
  upstream?.close()
  upstream = undefined
  proxy = undefined
})

test('SSH auth proxy preserves API paths and replaces placeholder credentials', async () => {
  let seen: { url?: string; authorization?: string; apiKey?: string; body?: string } = {}
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      seen = {
        url: req.url,
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
        apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"ok":true}\n\n')
    })
  })
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No upstream port')

  const snapshot = captureModelEnvironment({
    ...process.env,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'anthropic',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/anthropic?tenant=local`,
    DOGE_API_KEY: 'unit-test-local-secret',
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  })
  await runWithModelEnvironment(snapshot, async () => {
    proxy = await startSSHAuthProxy()
    const forbidden = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: 'POST' })
    expect(forbidden.status).toBe(403)
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages?beta=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ssh-tunnel-placeholder', 'x-doge-ssh-proxy': proxy.token },
      body: JSON.stringify({ model: 'mock' }),
    })
    expect(await response.text()).toBe('data: {"ok":true}\n\n')
  })

  expect(seen.url).toBe('/anthropic/v1/messages?beta=1&tenant=local')
  expect(seen.apiKey).toBe('unit-test-local-secret')
  expect(seen.apiKey).not.toBe('ssh-tunnel-placeholder')
  expect(seen.authorization).toBeUndefined()
  expect(seen.body).toBe('{"model":"mock"}')
})

test('OpenAI and Responses compatible fetch uses the SSH Unix socket', async () => {
  const originalFetch = globalThis.fetch
  const originalSocket = process.env.ANTHROPIC_UNIX_SOCKET
  const originalToken = process.env.DOGE_SSH_PROXY_TOKEN
  let options: RequestInit & { unix?: string } = {}
  try {
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/doge-ssh-test.sock'
    process.env.DOGE_SSH_PROXY_TOKEN = 'unit-tunnel-token'
    globalThis.fetch = (_input, init) => {
      options = init ?? {}
      return Promise.resolve(new Response('ok'))
    }
    const response = await modelCompatFetch('http://127.0.0.1/chat/completions', { method: 'POST' })
    expect(await response.text()).toBe('ok')
    expect(options.unix).toBe('/tmp/doge-ssh-test.sock')
    expect(new Headers(options.headers).get('x-doge-ssh-proxy')).toBe('unit-tunnel-token')
  } finally {
    globalThis.fetch = originalFetch
    if (originalSocket === undefined) delete process.ANTHROPIC_UNIX_SOCKET
    else process.env.ANTHROPIC_UNIX_SOCKET = originalSocket
    if (originalToken === undefined) delete process.DOGE_SSH_PROXY_TOKEN
    else process.env.DOGE_SSH_PROXY_TOKEN = originalToken
  }
})

test('OpenAI-compatible SSH requests retain Bearer authentication', async () => {
  let authorization: string | undefined
  let apiKey: string | undefined
  let path: string | undefined
  upstream = createServer((req, res) => {
    authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
    apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined
    path = req.url
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No upstream port')
  const snapshot = captureModelEnvironment({
    ...process.env,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'openai',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/v1?api-version=2026-01-01&tenant=local&scope=a&scope=b&baseEmpty=`,
    DOGE_API_KEY: 'unit-openai-secret',
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  })
  await runWithModelEnvironment(snapshot, async () => {
    proxy = await startSSHAuthProxy()
    const response = await fetch(`http://127.0.0.1:${proxy.port}/chat/completions?beta=1&api-version=override&requestOnly=x&requestOnly=y&requestEmpty=`, {
      method: 'POST',
      headers: { authorization: 'Bearer ssh-tunnel-placeholder', 'x-doge-ssh-proxy': proxy.token },
      body: '{}',
    })
    expect(response.status).toBe(200)
  })
  expect(path).toBe('/v1/chat/completions?beta=1&api-version=override&requestOnly=x&requestOnly=y&requestEmpty=&tenant=local&scope=a&scope=b&baseEmpty=')
  expect(authorization).toBe('Bearer unit-openai-secret')
  expect(apiKey).toBeUndefined()
})

test('Responses-compatible SSH requests preserve base and request query parameters', async () => {
  let path: string | undefined
  let authorization: string | undefined
  upstream = createServer((req, res) => {
    path = req.url
    authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No upstream port')
  const snapshot = captureModelEnvironment({
    ...process.env,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'responses',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/v1?api-version=2026-02-01&tenant=base`,
    DOGE_API_KEY: 'unit-responses-secret',
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  })
  await runWithModelEnvironment(snapshot, async () => {
    proxy = await startSSHAuthProxy()
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses?beta=1&tenant=request`, {
      method: 'POST',
      headers: { authorization: 'Bearer ssh-tunnel-placeholder', 'x-doge-ssh-proxy': proxy.token },
      body: '{}',
    })
    expect(response.status).toBe(200)
  })
  expect(path).toBe('/v1/responses?beta=1&tenant=request&api-version=2026-02-01')
  expect(authorization).toBe('Bearer unit-responses-secret')
})

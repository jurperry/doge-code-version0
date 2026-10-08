/**
 * 双类重试预算黑盒（0.2.128）：mock /v1/messages 三场景——
 *  A) 429×5 后成功：恰好 5 次 api_retry（max_retries=5）+ 成功 result
 *  B) 恒 429：5 次重试后诚实报错（is_error=true，总请求=6）
 *  C) 连接拒绝：10 次 api_retry（max_retries=10）后报错
 * 用法：bun test/api-retry-blackbox.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BASE_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DOGE_NETWORK_RETRY_BASE_MS: '10',
  ANTHROPIC_MODEL: 'mock-model',
  DOGE_API_KEY: 'test-key',
  CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK: '1',
}

const SSE_OK = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"mock-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

function rateLimitBody() {
  return JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: 'rate limited (code 1308), quota resets at 2026-10-06T05:00:00Z',
    },
  })
}

async function runCli(baseUrl, prompt = 'hi') {
  const home = mkdtempSync(join(tmpdir(), 'doge-retry-'))
  const child = spawn(process.execPath, [
    'run', './src/bootstrap-entry.ts',
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'mock-model',
  ], {
    cwd: ROOT,
    timeout: 120_000,
    env: {
      ...process.env,
      ...BASE_ENV,
      ANTHROPIC_BASE_URL: baseUrl,
      CLAUDE_CONFIG_DIR: join(home, '.doge'),
      USER_TYPE: 'external',
    },
  })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.resume()
  const code = await new Promise(resolveExit => child.on('close', resolveExit))
  rmSync(home, { recursive: true, force: true })
  const events = []
  let result = null
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const msg = JSON.parse(line)
      if (msg.type === 'system' && msg.subtype === 'api_retry') events.push(msg)
      if (msg.type === 'result') result = msg
    } catch { /* partial line */ }
  }
  return { events, result, code, stdout }
}

function withMockServer(handler, fn) {
  return new Promise((done, fail) => {
    let requests = 0
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        // SDK 连接前的 HEAD / 探活不计入重试序列
        if (req.method !== 'POST') {
          res.writeHead(200)
          res.end()
          return
        }
        requests++
        handler(req, res, requests)
      })
    })
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`
      Promise.resolve(fn(url, () => requests))
        .then(() => { server.close(() => done()) }, fail)
        .catch(fail)
    })
  })
}

async function main() {
  // A) 429×5 → 成功
  await withMockServer((_req, res, nth) => {
    if (nth <= 5) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(rateLimitBody())
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(SSE_OK)
    }
  }, async (url) => {
    const { events, result } = await runCli(url)
    assert.equal(events.length, 5, `expected exactly 5 api_retry events, got ${events.length}`)
    assert.deepEqual(events.map(e => [e.attempt, e.max_retries]),
      [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]], 'api-error class reports x/5')
    assert.ok(result, 'result frame present')
    assert.equal(result.is_error, false, 'turn succeeds after five rate-limit retries')
    console.log('PASS A: 429×5 → 5 retries (x/5) then success')
  })

  // B) 恒 429 → 5 次后诚实报错
  await withMockServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(rateLimitBody())
  }, async (url, requestCount) => {
    const { events, result } = await runCli(url)
    assert.equal(events.length, 5, `expected exactly 5 api_retry events, got ${events.length}`)
    assert.equal(requestCount(), 6, 'initial request + 5 retries, never a 7th')
    assert.ok(result, 'result frame present')
    assert.equal(result.is_error, true, 'exhausted retries surface an error result')
    console.log('PASS B: persistent 429 → honest error after 5 retries (6 requests)')
  })

  // C) 连接拒绝 → 网络类 10 轮
  const { events, result } = await runCli('http://127.0.0.1:9') // port 9 = discard, refused
  assert.equal(events.length, 10, `expected 10 api_retry events, got ${events.length}`)
  assert.ok(events.every(e => e.max_retries === 10), 'network class reports x/10')
  assert.equal(events.at(-1).attempt, 10)
  assert.equal(result.is_error, true, 'exhausted network retries surface an error result')
  console.log('PASS C: connection refused → 10 retries (x/10) then error')

  // D) 恒 500 → 服务类同为 10 轮（网络和服务类 10、其余 5——0.2.128 修正版）
  await withMockServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'internal error' } }))
  }, async (url, requestCount) => {
    const { events, result } = await runCli(url)
    assert.equal(events.length, 10, `expected 10 api_retry events, got ${events.length}`)
    assert.equal(requestCount(), 11, 'server class gets ten retries like the network class')
    assert.ok(events.every(e => e.max_retries === 10 && e.error_status === 500), 'server class reports x/10 with status')
    assert.equal(result.is_error, true, 'exhausted server retries surface an error result')
    console.log('PASS D: persistent 500 → 10 retries (x/10) then error')
  })

  console.log('ALL PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

/** Real localhost faults against the source headless CLI. Self-cleaning; no real credentials. */
import { mkdir, rm, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
const root = resolve(import.meta.dir, '..')
const sandbox = join(root, 'test', 'network-recovery-sandbox')
const encoder = new TextEncoder()
let failures = 0
function check(name: string, ok: boolean, details = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${details ? ` ${details}` : ''}`)
  if (!ok) failures++
}
function anthro(text: string, terminal = true, tool?: any): string {
  const events = [
    { type: 'message_start', message: { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { ...tool, input: {} } : { type: 'text', text: '' } },
    ...(tool ? [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }] : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]),
    { type: 'content_block_stop', index: 0 },
    ...(terminal ? [
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ] : []),
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
function openai(text: string, terminal = true): string {
  const id = 'chat_' + randomUUID()
  return `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n` + (terminal ? `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n` : '')
}
function responses(text: string, terminal = true): string {
  const id = 'resp_' + randomUUID()
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    ...(terminal ? [{ type: 'response.completed', response: { id, output: [], usage: { input_tokens: 7, output_tokens: 3 } } }] : []),
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
type Mode = 'half' | 'two-turn' | 'usage-half' | 'silent' | 'headers' | 'headers-reset' | 'terminal-open' | 'exhaust' | 'auth' | 'auth-body' | 'sse-auth' | 'sse-transient' | 'tool' | 'tool-usage' | 'tool-usage-delayed' | 'heartbeat' | '404' | 'image'
async function run(provider: string, mode: Mode) {
  if (process.env.NETWORK_E2E_FILTER && !`${provider}/${mode}`.includes(process.env.NETWORK_E2E_FILTER)) return
  const dir = join(sandbox, `${provider}-${mode}`)
  await mkdir(dir, { recursive: true })
  const bodies: any[] = []
  let calls = 0
  const format = provider === 'openai' ? openai : provider === 'responses' ? responses : anthro
  const resetServer = mode === 'headers-reset' ? createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.includes('/v1/')) { response.writeHead(404); response.end(); return }
    calls++
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    setTimeout(() => request.socket.destroy(), 30)
  }) : undefined
  if (resetServer) await new Promise<void>(resolve => resetServer.listen(0, '127.0.0.1', resolve))
  const server = resetServer ? {
    port: (resetServer.address() as any).port,
    stop() { resetServer.closeAllConnections(); resetServer.close() },
  } : Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (!request.url.includes('/v1/')) return new Response('missing', { status: 404 })
    const body = await request.json()
    bodies.push(body)
    calls++
    if (mode === 'sse-auth' || (mode === 'sse-transient' && calls === 1)) {
      const error = { type: mode === 'sse-auth' ? 'authentication_error' : 'server_error', message: 'provider SSE error' }
      const payload = provider === 'responses' ? { type: 'response.failed', response: { id: 'failed', error } } : provider === 'openai' ? { error } : { type: 'error', error }
      return new Response(`${provider === 'openai' ? '' : `event: ${provider === 'responses' ? 'response.failed' : 'error'}\n`}data: ${JSON.stringify(payload)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (mode === '404' && body.stream) return Response.json({ error: { type: 'not_found_error', message: 'streaming endpoint unavailable' } }, { status: 404 })
    if (mode === '404') return Response.json({ id: 'msg_fallback', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 7, output_tokens: 3 } })
    if (mode === 'image' && calls === 1) return Response.json({ error: { type: 'invalid_request_error', message: 'image input is not supported' } }, { status: 400 })
    if (mode === 'auth') return Response.json({ error: { type: 'authentication_error', message: 'bad key' } }, { status: 401 })
    if (mode === 'auth-body') return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('{"error":')) } }), { status: 401 })
    if (mode === 'headers' && calls === 1) { await Bun.sleep(800); return new Response(format('late')) }
    if (mode === 'silent' && calls === 1) return new Response(new ReadableStream())
    if (mode === 'exhaust') return new Response(format('orphan', false), { headers: { 'content-type': 'text/event-stream' } })
    if ((mode === 'half' || mode === 'two-turn' || mode === 'usage-half') && calls === 1) return new Response(format('orphan', false) + (mode === 'usage-half' ? 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":27}}\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
    if ((mode === 'tool' || mode === 'tool-usage' || mode === 'tool-usage-delayed') && calls === 1) {
      const filePath = join(dir, 'written.txt').replaceAll('\\', '/')
      const powershell = body.tools?.some((tool: any) => tool.name === 'PowerShell')
      const command = powershell ? `Add-Content -LiteralPath '${filePath}' -Value 'executed-once'` : `printf 'executed-once\\n' >> '${filePath}'`
      const completedTool = anthro('', false, { type: 'tool_use', id: 'tool_once', name: powershell ? 'PowerShell' : 'Bash', input: { command, description: 'Append the recovery sentinel once' } })
      const usage = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":27}}\n\n'
      if (mode === 'tool-usage-delayed') return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(encoder.encode(completedTool))
        for (let i = 0; i < 4; i++) { await Bun.sleep(80); controller.enqueue(encoder.encode(': heartbeat\n\n')) }
        controller.enqueue(encoder.encode(usage)); controller.close()
      } }), { headers: { 'content-type': 'text/event-stream' } })
      return new Response(completedTool + (mode === 'tool-usage' ? usage : ''), { headers: { 'content-type': 'text/event-stream' } })
    }
    if (mode === 'heartbeat') return new Response(new ReadableStream({ async start(controller) {
      for (let i = 0; i < 5; i++) {
        await Bun.sleep(80)
        controller.enqueue(encoder.encode(': heartbeat\n\n'))
      }
      controller.enqueue(encoder.encode(format('recovered')))
      controller.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (mode === 'terminal-open') return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(format('recovered'))) } }), { headers: { 'content-type': 'text/event-stream' } })
    return new Response(format('recovered'), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const env = { ...process.env,
    CLAUDE_CONFIG_DIR: join(dir, 'config'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, DOGE_API_KEY: 'local-test', ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER: provider, ANTHROPIC_MODEL: 'test', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_RETRIES: mode === 'exhaust' || mode === 'headers-reset' ? '999' : '2',
    API_TIMEOUT_MS: '200', CLAUDE_STREAM_IDLE_TIMEOUT_MS: '200', DOGE_NETWORK_RETRY_BASE_MS: '10', DOGE_PLAYWRIGHT_MCP: '0', DOGE_HEADLESS_BUILTIN_MCP: '0',
    NODE_ENV: 'production', TEST_ENABLE_SESSION_PERSISTENCE: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '0',
  }
  const program = process.env.DOGE_NETWORK_TEST_EXE ? [process.env.DOGE_NETWORK_TEST_EXE] : [process.execPath, 'run', join(root, 'src/bootstrap-entry.ts')]
  const child = Bun.spawn([...program, '--bare', '--model', 'test', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--dangerously-skip-permissions', ...(mode === 'two-turn' ? ['--input-format', 'stream-json', '-p'] : ['-p', 'Say recovered'])], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', ...(mode === 'two-turn' ? { stdin: 'pipe' as const } : {}) })
  const timeout = setTimeout(() => child.kill(), 25_000)
  async function readOutput(): Promise<string> {
    if (mode !== 'two-turn') return new Response(child.stdout).text()
    const send = (value: unknown) => (child.stdin as any).write(JSON.stringify(value) + '\n')
    send({ type: 'control_request', request_id: 'initialize-test', request: { subtype: 'initialize' } })
    send({ type: 'user', message: { role: 'user', content: 'Say recovered' } })
    let output = '', pending = '', results = 0
    const decoder = new TextDecoder()
    for await (const bytes of child.stdout) {
      const chunk = decoder.decode(bytes, { stream: true })
      output += chunk; pending += chunk
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
        try {
          if (JSON.parse(line).type === 'result') {
            results++
            if (results === 1) send({ type: 'user', message: { role: 'user', content: 'Check the recovered history' } })
            else (child.stdin as any).end()
          }
        } catch {}
      }
    }
    return output
  }
  const [stdout, stderr, exit] = await Promise.all([readOutput(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timeout)
  server.stop(true)
  const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  const retries = events.filter(e => e.type === 'system' && e.subtype === 'api_retry')
  const result = events.findLast(e => e.type === 'result')
  const label = `${provider}/${mode}`
  if (mode === 'auth' || mode === 'auth-body' || mode === 'sse-auth') check(label, calls === 1 && retries.length === 0 && result?.is_error, `${calls} requests`)
  else if (mode === 'exhaust' || mode === 'headers-reset') {
    check(label, calls === 11 && retries.length === 10 && result?.is_error, `${calls} requests/${retries.length} retries`)
    check(`${label}/attempts`, retries.map(r => r.attempt).join(',') === '1,2,3,4,5,6,7,8,9,10')
  } else {
    check(label, exit === 0 && result?.result === 'recovered', `calls=${calls}, retries=${retries.length}, exit=${exit}${result?.result !== 'recovered' ? ` stderr=${stderr.slice(-700)} out=${stdout.slice(-1200)}` : ''}`)
    check(`${label}/count`, calls === (mode === 'two-turn' ? 3 : mode === 'terminal-open' || mode === 'heartbeat' ? 1 : 2))
  }
  if (mode === 'half' || mode === 'usage-half') {
    check(`${label}/discard`, retries[0]?.discard_partial === true)
    let transcript = ''
    for await (const file of new Bun.Glob('**/*.jsonl').scan({ cwd: join(dir, 'config'), absolute: true })) transcript += await readFile(file, 'utf8')
    check(`${label}/transcript`, transcript.includes('recovered') && !transcript.includes('orphan'))
  }
  if (mode === 'tool' || mode === 'tool-usage' || mode === 'tool-usage-delayed') {
    check(`${label}/tool-preserved`, retries[0]?.discard_partial === false && bodies[1]?.messages?.some((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result' && c.tool_use_id === 'tool_once')))
    const written = await readFile(join(dir, 'written.txt'), 'utf8').catch(() => '')
    check(`${label}/write`, written.trim() === 'executed-once', JSON.stringify({ written, results: events.filter(e => e.type === 'user') }))
  }
  if (mode === 'usage-half' || mode === 'tool-usage' || mode === 'tool-usage-delayed') check(`${label}/usage`, result?.usage?.input_tokens === 14 && result?.usage?.output_tokens === 30, JSON.stringify(result?.usage))
  if (mode === 'tool-usage-delayed') {
    const entries: any[] = []
    for await (const file of new Bun.Glob('**/*.jsonl').scan({ cwd: join(dir, 'config'), absolute: true })) {
      for (const line of (await readFile(file, 'utf8')).trim().split('\n')) try { entries.push(JSON.parse(line)) } catch {}
    }
    const tool = entries.find(entry => entry.type === 'assistant' && entry.message.content.some((block: any) => block.type === 'tool_use'))
    const lastSnapshot = entries.findLast(entry => (entry.type === 'assistant' || entry.type === 'network-retry-usage') && entry.message?.id === tool?.message.id && entry.message?.usage?.output_tokens === 27)
    check(`${label}/durable-usage`, Boolean(lastSnapshot), JSON.stringify(entries.filter(entry => entry.type === 'network-retry-usage' || entry.type === 'assistant').map(entry => ({ type: entry.type, uuid: entry.uuid, id: entry.message?.id, usage: entry.message?.usage }))))
    if (lastSnapshot?.type === 'network-retry-usage') check(`${label}/usage-source`, lastSnapshot.sourceUuid === tool.uuid)
    const usageById = new Map<string, any>()
    for (const entry of entries) if ((entry.type === 'assistant' || entry.type === 'network-retry-usage') && entry.message?.id && (entry.message.usage?.input_tokens || entry.message.usage?.output_tokens)) usageById.set(entry.message.id, entry.message.usage)
    check(`${label}/durable-total`, [...usageById.values()].reduce((sum, usage) => sum + usage.input_tokens + usage.output_tokens, 0) === 44)
  }
  if (mode === 'two-turn') {
    const history = JSON.stringify(bodies[2]?.messages ?? bodies[2]?.input)
    check(`${label}/history`, history.includes('recovered') && !history.includes('orphan'), history.slice(-500))
  }
}
try {
  for (const provider of ['anthropic', 'openai', 'responses']) {
    for (const mode of ['half', 'silent', 'headers', 'terminal-open', 'auth', 'auth-body', 'sse-auth', 'sse-transient', 'heartbeat'] as Mode[]) await run(provider, mode)
    await run(provider, 'headers-reset')
    await run(provider, 'two-turn')
  }
  await run('anthropic', 'tool')
  await run('anthropic', 'exhaust')
  await run('anthropic', '404')
  await run('anthropic', 'image')
  await run('anthropic', 'usage-half')
  await run('anthropic', 'tool-usage')
  await run('anthropic', 'tool-usage-delayed')
} finally { await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
process.exitCode = failures ? 1 : 0

// Opt-in compiled-CLI verification. Reuses the current user's existing permanent
// authorization, initializes stream-json, and never persists the mock-model session.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

export async function runElevatedCliFixture(options: {
  cliExe: string
  app: string
  coordinate: [number, number]
  directory: string
  cwd: string
  timeoutMs?: number
  onDispatched: () => Promise<void>
}): Promise<void> {
  let scenarioError: unknown
  let stage = 0
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    if (request.url?.includes('count_tokens')) { response.end('{"input_tokens":20}'); return }
    if (!request.url?.includes('/messages')) { response.end('{}'); return }
    const body = JSON.parse(raw || '{}')
    if (!body.tools?.some((tool: { name?: string }) => tool.name === 'mcp__computer-use__request_access')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ id: 'auxiliary', type: 'message', role: 'assistant', model: 'cu-elevated-fixture', content: [{ type: 'text', text: 'No updates.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
      return
    }
    let block: { type: string; text?: string; id?: string; name?: string; input?: unknown }
    try {
      switch (++stage) {
        case 1:
          block = { type: 'tool_use', id: 'grant', name: 'mcp__computer-use__request_access', input: { apps: [options.app], reason: 'Operate the isolated elevated fixture' } }
          break
        case 2:
          assert.equal(toolResult(body, 'grant').error, undefined)
          block = { type: 'tool_use', id: 'shot', name: 'mcp__computer-use__screenshot', input: {} }
          break
        case 3:
          assert.equal(toolResult(body, 'shot').error, undefined)
          block = { type: 'tool_use', id: 'click', name: 'mcp__computer-use__left_click', input: { coordinate: options.coordinate } }
          break
        case 4: {
          const result = toolResult(body, 'click')
          assert.equal(result.error, undefined, result.text)
          await options.onDispatched()
          block = { type: 'text', text: 'CU_COMPILED_ELEVATED_DONE' }
          break
        }
        default:
          throw new Error('Unexpected compiled-fixture stage ' + stage)
      }
    } catch (error) {
      scenarioError = error
      block = { type: 'text', text: 'CU_COMPILED_ELEVATED_FAILED' }
    }
    response.setHeader('content-type', 'text/event-stream')
    const id = `message_${stage}`
    const usage = { input_tokens: 20, output_tokens: 5 }
    const send = (type: string, data: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'cu-elevated-fixture', content: [], stop_reason: null, usage } })
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { type: 'tool_use', id: block.id, name: block.name, input: {} } : { type: 'text', text: '' } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage })
    send('message_stop', { type: 'message_stop' })
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|DOGE_|CLAUDE_CODE_)/.test(key)) delete env[key]
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: join(homedir(), '.doge'), CLAUDE_CODE_TMPDIR: options.directory,
    TEMP: options.directory, TMP: options.directory, TMPDIR: options.directory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'anthropic',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_MODEL: 'cu-elevated-fixture', DOGE_API_KEY: 'fixture',
    DOGE_HEADLESS_BUILTIN_MCP: '1', DOGE_PLAYWRIGHT_MCP: '0',
  })
  const child = spawn(options.cliExe, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--mcp-config', '{"mcpServers":{}}',
    '--dangerously-skip-permissions', '--debug-file', join(options.directory, 'compiled-cli-debug.txt'),
  ], { cwd: options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames: unknown[] = []
  let buffer = ''
  let stderr = ''
  let result: { is_error?: boolean; result?: string } | undefined
  const timer = setTimeout(() => { child.kill() }, options.timeoutMs ?? 120_000)
  try {
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.on('data', chunk => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          const frame = JSON.parse(line)
          frames.push(frame)
          if (frame.type === 'control_response' && frame.response?.request_id === 'init') {
            child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use Computer Use to click the isolated elevated fixture.' } }) + '\n')
          }
          if (frame.type === 'result') { result = frame; child.stdin.end() }
        } catch { /* ignore non-protocol teardown output */ }
      }
    })
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } }) + '\n')
    const exited = await new Promise<number | null>(resolve => child.once('exit', resolve))
    assert.equal(exited, 0, stderr.slice(-2000))
    if (scenarioError) throw scenarioError
    assert.ok(result, JSON.stringify(frames).slice(-2000))
    assert.equal(result.is_error, false, result.result)
    assert.match(result.result ?? '', /CU_COMPILED_ELEVATED_DONE/)
    assert.equal(stage, 4)
  } catch (error) {
    let debug = ''
    try {
      debug = readFileSync(join(options.directory, 'compiled-cli-debug.txt'), 'utf8').split(/\r?\n/)
        .filter(line => /Computer Use|computer-use|ERROR|error|lock|API REQUEST|control|prompt|init/i.test(line)).slice(-100).join('\n')
    } catch {}
    console.error('Compiled CU fixture diagnostics:', JSON.stringify({ stage, frames, stderr, scenarioError: String(scenarioError ?? '') }))
    if (debug) console.error('Compiled CU fixture debug:\n' + debug)
    throw error
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function toolResult(body: any, id: string): { error?: boolean; text: string } {
  const result = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .find((block: any) => block.type === 'tool_result' && block.tool_use_id === id)
  assert.ok(result, `Missing tool result for ${id}`)
  const parts = Array.isArray(result.content) ? result.content : [{ type: 'text', text: result.content }]
  return { error: result.is_error, text: parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') }
}

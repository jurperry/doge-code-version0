import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
mkdirSync(join(root, 'test'), { recursive: true })
const temp = mkdtempSync(join(root, 'test', 'web-search-native-e2e-'))
const project = join(temp, 'project')
mkdirSync(project)

type Provider = 'anthropic' | 'responses'
let activeProvider: Provider = 'anthropic'
let nestedRequests = 0
let failures = 0

function check(condition: unknown, label: string, detail = ''): void {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures++
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function event(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

function nativeBlocks(
  blocks: Array<Record<string, unknown>>,
  stopReason: 'tool_use' | 'end_turn',
): Response {
  let body = event('message_start', {
    message: {
      id: 'msg_native_search',
      type: 'message',
      role: 'assistant',
      model: 'mock-search-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  })
  for (const [index, block] of blocks.entries()) {
    body += event('content_block_start', { index, content_block: block })
    if (block.type === 'text') {
      body += event('content_block_delta', {
        index,
        delta: { type: 'text_delta', text: block.text },
      })
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      body += event('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      })
    }
    body += event('content_block_stop', { index })
  }
  body += event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
  })
  body += event('message_stop')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function nativeToolCall(): Response {
  return nativeBlocks([{
    type: 'tool_use',
    id: 'call_websearch',
    name: 'WebSearch',
    input: { query: 'current example news' },
  }], 'tool_use')
}

function nativeSearch(): Response {
  return nativeBlocks([
    {
      type: 'server_tool_use',
      id: 'srvtoolu_native',
      name: 'web_search',
      input: { query: 'current example news' },
    },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_native',
      content: [{
        type: 'web_search_result',
        title: 'Native result',
        url: 'https://example.com/native',
        encrypted_content: '',
        page_age: null,
      }],
    },
    { type: 'text', text: 'Native search completed.' },
  ], 'end_turn')
}

function responsesEvents(items: Array<Record<string, unknown>>): Response {
  const id = 'resp_native_search'
  let body = event('response.created', { response: { id, status: 'in_progress' } })
  for (const [index, item] of items.entries()) {
    body += event('response.output_item.added', {
      output_index: index,
      item: item.type === 'function_call' ? { ...item, arguments: '' } : item,
    })
    if (item.type === 'function_call') {
      body += event('response.function_call_arguments.delta', {
        item_id: item.id,
        output_index: index,
        delta: item.arguments,
      })
    }
    if (item.type === 'message') {
      const content = item.content as Array<Record<string, unknown>>
      body += event('response.output_text.delta', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: content[0].text,
      })
    }
    body += event('response.output_item.done', { output_index: index, item })
  }
  body += event('response.completed', {
    response: {
      id,
      status: 'completed',
      output: items,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function responsesToolCall(): Response {
  return responsesEvents([{
    type: 'function_call',
    id: 'fc_websearch',
    call_id: 'call_websearch',
    name: 'WebSearch',
    arguments: JSON.stringify({ query: 'current example news' }),
  }])
}

function responsesSearch(): Response {
  return responsesEvents([
    {
      id: 'ws_native',
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        query: 'current example news',
        sources: [{ title: 'Native result', url: 'https://example.com/native' }],
      },
    },
    {
      id: 'msg_native',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Native search completed.', annotations: [] }],
    },
  ])
}

function responsesText(text: string): Response {
  return responsesEvents([{
    id: 'msg_final',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }])
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (request.method === 'HEAD') return new Response(null, { status: 200 })
    const path = new URL(request.url).pathname
    const body = await request.json() as any
    if (activeProvider === 'anthropic' && path.endsWith('/v1/messages')) {
      if ((body.tools ?? []).some((tool: any) => tool.type === 'web_search_20250305')) {
        nestedRequests++
        return nativeSearch()
      }
      const hasToolResult = (body.messages ?? []).some((message: any) =>
        Array.isArray(message.content) &&
        message.content.some((block: any) => block.type === 'tool_result'),
      )
      return hasToolResult
        ? nativeBlocks([{ type: 'text', text: 'ANTHROPIC_SEARCH_OK' }], 'end_turn')
        : nativeToolCall()
    }
    if (activeProvider === 'responses' && path.endsWith('/v1/responses')) {
      if ((body.tools ?? []).some((tool: any) => tool.type === 'web_search')) {
        nestedRequests++
        return responsesSearch()
      }
      const hasToolResult = (body.input ?? []).some(
        (item: any) => item.type === 'function_call_output',
      )
      return hasToolResult ? responsesText('RESPONSES_SEARCH_OK') : responsesToolCall()
    }
    return new Response('not found', { status: 404 })
  },
})

async function run(provider: Provider): Promise<{
  status: number | null
  stderr: string
  finalText: string
  toolResults: string[]
  isError?: boolean
}> {
  activeProvider = provider
  nestedRequests = 0
  const config = join(temp, `config-${provider}`)
  const tempDir = join(temp, `tmp-${provider}`)
  mkdirSync(config, { recursive: true })
  mkdirSync(tempDir, { recursive: true })
  const executable = process.env.DOGE_E2E_CLI
  const program = executable
    ? [executable]
    : [process.execPath, join(root, 'src', 'bootstrap-entry.ts')]
  const env = { ...process.env }
  for (const key of [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'DOGE_ACTIVE_MODEL_PROFILE',
  ]) delete env[key]

  return new Promise(resolveResult => {
    const child = spawn(program[0], [
      ...program.slice(1),
      '-p', 'Search the web',
      '--dangerously-skip-permissions',
      '--tools', 'WebSearch',
      '--no-session-persistence',
      '--verbose',
      '--output-format', 'stream-json',
    ], {
      cwd: project,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_TMPDIR: tempDir,
        TEMP: tempDir,
        TMP: tempDir,
        DOGE_API_KEY: 'sk-e2e-dummy',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        ANTHROPIC_MODEL: 'mock-search-model',
        ANTHROPIC_SMALL_FAST_MODEL: 'mock-search-model',
        CLAUDE_CODE_COMPATIBLE_API_PROVIDER: provider,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_MAX_RETRIES: '0',
        DOGE_HEADLESS_BUILTIN_MCP: '0',
        DOGE_PLAYWRIGHT_MCP: '0',
        NODE_ENV: 'production',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => child.kill(), 120_000)
    child.on('close', status => {
      clearTimeout(timer)
      let finalText = ''
      let isError: boolean | undefined
      const toolResults: string[] = []
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue
        try {
          const message = JSON.parse(line)
          if (message.type === 'result') {
            finalText = typeof message.result === 'string' ? message.result : ''
            isError = message.is_error
          }
          const content = message.message?.content
          if (!Array.isArray(content)) continue
          for (const block of content) {
            if (block.type === 'tool_result') {
              toolResults.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
            }
          }
        } catch {}
      }
      resolveResult({ status, stderr, finalText, toolResults, isError })
    })
  })
}

try {
  for (const provider of ['anthropic', 'responses'] as const) {
    const result = await run(provider)
    check(result.status === 0 && result.isError === false, `${provider}: native WebSearch completes`, result.stderr.slice(-300))
    check(
      result.toolResults.some(text => text.includes('https://example.com/native') && text.includes('Native result')),
      `${provider}: native result reaches the main model`,
      result.toolResults.join('\n').slice(0, 500),
    )
    check(result.finalText.includes(`${provider.toUpperCase()}_SEARCH_OK`), `${provider}: final response received`)
    check(nestedRequests === 1, `${provider}: one native nested search request`)
  }
} finally {
  server.stop(true)
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(temp, { recursive: true, force: true })
      break
    } catch {
      await Bun.sleep(200)
    }
  }
}

console.log(failures === 0 ? 'e2e-web-search-native: ALL PASS' : `e2e-web-search-native: ${failures} FAIL`)
process.exitCode = failures === 0 ? 0 : 1

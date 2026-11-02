import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
mkdirSync(join(root, 'test'), { recursive: true })
const temp = mkdtempSync(join(root, 'test', 'web-tools-e2e-'))
const project = join(temp, 'project')
mkdirSync(project)

let failures = 0
function check(condition: unknown, label: string, detail = ''): void {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures++
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

type Scenario = 'search' | 'unsupported-search' | 'fetch'
type ChatMessage = {
  role?: string
  content?: unknown
}
type ChatRequest = {
  messages?: ChatMessage[]
  tools?: Array<{ function?: { name?: string } }>
  web_search_options?: unknown
}

let activeScenario: Scenario = 'search'
let observedRequests: ChatRequest[] = []

function sse(chunks: unknown[]): Response {
  return new Response(
    chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function textResponse(text: string, searchResult?: unknown): Response {
  return sse([
    {
      id: 'chatcmpl-web-tools',
      ...(searchResult === undefined ? {} : { search_result: searchResult }),
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-web-tools',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ])
}

function toolResponse(name: 'WebSearch' | 'WebFetch', input: unknown): Response {
  return sse([
    {
      id: 'chatcmpl-web-tools',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: `call_${name.toLowerCase()}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(input) },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: 'chatcmpl-web-tools',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ])
}

function hasToolResult(body: ChatRequest): boolean {
  return (body.messages ?? []).some(message => message.role === 'tool')
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (!new URL(request.url).pathname.endsWith('/chat/completions')) {
      return new Response('not found', { status: 404 })
    }
    const body = await request.json() as ChatRequest
    observedRequests.push(body)

    if (activeScenario === 'fetch') {
      if (hasToolResult(body)) return textResponse('WEB_FETCH_E2E_OK')
      const exposesFetch = (body.tools ?? []).some(
        tool => tool.function?.name === 'WebFetch',
      )
      if (exposesFetch) {
        return toolResponse('WebFetch', {
          url: 'https://example.com',
          prompt: 'Extract the page title',
        })
      }
      return textResponse('WEB_FETCH_SUMMARY_OK')
    }

    if (body.web_search_options) {
      return activeScenario === 'search'
        ? textResponse('Structured result received.', [
            { title: 'GLM result', link: 'https://example.com/glm', content: 'snippet' },
          ])
        : textResponse('I cannot search the web; https://example.com/fake is not a verified result.')
    }
    if (hasToolResult(body)) return textResponse('WEB_SEARCH_E2E_OK')
    return toolResponse('WebSearch', { query: 'current example news' })
  },
})

type CliResult = {
  status: number | null
  stdout: string
  stderr: string
  toolResults: Array<{ content?: unknown; is_error?: boolean }>
  finalText: string
  isError?: boolean
}

async function runCli(scenario: Scenario): Promise<CliResult> {
  activeScenario = scenario
  observedRequests = []
  const config = join(temp, `config-${scenario}`)
  const tempDir = join(temp, `tmp-${scenario}`)
  mkdirSync(config, { recursive: true })
  mkdirSync(tempDir, { recursive: true })
  const executable = process.env.DOGE_E2E_CLI
  const program = executable
    ? [executable]
    : [process.execPath, join(root, 'src', 'bootstrap-entry.ts')]
  const tool = scenario === 'fetch' ? 'WebFetch' : 'WebSearch'
  const args = [
    '-p',
    scenario === 'fetch' ? 'Fetch the example page' : 'Search the web',
    '--dangerously-skip-permissions',
    '--tools', tool,
    '--no-session-persistence',
    '--verbose',
    '--output-format', 'stream-json',
  ]
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
    const child = spawn(program[0], [...program.slice(1), ...args], {
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
        CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'openai',
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
      const toolResults: CliResult['toolResults'] = []
      let finalText = ''
      let isError: boolean | undefined
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
            if (block.type === 'tool_result') toolResults.push(block)
          }
        } catch {}
      }
      resolveResult({ status, stdout, stderr, toolResults, finalText, isError })
    })
  })
}

function resultText(result: CliResult['toolResults'][number]): string {
  return typeof result.content === 'string'
    ? result.content
    : JSON.stringify(result.content ?? '')
}

try {
  const search = await runCli('search')
  check(search.status === 0 && search.isError === false, 'structured Chat search completes', search.stderr.slice(-300))
  check(search.finalText.includes('WEB_SEARCH_E2E_OK'), 'structured Chat search reaches the final model response')
  check(
    search.toolResults.some(result => {
      const text = resultText(result)
      return text.includes('https://example.com/glm') && text.includes('GLM result')
    }),
    'GLM search_result reaches the main model as a titled link',
    search.toolResults.map(resultText).join('\n').slice(0, 500),
  )
  check(
    observedRequests.filter(request => request.web_search_options).length === 1,
    'WebSearch issues one native nested search request',
  )

  const unsupported = await runCli('unsupported-search')
  check(unsupported.status === 0, 'unsupported Chat search is handled by the main model', unsupported.stderr.slice(-300))
  check(
    unsupported.toolResults.some(result =>
      result.is_error === true && resultText(result).includes('no verifiable web search activity'),
    ),
    'ordinary commentary and unverified URLs fail as unsupported search',
    unsupported.toolResults.map(resultText).join('\n').slice(0, 500),
  )

  const fetch = await runCli('fetch')
  check(fetch.status === 0 && fetch.isError === false, 'OpenAI WebFetch completes under provider-aware preflight policy', fetch.stderr.slice(-300))
  check(
    fetch.toolResults.some(result => resultText(result).includes('WEB_FETCH_SUMMARY_OK')),
    'fetched HTML reaches the secondary model and returns its summary',
    fetch.toolResults.map(resultText).join('\n').slice(0, 500),
  )
  check(
    observedRequests.some(request =>
      !(request.tools ?? []).some(tool => tool.function?.name === 'WebFetch') &&
      JSON.stringify(request.messages ?? []).includes('Example Domain'),
    ),
    'real example.com HTML was converted before secondary-model processing',
  )
  check(fetch.finalText.includes('WEB_FETCH_E2E_OK'), 'WebFetch result reaches the final model response')
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

console.log(failures === 0 ? 'e2e-web-tools: ALL PASS' : `e2e-web-tools: ${failures} FAIL`)
process.exitCode = failures === 0 ? 0 : 1

// e2e（可保留回归资产）：跨 provider 服务端工具块重放消毒全链路——
// ① run A：mock Anthropic 端点以 GLM 兼容形态回一条含 server_tool_use(webReader)
//    + 同消息内嵌 tool_result 的 assistant 流，CLI 流装配器真实落盘；
// ② run B：--resume 同一会话再发一条 prompt，端点切换为 Kimi 严格校验模式：
//    出站请求只要还带 server_tool_use / assistant 内嵌 tool_result 就按 Kimi
//    原话回 400 invalid_request_error（修复前该会话每轮必 400）；
// ③ 断言：run B 正常完成、请求已无服务端工具块、且降维文本保留调用信息、
//    磁盘转录未被改写（渲染/显示不受影响）。
// 自建 CLAUDE_CONFIG_DIR 沙箱 + 临时项目目录，结束时自清理。
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const TMP = mkdtempSync(join(tmpdir(), 'doge-srvtool-e2e-'))
const SANDBOX = join(TMP, 'config')
const PROJECT = join(TMP, 'project')
mkdirSync(SANDBOX, { recursive: true })
mkdirSync(PROJECT, { recursive: true })

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// run A 的 GLM 形态流：server_tool_use → text → 内嵌 tool_result → end_turn。
function glmSseBody(): string {
  const events = [
    [
      'message_start',
      JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_e2e_glm',
          type: 'message',
          role: 'assistant',
          model: 'mock',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
    ],
    [
      'content_block_start',
      JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'server_tool_use',
          id: 'call_e2e_webreader',
          name: 'webReader',
          input: {},
        },
      }),
    ],
    [
      'content_block_delta',
      JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"url":"https://example.com/e2e"}',
        },
      }),
    ],
    ['content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 0 })],
    [
      'content_block_start',
      JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
    ],
    [
      'content_block_delta',
      JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: '联网查到了资料。' },
      }),
    ],
    ['content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 1 })],
    [
      'content_block_start',
      JSON.stringify({
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_result',
          tool_use_id: 'call_e2e_webreader',
          content: '网页正文：示例内容 example body',
        },
      }),
    ],
    ['content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 2 })],
    // 真实 GLM 流在内嵌 tool_result 之后还有文本/思考块（83734af8 会话同款
    // 形态）；末块须为 text，否则 isResultSuccessful 判 error_during_execution。
    [
      'content_block_start',
      JSON.stringify({
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'text', text: '' },
      }),
    ],
    [
      'content_block_delta',
      JSON.stringify({
        type: 'content_block_delta',
        index: 3,
        delta: { type: 'text_delta', text: '以上就是检索结果。' },
      }),
    ],
    ['content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 3 })],
    [
      'message_delta',
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 12 },
      }),
    ],
    ['message_stop', JSON.stringify({ type: 'message_stop' })],
  ]
  return events.map(([e, d]) => `event: ${e}\ndata: ${d}\n\n`).join('')
}

// 正常单文本块流（run B 校验通过时返回）。
function okSseBody(): string {
  const events = [
    [
      'message_start',
      JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_e2e_kimi',
          type: 'message',
          role: 'assistant',
          model: 'mock',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
    ],
    [
      'content_block_start',
      JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    ],
    [
      'content_block_delta',
      JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      }),
    ],
    ['content_block_stop', JSON.stringify({ type: 'content_block_stop', index: 0 })],
    [
      'message_delta',
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      }),
    ],
    ['message_stop', JSON.stringify({ type: 'message_stop' })],
  ]
  return events.map(([e, d]) => `event: ${e}\ndata: ${d}\n\n`).join('')
}

interface ApiRequestBody {
  messages?: Array<{
    role: string
    content?: Array<{ type: string; [key: string]: unknown }> | string
  }>
}

let phase: 'glm' | 'kimi' = 'glm'
const kimiRequests: ApiRequestBody[] = []

// Kimi 兼容端点的内部校验（api.kimi.com 实测行为）：assistant 里的
// server_tool_use 会被转成 tool_calls，配不上 tool 消息即 400。
function kimiRejection(body: ApiRequestBody): string | null {
  for (const message of body.messages ?? []) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        return `an assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${
          (block.name as string) ?? 'serverTool'
        }:0`
      }
      if (block.type === 'tool_result') {
        return "unexpected tool_result block in assistant message content"
      }
    }
  }
  return null
}

const sseHeaders = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.method === 'HEAD') return new Response(null, { status: 200 })
    if (!req.url.includes('/v1/messages')) {
      return new Response('not found', { status: 404 })
    }
    const body = (await req.json().catch(() => ({}))) as ApiRequestBody & {
      stream?: boolean
    }
    if (phase === 'glm') {
      return new Response(glmSseBody(), { headers: sseHeaders })
    }
    kimiRequests.push(body)
    const rejection = kimiRejection(body)
    if (rejection) {
      return Response.json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: rejection },
        },
        { status: 400 },
      )
    }
    return new Response(okSseBody(), { headers: sseHeaders })
  },
})

function runCli(
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'src', 'bootstrap-entry.ts'), ...args],
      {
        cwd: PROJECT,
        // stdin must be closed: with the default pipe the CLI drains stdin and
        // waits forever for EOF even though the prompt came from argv.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: SANDBOX,
          DOGE_API_KEY: 'sk-e2e-dummy',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          ANTHROPIC_MODEL: 'mock-model',
          ANTHROPIC_SMALL_FAST_MODEL: 'mock-model',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'anthropic',
          NODE_ENV: process.env.NODE_ENV,
        },
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', d => (stdout += d))
    child.stderr!.on('data', d => (stderr += d))
    const timer = setTimeout(() => {
      child.kill()
      resolve({ status: null, stdout, stderr })
    }, 180_000)
    timer.unref()
    child.on('close', status => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

function findSessionFile(sessionId: string): string | null {
  const projectsDir = join(SANDBOX, 'projects')
  if (!existsDir(projectsDir)) return null
  for (const entry of readdirSync(projectsDir, { recursive: true })) {
    const path = entry.toString()
    if (path.endsWith(`${sessionId}.jsonl`)) {
      return join(projectsDir, path)
    }
  }
  return null
}

function existsDir(path: string): boolean {
  try {
    readdirSync(path)
    return true
  } catch {
    return false
  }
}

// Windows：子进程句柄/杀毒扫描会短暂锁住临时目录，直接 rmSync 抛 EBUSY。
// 关停 mock server 后带退避重试；仍失败则显式报告（C 盘不留测试数据）。
async function cleanupTemp(): Promise<void> {
  server.stop(true)
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(TMP, { recursive: true, force: true })
      return
    } catch (error) {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  failures++
  console.error(`  FAIL temp cleanup — ${TMP} still locked, remove manually`)
}

try {
  const SESSION_ID = '11111111-2222-3333-4444-555555555555'

  console.log('run A: GLM-shaped turn with server_tool_use lands in transcript')
  const runA = await runCli([
    '-p',
    '帮我联网查一下示例资料',
    '--session-id',
    SESSION_ID,
  ])
  check(
    'run A exits 0',
    runA.status === 0,
    `status=${runA.status} stderrTail=${(runA.stderr ?? '')
      .split(String.fromCharCode(10))
      .filter(l => !l.includes('DOGE-DEBUG') && l.trim())
      .slice(-15)
      .join(' | ')}`,
  )
  const sessionFile = findSessionFile(SESSION_ID)
  check('transcript file exists', sessionFile !== null)
  if (sessionFile) {
    const transcript = readFileSync(sessionFile, 'utf8')
    check(
      'transcript holds server_tool_use (GLM shape persisted)',
      transcript.includes('"server_tool_use"') &&
        transcript.includes('"tool_result"') &&
        transcript.includes('webReader'),
    )
  }

  console.log('run B: resume same session, endpoint now validates like Kimi')
  phase = 'kimi'
  const runB = await runCli(['-p', '继续', '--resume', SESSION_ID])
  check(
    'run B exits 0 (no 400 invalid_request_error)',
    runB.status === 0,
    `status=${runB.status} stdoutTail=${runB.stdout
      .split(String.fromCharCode(10))
      .slice(-4)
      .join(' | ')}`,
  )
  check('run B answered by model', runB.stdout.includes('ok'))
  check('Kimi-phase requests were observed', kimiRequests.length > 0)

  let sawFlattenedCall = false
  let sawReplayedPrompt = false
  for (const request of kimiRequests) {
    if (JSON.stringify(request).includes('帮我联网查一下示例资料')) {
      sawReplayedPrompt = true
    }
    for (const message of request.messages ?? []) {
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const block of blocks) {
        const text =
          typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : ''
        if (text.includes('[Server tool call: webReader]')) sawFlattenedCall = true
      }
    }
  }
  check(
    'history was actually replayed (run A prompt present)',
    sawReplayedPrompt,
  )
  check(
    'flattened text keeps the webReader call info',
    sawFlattenedCall,
  )

  if (sessionFile) {
    const transcript = readFileSync(sessionFile, 'utf8')
    check(
      'on-disk transcript still holds server_tool_use (display untouched)',
      transcript.includes('"server_tool_use"'),
    )
  }
} finally {
  await cleanupTemp()
}

console.log(failures === 0 ? '\ne2e-server-tool-replay: ALL PASS' : `\ne2e-server-tool-replay: ${failures} FAIL`)
process.exitCode = failures === 0 ? 0 : 1

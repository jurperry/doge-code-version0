// e2e（可保留回归资产）：OpenAI Chat Completions 兼容层「工具结果图片打散
// tool_calls 配对」全链路回归（914e9923 会话 400 的 CLI 级复现）。
//
// mock /v1/chat/completions 按 DeepSeek 严格规则校验每个出站请求：
//   ① assistant 带 N 个 tool_calls 后必须紧跟 N 条连续 role:'tool' 且
//      tool_call_id 一一对应，否则回 DeepSeek 原话 400；
//   ② image_url 内容块只允许出现在 user 消息里（Chat Completions 规范；
//      tool 消息必须纯文本）。
// mock 连续 TOOL_ROUNDS=6 轮回「两个并行 Read 调用」，指向沙箱项目里的两张
// 真实小 PNG；之后回最终文本。旧转换层在每个含图 tool_result 后立即插一条
// user 图片消息，把同一 assistant 的第 2 条 tool 消息隔开：每个图片回合先
// 400 再触发 claude.ts 剥图重试，other 重试预算（默认 5 次）耗尽后回合失败；
// 修复后同一历史的所有 tool 消息连续，全部请求一次通过。
// 断言：回合成功（is_error=false）、mock 从未回 400、请求数=轮数+1、
// tool_use/tool_result 事件各 12 个、每个请求都满足配对与图片位置规则；
// 正向断言图片未被静默丢弃：各请求 user 消息的 image_url 数序列为
// [0,2,4,6,8,10,12]，最终请求每个图片 label 与 tool_call_id 一一对应，且每轮
// 图片合并在一条 user 消息里（设计契约，不是实现偶然）。
// 可用 DOGE_E2E_CLI=<已有 CLI exe> 跑旧二进制，验证脚本的区分性（旧版应
// FAIL：出现 400 与 is_error=true）。
// 自建 test/ 沙箱并自清理（C 盘不落文件）。
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const TEST_ROOT = join(REPO_ROOT, 'test')
mkdirSync(TEST_ROOT, { recursive: true })
const TMP = mkdtempSync(join(TEST_ROOT, 'pairing-e2e-'))
const SANDBOX = join(TMP, 'config')
const PROJECT = join(TMP, 'project')
mkdirSync(SANDBOX, { recursive: true })
mkdirSync(PROJECT, { recursive: true })

// 1x1 透明 PNG（合法容器，Read 工具可解码成 image 工具结果）。
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const IMG_A = join(PROJECT, 'preview-a.png')
const IMG_B = join(PROJECT, 'preview-b.png')
writeFileSync(IMG_A, Buffer.from(TINY_PNG_B64, 'base64'))
writeFileSync(IMG_B, Buffer.from(TINY_PNG_B64, 'base64'))

// 旧实现每个图片回合消耗 1 次剥图重试（other 类预算 5 次），故第 6 个图片
// 回合的首次 400 即终止；修复后每个回合只有 1 个请求。
const TOOL_ROUNDS = 6
const DEEPSEEK_PAIRING_400 =
  "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)"

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

type OpenAIMessage = {
  role?: string
  content?: unknown
  tool_calls?: Array<{ id?: string }>
  tool_call_id?: string
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some(
    part =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'image_url',
  )
}

// 正向统计：只数 user 消息里的 image_url 部件，用于证明图片没有被集成层
// 静默丢弃（负向配对校验无法发现丢图）。
function imageUrlPartsInUserMessages(messages: OpenAIMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'image_url'
      ) {
        count++
      }
    }
  }
  return count
}

const IMAGE_LABEL_PATTERN = /\[Images returned by tool call ([^\]]+)\]/g

function imageLabelsInUserMessages(messages: OpenAIMessage[]): string[] {
  const labels: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const text =
        typeof part === 'object' && part !== null
          ? (part as { text?: unknown }).text
          : undefined
      if (typeof text !== 'string') continue
      for (const match of text.matchAll(IMAGE_LABEL_PATTERN)) {
        labels.push(match[1])
      }
    }
  }
  return labels
}

// 返回 null 表示请求合法；否则返回应回给客户端的 400 报文。
function validateRequest(messages: OpenAIMessage[]): string | null {
  for (const [i, message] of messages.entries()) {
    if (message.role === 'user') continue
    if (contentHasImage(message.content)) {
      return `image_url content is only allowed in user messages (messages[${i}] role=${String(message.role)})`
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].tool_calls
    if (!Array.isArray(calls) || calls.length === 0) continue
    // DeepSeek 只要求每个 tool_call_id 在紧随的连续 tool 消息里各被回应一次；
    // 并行工具结果的相对顺序会随 normalize/ensureToolResultPairing 变化，
    // 故按集合比较而不是按顺序。
    const expected = calls.map(call => call.id ?? '').sort()
    const seen: string[] = []
    for (
      let j = i + 1;
      j < messages.length && messages[j].role === 'tool';
      j++
    ) {
      seen.push(messages[j].tool_call_id ?? '')
    }
    const sortedSeen = [...seen].sort()
    if (
      sortedSeen.length !== expected.length ||
      sortedSeen.some((id, k) => id !== expected[k])
    ) {
      return DEEPSEEK_PAIRING_400
    }
  }
  return null
}

const sseHeaders = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
}

function sseResponse(chunks: unknown[]): Response {
  const body =
    chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
    'data: [DONE]\n\n'
  return new Response(body, { headers: sseHeaders })
}

const chatBase = (seq: number) => ({
  id: `chatcmpl-pairing-${seq}`,
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'deepseek-flash',
})

function readToolCallChunks(seq: number, round: number): Response {
  const base = chatBase(seq)
  const calls = [
    { index: 0, id: `call_e2e_${round}_a`, filePath: IMG_A },
    { index: 1, id: `call_e2e_${round}_b`, filePath: IMG_B },
  ]
  const chunks: unknown[] = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: calls.map(call => ({
              index: call.index,
              id: call.id,
              type: 'function',
              function: { name: 'Read', arguments: '' },
            })),
          },
          finish_reason: null,
        },
      ],
    },
  ]
  for (const call of calls) {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: call.index,
                function: {
                  arguments: JSON.stringify({ file_path: call.filePath }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
  }
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  })
  return sseResponse(chunks)
}

function finalTextChunks(seq: number): Response {
  const base = chatBase(seq)
  return sseResponse([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'IMG_PAIRING_REPLAY_OK' },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
    },
  ])
}

// mock 观测状态
let requestCount = 0
let rejectionCount = 0
let validToolRounds = 0
const validationErrors: string[] = []
const observedRequests: OpenAIMessage[][] = []
const requestImageCounts: number[] = []

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    if (req.method === 'HEAD') return new Response(null, { status: 200 })
    if (!new URL(req.url).pathname.endsWith('/chat/completions')) {
      return new Response('not found', { status: 404 })
    }
    requestCount++
    const body = (await req.json().catch(() => ({}))) as {
      messages?: OpenAIMessage[]
    }
    const messages = body.messages ?? []
    observedRequests.push(messages)
    requestImageCounts.push(imageUrlPartsInUserMessages(messages))

    const violation = validateRequest(messages)
    if (violation) {
      rejectionCount++
      validationErrors.push(violation)
      return Response.json(
        {
          error: {
            message: violation,
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request_error',
          },
        },
        { status: 400 },
      )
    }

    const hasToolMessages = messages.some(message => message.role === 'tool')
    if (!hasToolMessages) {
      return readToolCallChunks(requestCount, 1)
    }
    validToolRounds++
    if (validToolRounds < TOOL_ROUNDS) {
      return readToolCallChunks(requestCount, validToolRounds + 1)
    }
    return finalTextChunks(requestCount)
  },
})

interface CliRunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runCli(): Promise<CliRunResult> {
  // DOGE_E2E_CLI：用已有 CLI 二进制跑（修复前后区分性验证）；默认跑本仓源码。
  const cliExe = process.env.DOGE_E2E_CLI
  const program = cliExe
    ? [cliExe]
    : [process.execPath, join(REPO_ROOT, 'src', 'bootstrap-entry.ts')]
  const args = [
    '-p',
    '读取项目里两张预览图并对比',
    '--dangerously-skip-permissions',
    '--tools',
    'Read',
    '--no-session-persistence',
    '--verbose',
    '--output-format',
    'stream-json',
  ]
  return new Promise(resolvePromise => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ]) {
      delete env[key]
    }
    const child = spawn(program[0], [...program.slice(1), ...args], {
      cwd: PROJECT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        CLAUDE_CONFIG_DIR: SANDBOX,
        DOGE_API_KEY: 'sk-e2e-dummy',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
        ANTHROPIC_MODEL: 'deepseek-flash',
        ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-flash',
        CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'openai',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_MAX_TURNS: '20',
        DOGE_HEADLESS_BUILTIN_MCP: '0',
        DOGE_PLAYWRIGHT_MCP: '0',
        NODE_ENV: 'production',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', data => (stdout += data))
    child.stderr!.on('data', data => (stderr += data))
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise({ status: null, stdout, stderr })
    }, 180_000)
    timer.unref()
    child.on('close', status => {
      clearTimeout(timer)
      resolvePromise({ status, stdout, stderr })
    })
  })
}

interface ParsedOutput {
  result?: { subtype?: string; is_error?: boolean; result?: string }
  toolUseCount: number
  toolResultCount: number
}

function parseStreamJson(stdout: string): ParsedOutput {
  const parsed: ParsedOutput = { toolUseCount: 0, toolResultCount: 0 }
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let message: {
      type?: string
      message?: { content?: Array<{ type?: string }> | string }
    }
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.type === 'result') {
      parsed.result = message as ParsedOutput['result']
      continue
    }
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') parsed.toolUseCount++
      if (block.type === 'tool_result') parsed.toolResultCount++
    }
  }
  return parsed
}

// Windows：子进程句柄/杀毒扫描会短暂锁住临时目录，直接 rmSync 会 EBUSY。
async function cleanupTemp(): Promise<void> {
  server.stop(true)
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(TMP, { recursive: true, force: true })
      return
    } catch {
      await new Promise(r => setTimeout(r, 200))
    }
  }
  failures++
  console.error(`  FAIL temp cleanup — ${TMP} still locked, remove manually`)
}

try {
  const run = await runCli()
  const parsed = parseStreamJson(run.stdout)

  check(
    'CLI exits 0 (turn succeeded)',
    run.status === 0,
    `status=${run.status}`,
  )
  check('result is success', parsed.result?.subtype === 'success')
  check('result is_error is false', parsed.result?.is_error === false)
  check(
    'final answer came from the mock model',
    typeof parsed.result?.result === 'string' &&
      parsed.result.result.includes('IMG_PAIRING_REPLAY_OK'),
    `result=${String(parsed.result?.result).slice(0, 120)}`,
  )

  check('mock never rejected a request with 400', rejectionCount === 0, `${rejectionCount} rejections: ${validationErrors[0] ?? ''}`)
  check(
    'one request per model round (no strip-images retry)',
    requestCount === TOOL_ROUNDS + 1,
    `requests=${requestCount} expected=${TOOL_ROUNDS + 1}`,
  )
  check(
    'every request satisfied tool_calls pairing + image placement',
    validationErrors.length === 0,
  )
  check(
    `all ${TOOL_ROUNDS} parallel-Read rounds executed`,
    parsed.toolUseCount === TOOL_ROUNDS * 2 &&
      parsed.toolResultCount === TOOL_ROUNDS * 2,
    `tool_use=${parsed.toolUseCount} tool_result=${parsed.toolResultCount}`,
  )

  // 正向断言：图片不能被集成层静默丢弃。首个请求还没有工具结果（0 张），
  // 之后每个回合的两个 Read 各带回一张 PNG，下一请求的 user 图片数 +2。
  const expectedImageCounts = Array.from(
    { length: TOOL_ROUNDS + 1 },
    (_, index) => index * 2,
  )
  check(
    'each tool round attaches exactly two images to the next request',
    JSON.stringify(requestImageCounts) === JSON.stringify(expectedImageCounts),
    `counts=[${requestImageCounts.join(',')}] expected=[${expectedImageCounts.join(',')}]`,
  )

  // 最后一次入站请求必须已把 6 轮工具结果全部对齐（图片进入 user 消息、tool
  // 消息纯文本且连续）。
  const lastRequest = observedRequests.at(-1) ?? []
  const lastAssistantWithCalls = [...lastRequest]
    .reverse()
    .find(message => Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
  let lastToolRunComplete = false
  if (lastAssistantWithCalls) {
    const index = lastRequest.indexOf(lastAssistantWithCalls)
    const expected = lastAssistantWithCalls.tool_calls!
      .map(call => call.id ?? '')
      .sort()
    const followed = lastRequest
      .slice(index + 1)
      .filter(message => message.role === 'tool')
      .map(message => message.tool_call_id ?? '')
      .sort()
    lastToolRunComplete =
      expected.length === 2 && followed.join(',') === expected.join(',')
  }
  check(
    'last request carries both tool_call_ids of its final parallel batch',
    lastToolRunComplete,
  )

  // 设计契约：每轮工具结果的全部图片合并进同一条 user 消息（不是每个
  // tool_result 各一条）；图片 label 由对应 tool_call_id 生成，两者必须一一对应，
  // 防止 label 与图片错配。
  const finalToolCallIds = lastRequest.flatMap(message =>
    (message.tool_calls ?? []).map(call => call.id ?? ''),
  )
  const finalImageLabels = imageLabelsInUserMessages(lastRequest)
  check(
    'final request labels every image-bearing tool_call_id exactly once',
    finalImageLabels.length === TOOL_ROUNDS * 2 &&
      [...finalImageLabels].sort().join(',') ===
        [...finalToolCallIds].sort().join(','),
    `labels=${finalImageLabels.length} toolCallIds=${finalToolCallIds.length}`,
  )
  const finalImageUserMessages = lastRequest.filter(
    message =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      imageUrlPartsInUserMessages([message]) > 0,
  )
  check(
    'final request merges each tool round images into one user message',
    finalImageUserMessages.length === TOOL_ROUNDS,
    `imageUserMessages=${finalImageUserMessages.length} expected=${TOOL_ROUNDS}`,
  )
} finally {
  await cleanupTemp()
}

console.log(
  failures === 0
    ? '\ne2e-openai-tool-image-pairing: ALL PASS'
    : `\ne2e-openai-tool-image-pairing: ${failures} FAIL`,
)
process.exitCode = failures === 0 ? 0 : 1

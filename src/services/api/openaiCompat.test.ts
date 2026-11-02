import { test, expect } from 'bun:test'
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { convertAnthropicRequestToOpenAI, createAnthropicStreamFromOpenAI, createOpenAICompatStream } from './openaiCompat.js'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

test('premature OpenAI EOF is a retryable connection failure', async () => {
  const reader = new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n').body!.getReader()
  const error = await expectError((async () => {
    for await (const event of createAnthropicStreamFromOpenAI({ reader, model: 'test' })) {}
  })())
  expect(error).toBeInstanceOf(APIConnectionError)
})

test('OpenAI SSE authentication error retains terminal status instead of reconnecting', async () => {
  const reader = new Response('data: {"error":{"type":"authentication_error","message":"bad key"}}\n\n').body!.getReader()
  const error = await expectError((async () => { for await (const event of createAnthropicStreamFromOpenAI({ reader, model: 'test' })) {} })())
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(401)
})

const GATEWAY_UPSTREAM_400 =
  '{"error":{"message":"Error from provider (Console Go): Upstream request failed","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'

test('invalid OpenAI endpoint is a terminal configuration error before fetch', async () => {
  let requests = 0
  const error = await expectError(createOpenAICompatStream({ apiKey: 'test', baseURL: 'not-a-url', fetch: (async () => { requests++; return new Response(null) }) as typeof fetch }, { model: 'test', messages: [] }))
  expect(error).not.toBeInstanceOf(APIConnectionError)
  expect(requests).toBe(0)
})

test('maps output_config.effort to the standard reasoning_effort field', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'gateway-model',
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'xhigh' },
  } as Parameters<typeof convertAnthropicRequestToOpenAI>[0])
  expect(request.reasoning_effort).toBe('xhigh')
  expect((request as Record<string, unknown>).effort).toBeUndefined()
  expect((request as Record<string, unknown>).output_config).toBeUndefined()
})

test('omits reasoning_effort when effort is not requested', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'gateway-model',
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(request.reasoning_effort).toBeUndefined()
})

test('merges provider-specific thinking extra body fields (Qwen budget mode)', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'qwen3.8-max',
    messages: [{ role: 'user', content: 'hi' }],
    extra_body: { enable_thinking: true, thinking_budget: 16384 },
  })
  expect(request).toMatchObject({
    enable_thinking: true,
    thinking_budget: 16384,
  })
  expect(request.reasoning_effort).toBeUndefined()
})

function stubFetch(response: Response): typeof globalThis.fetch {
  return (() => Promise.resolve(response)) as unknown as typeof globalThis.fetch
}

function failingFetch(error: unknown): typeof globalThis.fetch {
  return (() => Promise.reject(error)) as unknown as typeof globalThis.fetch
}

const baseConfig = { apiKey: 'sk-test', baseURL: 'https://example.test' }
const baseRequest = { model: 'test-model', messages: [{ role: 'user' as const, content: 'hi' }] }

async function expectError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}

test('gateway 400 "Upstream request failed" wrapper → retryable APIError normalized to 503', async () => {
  const error = await expectError(
    createOpenAICompatStream(
      { ...baseConfig, fetch: stubFetch(new Response(GATEWAY_UPSTREAM_400, { status: 400 })) },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(503)
  expect((error as Error).message).toContain('status 400')
})

test('gateway 422 "Upstream request failed" wrapper → retryable APIError normalized to 503', async () => {
  const error = await expectError(
    createOpenAICompatStream(
      { ...baseConfig, fetch: stubFetch(new Response(GATEWAY_UPSTREAM_400, { status: 422 })) },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(503)
})

test('genuine 400 validation error preserves its non-retryable API status', async () => {
  const error = await expectError(
    createOpenAICompatStream(
      {
        ...baseConfig,
        fetch: stubFetch(
          new Response('{"error":{"message":"model does not exist"}}', { status: 400 }),
        ),
      },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(400)
  expect((error as Error).message).toContain('status 400')
})

test('429 → APIError with native 429 status (retryable + rate-limit semantics)', async () => {
  const error = await expectError(
    createOpenAICompatStream(
      { ...baseConfig, fetch: stubFetch(new Response('{"error":{"message":"slow down"}}', { status: 429 })) },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(429)
})

test('500 → APIError with native 500 status', async () => {
  const error = await expectError(
    createOpenAICompatStream(
      { ...baseConfig, fetch: stubFetch(new Response('oops', { status: 500 })) },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(500)
})

test('context overflow 400 still throws "Prompt is too long" plain Error (PTL detection)', async () => {
  const error = await expectError(
    createOpenAICompatStream(
      {
        ...baseConfig,
        fetch: stubFetch(
          new Response('{"error":{"message":"maximum context length is 128000 tokens"}}', {
            status: 400,
          }),
        ),
      },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(APIError)
  expect((error as Error).message).toStartWith('Prompt is too long:')
})

test('network-level fetch failure → retryable APIConnectionError', async () => {
  const error = await expectError(
    createOpenAICompatStream(
      { ...baseConfig, fetch: failingFetch(new TypeError('fetch failed')) },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(APIConnectionError)
})

test('pre-aborted signal returns user cancellation instead of APIConnectionError', async () => {
  const controller = new AbortController()
  controller.abort()
  const abortError = new DOMException('This operation was aborted', 'AbortError')
  const error = await expectError(
    createOpenAICompatStream(
      { ...baseConfig, fetch: failingFetch(abortError) },
      baseRequest,
      controller.signal,
    ),
  )
  expect(error).toBeInstanceOf(APIUserAbortError)
})

test('200 with body returns a stream reader', async () => {
  const reader = await createOpenAICompatStream(
    { ...baseConfig, fetch: stubFetch(new Response('data: [DONE]\n\n', { status: 200 })) },
    baseRequest,
  )
  expect(typeof reader.read).toBe('function')
  await reader.cancel()
})

// --- Streaming tool-call translation (createAnthropicStreamFromOpenAI) ---

function sseOf(chunks: unknown[]): string {
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
}

async function collectStreamEvents(sse: string): Promise<BetaRawMessageStreamEvent[]> {
  const reader = new Response(sse).body!.getReader()
  const events: BetaRawMessageStreamEvent[] = []
  for await (const event of createAnthropicStreamFromOpenAI({ reader, model: 'test-model' })) {
    events.push(event)
  }
  return events
}

test('parallel tool calls with no preceding text get distinct content-block indices', async () => {
  const events = await collectStreamEvents(
    sseOf([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'Bash', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"cmd":"ls"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]),
  )
  const starts = events.filter(
    e => e.type === 'content_block_start' && e.content_block.type === 'tool_use',
  )
  expect(starts.length).toBe(2)
  const indices = starts.map(e => e.index)
  expect(new Set(indices).size).toBe(2)

  const deltas = events.filter(
    e => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta',
  )
  // Reassemble each block's argument stream — interleaved (colliding) indices
  // would concatenate both tools' fragments into invalid JSON.
  const argsByIndex = new Map<number, string>()
  for (const delta of deltas) {
    const partial = (delta.delta as { partial_json: string }).partial_json
    argsByIndex.set(delta.index, (argsByIndex.get(delta.index) ?? '') + partial)
  }
  expect(JSON.parse(argsByIndex.get(indices[0])!)).toEqual({ path: 'a.txt' })
  expect(JSON.parse(argsByIndex.get(indices[1])!)).toEqual({ cmd: 'ls' })
})

test('text then tool calls keeps the historical index assignment (text=0, tools after)', async () => {
  const events = await collectStreamEvents(
    sseOf([
      { choices: [{ index: 0, delta: { content: 'thinking...' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '{"p":1}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'Bash', arguments: '{"c":2}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]),
  )
  const textStart = events.find(
    e => e.type === 'content_block_start' && e.content_block.type === 'text',
  )
  const toolStarts = events.filter(
    e => e.type === 'content_block_start' && e.content_block.type === 'tool_use',
  )
  expect(textStart?.index).toBe(0)
  expect(toolStarts.map(e => e.index)).toEqual([1, 2])
})

// --- Vendor cache-hit usage mapping (desktop-app 0.2.78 cache hit rate) ---
// cached ⊆ prompt_tokens across OpenAI-compatible vendors; the anthropic-shape
// output keeps the input-side total equal to prompt_tokens.

test('vendor cache fields map into anthropic usage (details / DeepSeek / Kimi forms)', async () => {
  const cases: Array<{ usage: Record<string, unknown>; input: number; read: number; write: number }> = [
    // OpenAI / GLM / Qwen details form
    { usage: { prompt_tokens: 1075, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1024 } }, input: 51, read: 1024, write: 0 },
    // DeepSeek top-level hit/miss (prompt = hit + miss)
    { usage: { prompt_tokens: 100, completion_tokens: 4, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }, input: 20, read: 80, write: 0 },
    // Kimi legacy top-level cached_tokens + explicit write
    { usage: { prompt_tokens: 40, completion_tokens: 4, cached_tokens: 10, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 } }, input: 25, read: 10, write: 5 },
    // No cache data → untouched totals, no cache fields
    { usage: { prompt_tokens: 30, completion_tokens: 4 }, input: 30, read: 0, write: 0 },
  ]
  for (const c of cases) {
    const events = await collectStreamEvents(
      sseOf([{ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: c.usage }]),
    )
    const delta = events.find(e => e.type === 'message_delta') as { usage?: Record<string, unknown> }
    expect(delta.usage?.input_tokens).toBe(c.input)
    expect(delta.usage?.output_tokens).toBe(4)
    if (c.read > 0) expect(delta.usage?.cache_read_input_tokens).toBe(c.read)
    else expect(delta.usage?.cache_read_input_tokens).toBeUndefined()
    if (c.write > 0) expect(delta.usage?.cache_creation_input_tokens).toBe(c.write)
    else expect(delta.usage?.cache_creation_input_tokens).toBeUndefined()
    // Input-side total stays equal to the vendor's prompt_tokens
    const total = (delta.usage?.input_tokens as number) + (delta.usage?.cache_read_input_tokens as number ?? 0) + (delta.usage?.cache_creation_input_tokens as number ?? 0)
    expect(total).toBe(c.usage.prompt_tokens)
  }
})

test('zero-argument tool call survives — no synthetic empty-text block clobbers it', async () => {
  const events = await collectStreamEvents(
    sseOf([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'ping', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]),
  )
  const starts = events.filter(e => e.type === 'content_block_start')
  expect(starts.length).toBe(1)
  expect(starts[0].content_block.type).toBe('tool_use')
  expect((starts[0].content_block as { id?: string }).id).toBe('call_x')
})

test('response with no content at all still emits the synthetic empty-text block', async () => {
  const events = await collectStreamEvents(
    sseOf([
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]),
  )
  const textStart = events.find(
    e => e.type === 'content_block_start' && e.content_block.type === 'text',
  )
  expect(textStart).toBeDefined()
  expect(textStart?.index).toBe(0)
})

// --- Multimodal image conversion (vision through Chat Completions) ---

const IMAGE_B64 = 'aGVsbG8gd29ybGQ='

const imageToolResultMessage = {
  role: 'user',
  content: [
    {
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: IMAGE_B64,
          },
        },
      ],
    },
  ],
} as unknown as BetaMessageParam

test('tool_result with image → tool message stays textual, image rides a follow-up user message as image_url data URL', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }],
      } as unknown as BetaMessageParam,
      imageToolResultMessage,
    ],
  })

  const toolMessage = request.messages.find(m => m.role === 'tool')
  expect(toolMessage).toBeDefined()
  expect(toolMessage!.content).not.toContain(IMAGE_B64)
  expect(JSON.stringify(toolMessage!.content)).not.toContain('"type":"image"')

  const imageMessage = request.messages.find(
    m => m.role === 'user' && Array.isArray(m.content),
  )
  expect(imageMessage).toBeDefined()
  const parts = imageMessage!.content as Array<Record<string, unknown>>
  const imagePart = parts.find(p => p.type === 'image_url')
  expect(imagePart).toEqual({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${IMAGE_B64}` },
  })
})

test('tool_result mixing text and image → text in tool message, image in follow-up user message', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_02',
            content: [
              { type: 'text', text: 'screenshot taken' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: IMAGE_B64 },
              },
            ],
          },
        ],
      } as unknown as BetaMessageParam,
    ],
  })

  const toolMessage = request.messages.find(m => m.role === 'tool')
  expect(toolMessage!.content).toBe('screenshot taken')
  const imageMessage = request.messages.find(
    m => m.role === 'user' && Array.isArray(m.content),
  )
  expect(imageMessage).toBeDefined()
  const parts = imageMessage!.content as Array<Record<string, unknown>>
  expect(parts.some(p => p.type === 'image_url')).toBe(true)
  expect(
    parts.some(
      p =>
        p.type === 'image_url' &&
        (p.image_url as { url: string }).url === `data:image/jpeg;base64,${IMAGE_B64}`,
    ),
  ).toBe(true)
})

test('user message with text + image blocks → multimodal content array (text part + image_url part)', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this picture?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: IMAGE_B64 },
          },
        ],
      },
    ],
  })

  const userMessage = request.messages.find(m => m.role === 'user')
  expect(Array.isArray(userMessage!.content)).toBe(true)
  const parts = userMessage!.content as Array<Record<string, unknown>>
  expect(parts[0]).toEqual({ type: 'text', text: 'what is in this picture?' })
  expect(parts[1]).toEqual({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${IMAGE_B64}` },
  })
})

test('url-sourced image block passes the URL through as image_url', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.test/cat.png' },
          },
        ],
      },
    ],
  })

  const userMessage = request.messages.find(m => m.role === 'user')
  const parts = userMessage!.content as Array<Record<string, unknown>>
  expect(parts).toEqual([
    { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } },
  ])
})

test('plain text request shape is unchanged (string content, no follow-up messages)', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      { role: 'user', content: 'plain question' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_03', content: 'plain result' },
        ],
      } as unknown as BetaMessageParam,
    ],
  })

  expect(request.messages[0]).toEqual({ role: 'user', content: 'plain question' })
  const toolMessage = request.messages.find(m => m.role === 'tool')
  expect(toolMessage!.content).toBe('plain result')
  expect(
    request.messages.filter(m => Array.isArray(m.content)),
  ).toHaveLength(0)
})

// --- Tool-result image follow-up ordering (strict tool_calls pairing) ---

// DeepSeek rejects a request when the tool messages answering an assistant
// message's tool_calls are not contiguous. Every image follow-up must therefore
// be emitted only after the whole tool run.
function expectContiguousToolMessages(
  messages: ReadonlyArray<{
    role?: string
    tool_call_id?: string
    tool_calls?: Array<{ id: string }>
  }>,
): void {
  for (let i = 0; i < messages.length; i++) {
    const toolCalls = messages[i].tool_calls
    if (messages[i].role !== 'assistant' || !toolCalls?.length) continue
    const contiguousToolIds: string[] = []
    for (
      let j = i + 1;
      j < messages.length && messages[j].role === 'tool';
      j++
    ) {
      contiguousToolIds.push(messages[j].tool_call_id ?? '')
    }
    expect(contiguousToolIds).toEqual(toolCalls.map(call => call.id))
  }
}

const readToolUse = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'Read',
  input: {},
})

const pngToolResult = (id: string) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: IMAGE_B64 },
    },
  ],
})

const textToolResult = (id: string, text: string) => ({
  type: 'tool_result',
  tool_use_id: id,
  content: [{ type: 'text', text }],
})

test('single tool_call with image result → tool message then image user message (pairing invariant held)', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      { role: 'assistant', content: [readToolUse('toolu_a')] },
      { role: 'user', content: [pngToolResult('toolu_a')] },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.messages.map(m => m.role)).toEqual(['assistant', 'tool', 'user'])
  expect(request.messages[1].tool_call_id).toBe('toolu_a')
  expect(request.messages[1].content).toBe('(tool returned image content)')
  const imageContent = request.messages[2].content as Array<Record<string, unknown>>
  expect(imageContent[0]).toEqual({
    type: 'text',
    text: '[Images returned by tool call toolu_a]',
  })
  expect(imageContent[1]).toEqual({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${IMAGE_B64}` },
  })
  expectContiguousToolMessages(request.messages)
})

test('parallel tool_calls where only the first result has an image → both tool messages stay contiguous (regression: 914e9923 400)', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'assistant',
        content: [readToolUse('toolu_img'), readToolUse('toolu_txt')],
      },
      {
        role: 'user',
        content: [
          pngToolResult('toolu_img'),
          textToolResult('toolu_txt', 'plain output'),
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.messages.map(m => m.role)).toEqual([
    'assistant',
    'tool',
    'tool',
    'user',
    'assistant',
  ])
  expect(
    request.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id),
  ).toEqual(['toolu_img', 'toolu_txt'])
  expect(request.messages[3].tool_call_id).toBeUndefined()
  expect(Array.isArray(request.messages[3].content)).toBe(true)
  expectContiguousToolMessages(request.messages)
})

test('parallel tool_calls both returning images → one user message carries both images after the tool run', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'assistant',
        content: [readToolUse('toolu_a'), readToolUse('toolu_b')],
      },
      {
        role: 'user',
        content: [pngToolResult('toolu_a'), pngToolResult('toolu_b')],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.messages.map(m => m.role)).toEqual([
    'assistant',
    'tool',
    'tool',
    'user',
    'assistant',
  ])
  // Design contract (not an implementation coincidence): all images of one tool
  // run merge into a single user message, so N image-bearing tools still yield
  // exactly one follow-up message.
  const imageMessages = request.messages.filter(
    m => m.role === 'user' && Array.isArray(m.content),
  )
  expect(imageMessages).toHaveLength(1)
  const parts = imageMessages[0].content as Array<Record<string, unknown>>
  expect(parts.filter(part => part.type === 'image_url')).toHaveLength(2)
  expect(parts.filter(part => part.type === 'text')).toHaveLength(2)
  expectContiguousToolMessages(request.messages)
})

test('mixed text + image tool results stay ordered before a following user message', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'assistant',
        content: [readToolUse('toolu_shot'), readToolUse('toolu_txt')],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_shot',
            content: [
              { type: 'text', text: 'screenshot taken' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: IMAGE_B64,
                },
              },
            ],
          },
          textToolResult('toolu_txt', 'plain output'),
        ],
      },
      { role: 'user', content: 'continue' },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.messages.map(m => m.role)).toEqual([
    'assistant',
    'tool',
    'tool',
    'user',
    'user',
  ])
  expect(request.messages[1].content).toBe('screenshot taken')
  expect(request.messages[4].content).toBe('continue')
  const imageContent = request.messages[3].content as Array<Record<string, unknown>>
  expect(imageContent.some(part => part.type === 'image_url')).toBe(true)
  expectContiguousToolMessages(request.messages)
})

test('tool_results split over consecutive user messages stay contiguous and flush images once', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'assistant',
        content: [readToolUse('toolu_a'), readToolUse('toolu_b')],
      },
      { role: 'user', content: [pngToolResult('toolu_a')] },
      { role: 'user', content: [pngToolResult('toolu_b')] },
      { role: 'user', content: 'continue' },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.messages.map(m => m.role)).toEqual([
    'assistant',
    'tool',
    'tool',
    'user',
    'user',
  ])
  expect(
    request.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id),
  ).toEqual(['toolu_a', 'toolu_b'])
  // Same merge contract across consecutive user messages: the two runs'
  // tool_results belong to one tool round, so their images share one message.
  const imageMessages = request.messages.filter(
    m => m.role === 'user' && Array.isArray(m.content),
  )
  expect(imageMessages).toHaveLength(1)
  expect(
    (imageMessages[0].content as Array<Record<string, unknown>>).filter(
      part => part.type === 'image_url',
    ),
  ).toHaveLength(2)
  expect(request.messages[4].content).toBe('continue')
  expectContiguousToolMessages(request.messages)
})

test('plain text tool results keep the pre-fix shape (no follow-up user messages)', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'assistant',
        content: [readToolUse('toolu_a'), readToolUse('toolu_b')],
      },
      {
        role: 'user',
        content: [
          textToolResult('toolu_a', 'first'),
          textToolResult('toolu_b', 'second'),
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.messages.map(m => m.role)).toEqual([
    'assistant',
    'tool',
    'tool',
    'assistant',
  ])
  expect(
    request.messages.filter(m => m.role === 'tool').map(m => m.content),
  ).toEqual(['first', 'second'])
  expect(request.messages.filter(m => Array.isArray(m.content))).toHaveLength(0)
  expectContiguousToolMessages(request.messages)
})

// --- Tool run boundaries (pending image queue must not leak across runs) ---

test('two independent image tool rounds stay isolated (one merged image message per run)', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'assistant',
        content: [readToolUse('toolu_r1a'), readToolUse('toolu_r1b')],
      },
      {
        role: 'user',
        content: [pngToolResult('toolu_r1a'), pngToolResult('toolu_r1b')],
      },
      {
        role: 'assistant',
        content: [readToolUse('toolu_r2a'), readToolUse('toolu_r2b')],
      },
      {
        role: 'user',
        content: [pngToolResult('toolu_r2a'), pngToolResult('toolu_r2b')],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.messages.map(m => m.role)).toEqual([
    'assistant',
    'tool',
    'tool',
    'user',
    'assistant',
    'tool',
    'tool',
    'user',
    'assistant',
  ])
  const imageContents = request.messages
    .filter(m => m.role === 'user' && Array.isArray(m.content))
    .map(m => m.content as Array<Record<string, unknown>>)
  expect(imageContents).toHaveLength(2)
  const labelsOf = (parts: Array<Record<string, unknown>>) =>
    parts.filter(part => part.type === 'text').map(part => part.text)
  expect(labelsOf(imageContents[0])).toEqual([
    '[Images returned by tool call toolu_r1a]',
    '[Images returned by tool call toolu_r1b]',
  ])
  expect(labelsOf(imageContents[1])).toEqual([
    '[Images returned by tool call toolu_r2a]',
    '[Images returned by tool call toolu_r2b]',
  ])
  // 第二轮图片不得混进第一轮消息（pending 队列必须在 assistant 边界清空）。
  expect(JSON.stringify(imageContents[0])).not.toContain('toolu_r2')
  expect(JSON.stringify(imageContents[1])).not.toContain('toolu_r1')
  expectContiguousToolMessages(request.messages)
})

test('user message with tool_result image + text + direct image keeps both images', () => {
  const directImage = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: IMAGE_B64 },
  }
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      { role: 'assistant', content: [readToolUse('toolu_mix')] },
      {
        role: 'user',
        content: [
          pngToolResult('toolu_mix'),
          { type: 'text', text: 'and this one too' },
          directImage,
        ],
      },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.messages.map(m => m.role)).toEqual([
    'assistant',
    'tool',
    'user',
    'user',
  ])
  // 工具图片先 flush，随后才是同一 user 消息的文本 + 直接图片内容。
  const toolImageContent = request.messages[2].content as Array<Record<string, unknown>>
  expect(toolImageContent[0]).toEqual({
    type: 'text',
    text: '[Images returned by tool call toolu_mix]',
  })
  expect(toolImageContent.some(part => part.type === 'image_url')).toBe(true)
  expect(request.messages[3].content).toEqual([
    { type: 'text', text: 'and this one too' },
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${IMAGE_B64}` },
    },
  ])
  const totalImages = request.messages.reduce(
    (count, message) =>
      count +
      (Array.isArray(message.content)
        ? (message.content as Array<Record<string, unknown>>).filter(
            part => part.type === 'image_url',
          ).length
        : 0),
    0,
  )
  expect(totalImages).toBe(2)
  expectContiguousToolMessages(request.messages)
})

test('request ending with a multi-image tool round flushes one merged user image message', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'test-model',
    messages: [
      {
        role: 'assistant',
        content: [readToolUse('toolu_a'), readToolUse('toolu_b')],
      },
      {
        role: 'user',
        content: [pngToolResult('toolu_a'), pngToolResult('toolu_b')],
      },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.messages.map(m => m.role)).toEqual([
    'assistant',
    'tool',
    'tool',
    'user',
  ])
  const lastContent = request.messages[3].content as Array<Record<string, unknown>>
  expect(lastContent.filter(part => part.type === 'image_url')).toHaveLength(2)
  expect(lastContent.filter(part => part.type === 'text')).toHaveLength(2)
  expectContiguousToolMessages(request.messages)
})

function synthesizedSearchResults(events: BetaRawMessageStreamEvent[]) {
  return events.flatMap(event =>
    event.type === 'content_block_start' &&
    event.content_block.type === 'web_search_tool_result'
      ? [event.content_block]
      : [],
  )
}

test('Chat web search maps to web_search_options without a phantom function tool', () => {
  const request = convertAnthropicRequestToOpenAI({
    model: 'gpt-4o-search-preview',
    messages: [],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 8,
      } as unknown as Parameters<typeof convertAnthropicRequestToOpenAI>[0]['tools'][number],
    ],
    tool_choice: { type: 'tool', name: 'web_search' },
  })
  expect(request.web_search_options).toEqual({ search_context_size: 'high' })
  expect(request.tools).toBeUndefined()
  expect(request.tool_choice).toBeUndefined()
})

test('Chat delta url_citation annotations synthesize structured search results', async () => {
  const events = await collectStreamEvents(
    sseOf([
      { id: 'search_1', choices: [{ delta: { content: 'Found it.' }, finish_reason: null }] },
      {
        id: 'search_1',
        choices: [{
          delta: {
            annotations: [{
              type: 'url_citation',
              url_citation: { url: 'https://example.com/a', title: 'Article A' },
            }],
          },
          finish_reason: 'stop',
        }],
      },
    ]),
  )
  const blocks = synthesizedSearchResults(events)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].content).toEqual([
    expect.objectContaining({
      type: 'web_search_result',
      url: 'https://example.com/a',
      title: 'Article A',
    }),
  ])
})

test('Chat final-message annotations support direct citations and reject unsafe URLs', async () => {
  const events = await collectStreamEvents(
    sseOf([
      { choices: [{ delta: { content: 'Done.' }, finish_reason: null }] },
      {
        choices: [{
          delta: {},
          message: {
            annotations: [
              { type: 'url_citation', url: 'https://example.com/final', title: 'Final' },
              { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe' },
            ],
          },
          finish_reason: 'stop',
        }],
      },
    ]),
  )
  const blocks = synthesizedSearchResults(events)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].content).toEqual([
    expect.objectContaining({ url: 'https://example.com/final', title: 'Final' }),
  ])
})

test('Chat GLM search_result metadata is collected, deduped and retains the best title', async () => {
  const events = await collectStreamEvents(
    sseOf([
      {
        search_result: [{ title: '', link: 'https://example.com/glm' }],
        choices: [{ delta: { content: 'Found.' }, finish_reason: null }],
      },
      {
        choices: [{
          delta: {
            search_result: [
              { title: 'GLM result', link: 'https://example.com/glm' },
              { title: 'Second', url: 'https://example.com/second' },
            ],
          },
          finish_reason: 'stop',
        }],
      },
    ]),
  )
  const blocks = synthesizedSearchResults(events)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].content).toEqual([
    expect.objectContaining({ url: 'https://example.com/glm', title: 'GLM result' }),
    expect.objectContaining({ url: 'https://example.com/second', title: 'Second' }),
  ])
})

test('Chat empty search_result metadata preserves search activity with zero hits', async () => {
  const events = await collectStreamEvents(
    sseOf([
      {
        search_result: [],
        choices: [{ delta: { content: 'No matching pages.' }, finish_reason: 'stop' }],
      },
    ]),
  )
  const blocks = synthesizedSearchResults(events)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].content).toEqual([])
})

test('Chat ordinary text without structured metadata does not fabricate search activity', async () => {
  const events = await collectStreamEvents(
    sseOf([
      { choices: [{ delta: { content: 'I cannot search https://example.com' }, finish_reason: 'stop' }] },
    ]),
  )
  expect(synthesizedSearchResults(events)).toHaveLength(0)
})

test('Chat standalone search_result metadata chunks may have no choices', async () => {
  const events = await collectStreamEvents(
    sseOf([
      {
        search_result: [{ title: 'Standalone', link: 'https://example.com/standalone' }],
        choices: [],
      },
      { choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] },
    ]),
  )
  const blocks = synthesizedSearchResults(events)
  expect(blocks).toHaveLength(1)
  expect(blocks[0].content).toEqual([
    expect.objectContaining({ url: 'https://example.com/standalone', title: 'Standalone' }),
  ])
})

test('Chat no-text tool and search blocks use consecutive content indices', async () => {
  const events = await collectStreamEvents(
    sseOf([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_weather',
              type: 'function',
              function: { name: 'Weather', arguments: '{}' },
            }],
            annotations: [{
              type: 'url_citation',
              url_citation: { url: 'https://example.com/weather', title: 'Weather' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
  )
  const starts = events.filter(event => event.type === 'content_block_start')
  expect(starts.map(event => event.index)).toEqual([0, 1, 2])
  expect(starts.map(event => event.content_block.type)).toEqual([
    'tool_use',
    'server_tool_use',
    'web_search_tool_result',
  ])
})

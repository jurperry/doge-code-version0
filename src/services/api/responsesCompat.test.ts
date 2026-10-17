import { test, expect } from 'bun:test'
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import type {
  BetaMessageParam,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  convertAnthropicRequestToResponses,
  createAnthropicStreamFromResponses,
  createResponsesCompatStream,
} from './responsesCompat.js'

const GATEWAY_UPSTREAM_400 =
  '{"error":{"message":"Error from provider (Console Go): Upstream request failed","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'

test('invalid Responses endpoint is a terminal configuration error before fetch', async () => {
  let requests = 0
  const error = await expectError(createResponsesCompatStream({ apiKey: 'test', baseURL: 'not-a-url', fetch: (async () => { requests++; return new Response(null) }) as typeof fetch }, { model: 'test', input: [] }))
  expect(error).not.toBeInstanceOf(APIConnectionError)
  expect(requests).toBe(0)
})

test('Responses response.failed is terminal authentication failure instead of successful message_stop', async () => {
  const reader = new Response('event: response.failed\ndata: {"type":"response.failed","response":{"id":"test","error":{"code":"invalid_api_key","message":"bad key"}}}\n\n').body!.getReader()
  const error = await expectError((async () => { for await (const event of createAnthropicStreamFromResponses({ reader, model: 'test' })) {} })())
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(401)
})

function stubFetch(response: Response): typeof globalThis.fetch {
  return (() => Promise.resolve(response)) as unknown as typeof globalThis.fetch
}

function failingFetch(error: unknown): typeof globalThis.fetch {
  return (() => Promise.reject(error)) as unknown as typeof globalThis.fetch
}

const baseConfig = { apiKey: 'sk-test', baseURL: 'https://example.test' }
const baseRequest = {
  model: 'test-model',
  input: [
    {
      type: 'message' as const,
      role: 'user' as const,
      content: [{ type: 'input_text' as const, text: 'hi' }],
    },
  ],
}

async function expectError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}

test('web_search_20250305 server tool maps to built-in web_search (not legacy web_search_preview)', () => {
  const request = convertAnthropicRequestToResponses({
    model: 'deepseek-v4-flash',
    messages: [],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        allowed_domains: ['example.com', 'docs.example.com'],
        blocked_domains: ['spam.example.com'],
        max_uses: 3,
      } as unknown as BetaToolUnion,
    ],
  })
  expect(request.tools).toEqual([
    {
      type: 'web_search',
      search_context_size: 'medium',
      filters: { allowed_domains: ['example.com', 'docs.example.com'] },
    },
  ])
})

test('tool_choice for the web_search server tool selects the built-in web_search tool', () => {
  const request = convertAnthropicRequestToResponses({
    model: 'deepseek-v4-flash',
    messages: [],
    tools: [
      { type: 'web_search_20250305', name: 'web_search' } as unknown as BetaToolUnion,
    ],
    tool_choice: { type: 'tool', name: 'web_search' },
  })
  expect(request.tool_choice).toEqual({ type: 'web_search' })
})

test('custom tools still map to function tools', () => {
  const request = convertAnthropicRequestToResponses({
    model: 'deepseek-v4-flash',
    messages: [],
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: {} },
      } as unknown as BetaToolUnion,
    ],
  })
  expect(request.tools).toEqual([
    {
      type: 'function',
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: {} },
      strict: false,
    },
  ])
})

test('max_tokens is clamped to 32000 for deepseek base URLs', () => {
  const previous = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com'
  try {
    const request = convertAnthropicRequestToResponses({
      model: 'deepseek-v4-flash',
      messages: [],
      max_tokens: 64000,
    })
    expect(request.max_output_tokens).toBe(32000)
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = previous
  }
})

test('429 → APIError with native 429 status (retryable + rate-limit semantics)', async () => {
  const error = await expectError(
    createResponsesCompatStream(
      { ...baseConfig, fetch: stubFetch(new Response('{"error":{"message":"slow down"}}', { status: 429 })) },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(429)
})

test('500 → APIError with native 500 status', async () => {
  const error = await expectError(
    createResponsesCompatStream(
      { ...baseConfig, fetch: stubFetch(new Response('oops', { status: 500 })) },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(500)
})

test('gateway 400 "Upstream request failed" wrapper → retryable APIError normalized to 503', async () => {
  const error = await expectError(
    createResponsesCompatStream(
      { ...baseConfig, fetch: stubFetch(new Response(GATEWAY_UPSTREAM_400, { status: 400 })) },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(APIError)
  expect((error as APIError).status).toBe(503)
  expect((error as Error).message).toContain('status 400')
})

test('genuine 400 validation error preserves its non-retryable API status', async () => {
  const error = await expectError(
    createResponsesCompatStream(
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

test('context overflow 400 still throws "Prompt is too long" plain Error (PTL detection)', async () => {
  const error = await expectError(
    createResponsesCompatStream(
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
    createResponsesCompatStream(
      { ...baseConfig, fetch: failingFetch(new TypeError('fetch failed')) },
      baseRequest,
    ),
  )
  expect(error).toBeInstanceOf(APIConnectionError)
})

test('pre-aborted signal returns user cancellation instead of APIConnectionError', async () => {
  const controller = new AbortController()
  controller.abort()
  const abortError = new DOMException('The operation was aborted.', 'AbortError')
  const error = await expectError(
    createResponsesCompatStream(
      { ...baseConfig, fetch: failingFetch(abortError) },
      baseRequest,
      controller.signal,
    ),
  )
  expect(error).toBeInstanceOf(APIUserAbortError)
})

function streamFromText(sseText: string): ReadableStreamDefaultReader<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseText))
      controller.close()
    },
  })
  return stream.getReader()
}

test('web_search_call + url citations synthesize server_tool_use and web_search_tool_result blocks', async () => {
  const sse = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"in_progress"}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","query":"deepseek news"}}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Here is what I found."}\n\n',
    'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.com/a","title":"Article A"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
  ].join('')

  const events: Array<Record<string, unknown>> = []
  const stream = createAnthropicStreamFromResponses({
    reader: streamFromText(sse),
    model: 'deepseek-v4-flash',
  })
  while (true) {
    const { done, value } = await stream.next()
    if (done) break
    events.push(value as unknown as Record<string, unknown>)
  }

  const serverToolStart = events.find(
    event =>
      event.type === 'content_block_start' &&
      (event.content_block as Record<string, unknown>).type === 'server_tool_use',
  )
  expect(serverToolStart).toBeDefined()
  expect((serverToolStart!.content_block as Record<string, unknown>).name).toBe('web_search')

  const searchInputDelta = events.find(
    event =>
      event.type === 'content_block_delta' &&
      (event.delta as Record<string, unknown>).type === 'input_json_delta',
  )
  expect(searchInputDelta).toBeDefined()
  expect(
    (searchInputDelta!.delta as Record<string, unknown>).partial_json,
  ).toBe(JSON.stringify({ query: 'deepseek news' }))

  const searchResult = events.find(
    event =>
      event.type === 'content_block_start' &&
      (event.content_block as Record<string, unknown>).type === 'web_search_tool_result',
  )
  expect(searchResult).toBeDefined()
  const results = (searchResult!.content_block as Record<string, unknown>)
    .content as Array<Record<string, unknown>>
  expect(results).toHaveLength(1)
  expect(results[0].url).toBe('https://example.com/a')

  expect(events[0].type).toBe('message_start')
  expect(events[events.length - 1].type).toBe('message_stop')
})

test('input_tokens_details cache fields map into anthropic usage (cached subset of input_tokens)', async () => {
  const sse = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":1500,"output_tokens":5,"input_tokens_details":{"cached_tokens":1200,"cache_write_tokens":100}}}}\n\n',
  ].join('')

  const events: Array<Record<string, unknown>> = []
  const stream = createAnthropicStreamFromResponses({
    reader: streamFromText(sse),
    model: 'gpt-5.1',
  })
  let finalMessage: Record<string, unknown> | undefined
  while (true) {
    const { done, value } = await stream.next()
    if (done) {
      finalMessage = value as unknown as Record<string, unknown>
      break
    }
    events.push(value as unknown as Record<string, unknown>)
  }

  const delta = events.find(e => e.type === 'message_delta') as
    | { usage?: Record<string, unknown> }
    | undefined
  expect(delta?.usage?.input_tokens).toBe(200)
  expect(delta?.usage?.cache_read_input_tokens).toBe(1200)
  expect(delta?.usage?.cache_creation_input_tokens).toBe(100)
  // Input-side total stays equal to the vendor's input_tokens
  const total =
    Number(delta?.usage?.input_tokens) +
    Number(delta?.usage?.cache_read_input_tokens) +
    Number(delta?.usage?.cache_creation_input_tokens)
  expect(total).toBe(1500)

  const finalUsage = (finalMessage as { usage?: Record<string, unknown> })?.usage
  expect(finalUsage?.input_tokens).toBe(200)
  expect(finalUsage?.cache_read_input_tokens).toBe(1200)
  expect(finalUsage?.cache_creation_input_tokens).toBe(100)
})

async function collectStreamEvents(
  sse: string,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  const stream = createAnthropicStreamFromResponses({
    reader: streamFromText(sse),
    model: 'deepseek-v4-flash',
  })
  while (true) {
    const { done, value } = await stream.next()
    if (done) break
    events.push(value as unknown as Record<string, unknown>)
  }
  return events
}

function searchResultBlocks(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return events
    .filter(
      event =>
        event.type === 'content_block_start' &&
        (event.content_block as Record<string, unknown>).type ===
          'web_search_tool_result',
    )
    .map(event => event.content_block as Record<string, unknown>)
}

test('output_config.effort maps to reasoning.effort (top-level effort is not in the Responses spec)', () => {
  const request = convertAnthropicRequestToResponses({
    model: 'deepseek-v4-flash',
    messages: [],
    output_config: { effort: 'medium' },
  })
  expect(request.reasoning).toEqual({ effort: 'medium' })
  expect('effort' in request).toBe(false)
})

test('effort passes through unchanged (providers map levels themselves)', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const request = convertAnthropicRequestToResponses({
      model: 'deepseek-v4-flash',
      messages: [],
      output_config: { effort },
    })
    expect(request.reasoning).toEqual({ effort })
  }
})

test('citations attached to the finished message item are collected (DeepSeek streams no annotation events)', async () => {
  const sse = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"in_progress"}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","query":"deepseek news"}}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"According to the news..."}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"According to the news...","annotations":[{"type":"url_citation","url":"https://example.com/x","title":"Article X"}]}]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
  ].join('')

  const blocks = searchResultBlocks(await collectStreamEvents(sse))
  expect(blocks).toHaveLength(1)
  const content = blocks[0].content as Array<Record<string, unknown>>
  expect(content).toHaveLength(1)
  expect(content[0].url).toBe('https://example.com/x')
})

test('citations only present in the final response object are collected', async () => {
  const sse = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Done."}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5},"output":[{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","query":"q","sources":[{"url":"https://example.com/s","title":"S"},"https://example.com/s2"]}},{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"Done.","annotations":[{"type":"url_citation","url":"https://example.com/s","title":"S"}]}]}]}}\n\n',
  ].join('')

  const blocks = searchResultBlocks(await collectStreamEvents(sse))
  expect(blocks).toHaveLength(1)
  expect(blocks[0].tool_use_id).toBe('ws_1')
  const urls = (blocks[0].content as Array<Record<string, unknown>>).map(
    hit => hit.url,
  )
  // action.sources + message annotations merged, deduped by url
  expect(urls).toEqual(['https://example.com/s', 'https://example.com/s2'])
})

test('one web_search_tool_result block per search call even with zero citations (Did-N-searches count)', async () => {
  const sse = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"ws_1","type":"web_search_call","status":"in_progress"}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","query":"q1"}}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"ws_2","type":"web_search_call","status":"in_progress"}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"ws_2","type":"web_search_call","status":"completed","action":{"type":"search","query":"q2"}}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Summary without citations."}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
  ].join('')

  const blocks = searchResultBlocks(await collectStreamEvents(sse))
  expect(blocks).toHaveLength(2)
  expect(blocks[0].tool_use_id).toBe('ws_1')
  expect(blocks[1].tool_use_id).toBe('ws_2')
  expect(blocks[0].content).toEqual([])
  expect(blocks[1].content).toEqual([])
})

// --- Multimodal image conversion (vision through the Responses API) ---

const IMAGE_B64 = 'aGVsbG8gd29ybGQ='

test('tool_result with image → function_call_output stays textual, image rides a follow-up user message as input_image', () => {
  const request = convertAnthropicRequestToResponses({
    model: 'test-model',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: IMAGE_B64 },
              },
            ],
          },
        ],
      } as unknown as BetaMessageParam,
    ],
  })

  const outputItem = request.input.find(i => i.type === 'function_call_output')
  expect(outputItem).toBeDefined()
  expect((outputItem as { output: string }).output).not.toContain(IMAGE_B64)
  expect((outputItem as { output: string }).output).not.toContain('"type":"image"')

  const imageMessage = request.input.find(
    i =>
      i.type === 'message' &&
      i.role === 'user' &&
      Array.isArray(i.content) &&
      i.content.some((part: { type: string }) => part.type === 'input_image'),
  ) as { content: Array<Record<string, unknown>> }
  expect(imageMessage).toBeDefined()
  const imagePart = imageMessage.content.find(p => p.type === 'input_image')
  expect(imagePart).toEqual({
    type: 'input_image',
    image_url: `data:image/png;base64,${IMAGE_B64}`,
  })
})

test('user message with text + image blocks → content array (input_text + input_image)', () => {
  const request = convertAnthropicRequestToResponses({
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

  const userMessage = request.input.find(
    i => i.type === 'message' && i.role === 'user',
  ) as { content: Array<Record<string, unknown>> }
  expect(userMessage.content[0]).toEqual({
    type: 'input_text',
    text: 'what is in this picture?',
  })
  expect(userMessage.content[1]).toEqual({
    type: 'input_image',
    image_url: `data:image/png;base64,${IMAGE_B64}`,
  })
})

test('url-sourced image block passes the URL through as input_image', () => {
  const request = convertAnthropicRequestToResponses({
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

  const userMessage = request.input.find(
    i => i.type === 'message' && i.role === 'user',
  ) as { content: Array<Record<string, unknown>> }
  expect(userMessage.content).toEqual([
    { type: 'input_image', image_url: 'https://example.test/cat.png' },
  ])
})

test('plain text request shape is unchanged (string tool output, single input_text)', () => {
  const request = convertAnthropicRequestToResponses({
    model: 'test-model',
    messages: [
      { role: 'user', content: 'plain question' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_02', content: 'plain result' },
        ],
      } as unknown as BetaMessageParam,
    ],
  })

  const outputItem = request.input.find(i => i.type === 'function_call_output')
  expect((outputItem as { output: string }).output).toBe('plain result')
  const userMessages = request.input.filter(
    i => i.type === 'message' && i.role === 'user',
  )
  expect(userMessages).toHaveLength(1)
  expect((userMessages[0] as { content: unknown[] }).content).toEqual([
    { type: 'input_text', text: 'plain question' },
  ])
})

// --- Tool-result image follow-up ordering (strict function_call pairing) ---

// Strict gateways require a run of function_call items to be answered by an
// equal, contiguous run of function_call_output items. Image follow-up message
// items must therefore come only after the whole tool run.
function expectContiguousFunctionCallOutputs(
  items: ReadonlyArray<{ type?: string; call_id?: string }>,
): void {
  let i = 0
  while (i < items.length) {
    if (items[i].type !== 'function_call') {
      i++
      continue
    }
    const callIds: string[] = []
    while (i < items.length && items[i].type === 'function_call') {
      callIds.push(items[i].call_id ?? '')
      i++
    }
    const outputIds: string[] = []
    while (i < items.length && items[i].type === 'function_call_output') {
      outputIds.push(items[i].call_id ?? '')
      i++
    }
    expect(outputIds).toEqual(callIds)
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

const userImageItems = (items: Array<{ type?: string; role?: string; content?: unknown }>) =>
  items.filter(
    item =>
      item.type === 'message' &&
      item.role === 'user' &&
      Array.isArray(item.content) &&
      (item.content as Array<{ type?: string }>).some(part => part.type === 'input_image'),
  )

test('single function call with image output → function_call_output then image user item (pairing invariant held)', () => {
  const request = convertAnthropicRequestToResponses({
    model: 'test-model',
    messages: [
      { role: 'assistant', content: [readToolUse('toolu_a')] },
      { role: 'user', content: [pngToolResult('toolu_a')] },
    ] as unknown as BetaMessageParam[],
  })

  expect(request.input.map(item => item.type)).toEqual([
    'function_call',
    'function_call_output',
    'message',
  ])
  const imageItems = userImageItems(request.input)
  expect(imageItems).toHaveLength(1)
  expect(
    (imageItems[0] as { content: Array<Record<string, unknown>> }).content,
  ).toEqual([
    { type: 'input_text', text: '[Images returned by tool call toolu_a]' },
    { type: 'input_image', image_url: `data:image/png;base64,${IMAGE_B64}` },
  ])
  expectContiguousFunctionCallOutputs(request.input)
})

test('parallel function calls where only the first output has an image → outputs stay contiguous (regression: 914e9923 400)', () => {
  const request = convertAnthropicRequestToResponses({
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

  expect(request.input.map(item => item.type)).toEqual([
    'function_call',
    'function_call',
    'function_call_output',
    'function_call_output',
    'message',
    'message',
  ])
  expect(
    request.input
      .filter(item => item.type === 'function_call_output')
      .map(item => (item as { call_id: string }).call_id),
  ).toEqual(['toolu_img', 'toolu_txt'])
  expect(userImageItems(request.input)).toHaveLength(1)
  expectContiguousFunctionCallOutputs(request.input)
})

test('parallel function calls both returning images → one user message carries both images after the tool run', () => {
  // Design contract (not an implementation coincidence): all images of one
  // tool run merge into a single user message item, so N image-bearing tools
  // still yield exactly one follow-up item.
  const request = convertAnthropicRequestToResponses({
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

  expect(request.input.map(item => item.type)).toEqual([
    'function_call',
    'function_call',
    'function_call_output',
    'function_call_output',
    'message',
    'message',
  ])
  const imageItems = userImageItems(request.input)
  expect(imageItems).toHaveLength(1)
  expect(
    (imageItems[0] as { content: Array<Record<string, unknown>> }).content.filter(
      part => part.type === 'input_image',
    ),
  ).toHaveLength(2)
  expectContiguousFunctionCallOutputs(request.input)
})

test('mixed text + image tool results stay ordered before a following user message', () => {
  const request = convertAnthropicRequestToResponses({
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

  expect(request.input.map(item => item.type)).toEqual([
    'function_call',
    'function_call',
    'function_call_output',
    'function_call_output',
    'message',
    'message',
  ])
  expect(
    (request.input[2] as { output: string }).output,
  ).toBe('screenshot taken')
  expect((request.input[3] as { output: string }).output).toBe('plain output')
  expect(userImageItems(request.input)).toHaveLength(1)
  const trailing = request.input[5] as {
    role: string
    content: Array<Record<string, unknown>>
  }
  expect(trailing.role).toBe('user')
  expect(trailing.content).toEqual([{ type: 'input_text', text: 'continue' }])
  expectContiguousFunctionCallOutputs(request.input)
})

test('tool_results split over consecutive user messages stay contiguous and flush images once', () => {
  // Same merge contract across consecutive user messages: the two runs'
  // tool_results belong to one tool round, so their images share one message.
  const request = convertAnthropicRequestToResponses({
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

  expect(request.input.map(item => item.type)).toEqual([
    'function_call',
    'function_call',
    'function_call_output',
    'function_call_output',
    'message',
    'message',
  ])
  const imageItems = userImageItems(request.input)
  expect(imageItems).toHaveLength(1)
  expect(
    (imageItems[0] as { content: Array<Record<string, unknown>> }).content.filter(
      part => part.type === 'input_image',
    ),
  ).toHaveLength(2)
  const trailing = request.input[5] as {
    role: string
    content: Array<Record<string, unknown>>
  }
  expect(trailing.role).toBe('user')
  expect(trailing.content).toEqual([{ type: 'input_text', text: 'continue' }])
  expectContiguousFunctionCallOutputs(request.input)
})

test('plain text function call outputs keep the pre-fix shape (no image follow-up items)', () => {
  const request = convertAnthropicRequestToResponses({
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

  expect(request.input.map(item => item.type)).toEqual([
    'function_call',
    'function_call',
    'function_call_output',
    'function_call_output',
    'message',
  ])
  expect(userImageItems(request.input)).toHaveLength(0)
  expect(
    request.input
      .filter(item => item.type === 'function_call_output')
      .map(item => (item as { output: string }).output),
  ).toEqual(['first', 'second'])
  expectContiguousFunctionCallOutputs(request.input)
})

// --- Tool run boundaries (pending image queue must not leak across runs) ---

test('two independent image tool rounds stay isolated (one merged image item per run)', () => {
  const request = convertAnthropicRequestToResponses({
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

  expect(request.input.map(item => item.type)).toEqual([
    'function_call',
    'function_call',
    'function_call_output',
    'function_call_output',
    'message',
    'function_call',
    'function_call',
    'function_call_output',
    'function_call_output',
    'message',
    'message',
  ])
  const imageItems = userImageItems(request.input)
  expect(imageItems).toHaveLength(2)
  const labelsOf = (item: (typeof imageItems)[number]) =>
    (item.content as Array<Record<string, unknown>>)
      .filter(part => part.type === 'input_text')
      .map(part => part.text)
  expect(labelsOf(imageItems[0])).toEqual([
    '[Images returned by tool call toolu_r1a]',
    '[Images returned by tool call toolu_r1b]',
  ])
  expect(labelsOf(imageItems[1])).toEqual([
    '[Images returned by tool call toolu_r2a]',
    '[Images returned by tool call toolu_r2b]',
  ])
  // 第二轮图片不得混进第一轮消息（pending 队列必须在 assistant 边界清空）。
  expect(JSON.stringify(imageItems[0])).not.toContain('toolu_r2')
  expect(JSON.stringify(imageItems[1])).not.toContain('toolu_r1')
  expectContiguousFunctionCallOutputs(request.input)
})

test('user message with tool_result image + text + direct image keeps both images', () => {
  const directImage = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: IMAGE_B64 },
  }
  const request = convertAnthropicRequestToResponses({
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

  expect(request.input.map(item => item.type)).toEqual([
    'function_call',
    'function_call_output',
    'message',
    'message',
  ])
  // 工具图片先 flush，随后才是同一 user 消息的文本 + 直接图片内容。
  expect(
    (request.input[2] as { content: Array<Record<string, unknown>> }).content,
  ).toEqual([
    { type: 'input_text', text: '[Images returned by tool call toolu_mix]' },
    { type: 'input_image', image_url: `data:image/png;base64,${IMAGE_B64}` },
  ])
  expect(
    (request.input[3] as { content: Array<Record<string, unknown>> }).content,
  ).toEqual([
    { type: 'input_text', text: 'and this one too' },
    { type: 'input_image', image_url: `data:image/png;base64,${IMAGE_B64}` },
  ])
  const totalImages = request.input.reduce(
    (count, item) =>
      count +
      (item.type === 'message'
        ? (item.content as Array<Record<string, unknown>>).filter(
            part => part.type === 'input_image',
          ).length
        : 0),
    0,
  )
  expect(totalImages).toBe(2)
  expectContiguousFunctionCallOutputs(request.input)
})

test('request ending with a multi-image tool round flushes one merged user image item', () => {
  const request = convertAnthropicRequestToResponses({
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

  expect(request.input.map(item => item.type)).toEqual([
    'function_call',
    'function_call',
    'function_call_output',
    'function_call_output',
    'message',
  ])
  const lastContent = (
    request.input[4] as { content: Array<Record<string, unknown>> }
  ).content
  expect(lastContent.filter(part => part.type === 'input_image')).toHaveLength(2)
  expect(lastContent.filter(part => part.type === 'input_text')).toHaveLength(2)
  expectContiguousFunctionCallOutputs(request.input)
})

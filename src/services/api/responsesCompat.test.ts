import { test, expect } from 'bun:test'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
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

test('genuine 400 validation error stays a non-retryable plain Error', async () => {
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
  expect(error).not.toBeInstanceOf(APIError)
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

test('aborted signal rethrows the original abort error instead of APIConnectionError', async () => {
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
  expect(error).toBe(abortError)
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

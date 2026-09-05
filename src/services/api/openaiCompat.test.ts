import { test, expect } from 'bun:test'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { convertAnthropicRequestToOpenAI, createOpenAICompatStream } from './openaiCompat.js'

const GATEWAY_UPSTREAM_400 =
  '{"error":{"message":"Error from provider (Console Go): Upstream request failed","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'

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

test('genuine 400 validation error stays a non-retryable plain Error', async () => {
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
  expect(error).not.toBeInstanceOf(APIError)
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

test('aborted signal rethrows the original abort error instead of APIConnectionError', async () => {
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
  expect(error).toBe(abortError)
})

test('200 with body returns a stream reader', async () => {
  const reader = await createOpenAICompatStream(
    { ...baseConfig, fetch: stubFetch(new Response('data: [DONE]\n\n', { status: 200 })) },
    baseRequest,
  )
  expect(typeof reader.read).toBe('function')
  await reader.cancel()
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

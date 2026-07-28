import { test, expect } from 'bun:test'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { createOpenAICompatStream } from './openaiCompat.js'

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

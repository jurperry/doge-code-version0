import { test, expect } from 'bun:test'
import { APIConnectionError, APIUserAbortError } from '@anthropic-ai/sdk'

// These exercise the fetch boundary, including raw heartbeat bytes that the
// Anthropic SDK intentionally drops before exposing stream events.
const load = () => import('./requestLifecycle.js')

test('headers that never arrive time out and abort the underlying fetch', async () => {
  const { requestFetch } = await load()
  let aborted = false
  const inner = ((_url, init) => {
    init.signal.addEventListener('abort', () => { aborted = true })
    return new Promise(() => {})
  }) as typeof fetch
  await expect(requestFetch(inner, 'http://test', {}, { headerMs: 15, idleMs: 15 })).rejects.toBeInstanceOf(APIConnectionError)
  expect(aborted).toBe(true)
})

test('silent body times out and cancels the reader', async () => {
  const { requestFetch } = await load()
  let canceled = false
  const response = new Response(new ReadableStream({ cancel() { canceled = true } }))
  const result = await requestFetch((async () => response) as typeof fetch, 'http://test', {}, { headerMs: 15, idleMs: 15 })
  await expect(result.text()).rejects.toBeInstanceOf(APIConnectionError)
  expect(canceled).toBe(true)
})

test('heartbeat bytes keep a stream alive until the real payload', async () => {
  const { requestFetch } = await load()
  const body = new ReadableStream({ async start(controller) {
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(8)
      controller.enqueue(new TextEncoder().encode(': ping\n\n'))
    }
    controller.close()
  } })
  const result = await requestFetch((async () => new Response(body)) as typeof fetch, 'http://test', {}, { headerMs: 15, idleMs: 25 })
  expect(await result.text()).toContain(': ping')
})

test('user cancellation interrupts a silent body immediately', async () => {
  const { requestFetch } = await load()
  const controller = new AbortController()
  const result = await requestFetch((async () => new Response(new ReadableStream())) as typeof fetch, 'http://test', { signal: controller.signal }, { headerMs: 1000, idleMs: 1000 })
  const reading = result.text()
  controller.abort()
  await expect(reading).rejects.toBeInstanceOf(APIUserAbortError)
})

test('Bun model POSTs close connections to prevent transparent transport replay', async () => {
  const { requestFetch } = await load()
  let options: RequestInit | undefined
  await requestFetch((async (_input, init) => { options = init; return new Response(null) }) as typeof fetch, 'http://test', { method: 'POST' })
  expect(new Headers(options?.headers).get('connection')).toBe('close')
  expect(options?.keepalive).toBe(false)
})

test('invalid API endpoints fail before fetch and remain configuration errors', async () => {
  const { requestFetch } = await load()
  let requests = 0
  const inner = (async () => { requests++; return new Response(null) }) as typeof fetch
  for (const endpoint of ['not-a-url', 'file:///tmp/model', 'ftp://test']) {
    try { await requestFetch(inner, endpoint); throw new Error('expected configuration failure') }
    catch (error) { expect(error).not.toBeInstanceOf(APIConnectionError) }
  }
  expect(requests).toBe(0)
})

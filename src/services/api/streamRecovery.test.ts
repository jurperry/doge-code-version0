import { test, expect } from 'bun:test'
import { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { withRetry, RetryBudget, CannotRetryError } from './withRetry.js'
import type { BetaRawMessageStreamEvent as Event } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of generator) values.push(value)
  return values
}

function acquire(operation: (continuation?: boolean) => Promise<AsyncIterable<Event> | undefined>, budget: RetryBudget, signal = new AbortController().signal) {
  return (initialError?: unknown, discardPartial?: boolean, continuation?: boolean) => withRetry(
    async () => ({} as any), async () => operation(continuation),
    { model: 'test', thinkingConfig: { type: 'disabled' }, signal, retryBudget: budget, initialError, discardPartial },
  )
}

test('acquisition and repeated midstream failure share one budget and stop at ten retries', async () => {
  const { recoverStream } = await import('./streamRecovery.js')
  const previous = process.env.DOGE_NETWORK_RETRY_BASE_MS
  process.env.DOGE_NETWORK_RETRY_BASE_MS = '10'
  let requests = 0
  const budget = new RetryBudget(10)
  const stream = recoverStream(acquire(async () => {
    requests++
    if (requests === 1) throw new APIConnectionError({ message: 'connect failed' })
    return (async function* () { yield { type: 'message_start' } as Event })()
  }, budget))
  const retries: any[] = []
  try {
    for await (const event of stream) if (event.type === 'system') retries.push(event)
    throw new Error('expected exhaustion')
  } catch (error) {
    expect(error).toBeInstanceOf(CannotRetryError)
  } finally {
    if (previous === undefined) delete process.env.DOGE_NETWORK_RETRY_BASE_MS
    else process.env.DOGE_NETWORK_RETRY_BASE_MS = previous
  }
  expect(requests).toBe(11)
  expect(retries.map(r => r.retryAttempt)).toEqual([1,2,3,4,5,6,7,8,9,10])
}, 30_000)

test('half response reconnects and terminal event finishes without waiting for open connection', async () => {
  const { recoverStream } = await import('./streamRecovery.js')
  let requests = 0
  let released = 0
  const values = await collect(recoverStream(acquire(async () => {
    requests++
    return (async function* () {
      try {
        yield { type: 'message_start' } as Event
        if (requests === 1) return
        yield { type: 'message_stop' } as Event
        await new Promise(() => {})
      } finally { released++ }
    })()
  }, new RetryBudget(2))))
  expect(requests).toBe(2)
  expect(released).toBe(2)
  expect(values.some((v: any) => v.discardPartial === true)).toBe(true)
})

test('completed tool block uses continuation without replaying original request', async () => {
  const { recoverStream } = await import('./streamRecovery.js')
  let requests = 0
  const budget = new RetryBudget(2)
  const values = await collect(recoverStream(acquire(async continuation => {
    if (continuation) return undefined
    requests++
    return (async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'one', name: 'Write', input: {} } } as Event
      yield { type: 'content_block_stop', index: 0 } as Event
      throw new APIConnectionError({ message: 'reset' })
    })()
  }, budget)))
  expect(requests).toBe(1)
  expect(budget.retriesUsed).toBe(1)
  expect(values.some((v: any) => v.type === 'message_delta' && v.delta.stop_reason === 'tool_use')).toBe(true)
  expect(values.some((v: any) => v.type === 'system' && v.discardPartial === false)).toBe(true)
})

test('parameter and authentication failures are terminal without reconnect status', async () => {
  const { recoverStream } = await import('./streamRecovery.js')
  for (const status of [400, 401, 403]) {
    let requests = 0
    const budget = new RetryBudget(10)
    await expect(collect(recoverStream(acquire(async () => {
      requests++
      throw new APIError(status, undefined, 'bad configuration', new Headers())
    }, budget)))).rejects.toBeInstanceOf(CannotRetryError)
    expect(requests).toBe(1)
    expect(budget.retriesUsed).toBe(0)
  }
})

test('cancellation during retry delay produces no later request', async () => {
  const { recoverStream } = await import('./streamRecovery.js')
  const controller = new AbortController()
  let requests = 0
  const stream = recoverStream(acquire(async () => {
    requests++
    throw new APIConnectionError({ message: 'reset' })
  }, new RetryBudget(), controller.signal))
  const retry = await stream.next()
  expect((retry.value as any).retryAttempt).toBe(1)
  controller.abort()
  await expect(stream.next()).rejects.toBeInstanceOf(APIUserAbortError)
  expect(requests).toBe(1)
})

test('exhausted tool continuation cannot issue another initial request through query loop', async () => {
  const { recoverStream } = await import('./streamRecovery.js')
  const budget = new RetryBudget(0)
  let requests = 0
  const get = acquire(async () => {
    requests++
    return (async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'one', name: 'Bash', input: {} } } as Event
      yield { type: 'content_block_stop', index: 0 } as Event
      throw new APIConnectionError({ message: 'reset' })
    })()
  }, budget)
  await expect(collect(recoverStream(get))).rejects.toBeInstanceOf(CannotRetryError)
  await expect(collect(recoverStream(get))).rejects.toBeInstanceOf(CannotRetryError)
  expect(requests).toBe(1)
})

test('tool continuation preserves authoritative output usage instead of replacing it with zero', async () => {
  const { recoverStream } = await import('./streamRecovery.js')
  const values = await collect(recoverStream(acquire(async continuation => {
    if (continuation) return undefined
    return (async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'one', name: 'Bash', input: {} } } as Event
      yield { type: 'content_block_stop', index: 0 } as Event
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 27 } } as Event
    })()
  }, new RetryBudget(1))))
  let outputTokens = 0
  for (const event of values as Event[]) if (event.type === 'message_delta' && event.usage.output_tokens !== undefined) outputTokens = event.usage.output_tokens
  expect(outputTokens).toBe(27)
})

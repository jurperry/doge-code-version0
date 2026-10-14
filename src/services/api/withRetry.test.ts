import { test, expect, beforeEach, afterEach } from 'bun:test'
import { getDefaultMaxRetries, getRetryDelay, withRetry, RetryBudget, CannotRetryError, retryBudgetClass, retryErrorClass, retryErrorKind } from './withRetry.js'
import { APIConnectionError, APIConnectionTimeoutError, APIError } from '@anthropic-ai/sdk'

test('request timeout is distinct from a connection failure', () => {
  expect(retryErrorKind(new APIConnectionTimeoutError())).toBe('timeout')
  expect(retryErrorKind(new APIConnectionError({ message: 'reset' }))).toBe('connection')
  expect(retryErrorKind(new APIError(408, undefined, 'timeout', new Headers()))).toBe('timeout')
  expect(retryErrorKind(new APIError(503, undefined, 'unavailable', new Headers()))).toBe('server')
})

const KEY = 'CLAUDE_CODE_MAX_RETRIES'
const saved = process.env[KEY]
const savedApiKey = process.env.DOGE_API_KEY

beforeEach(() => {
  delete process.env[KEY]
  process.env.DOGE_API_KEY = 'sk-retry-test'
})

afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
  if (savedApiKey === undefined) delete process.env.DOGE_API_KEY
  else process.env.DOGE_API_KEY = savedApiKey
})

test('getDefaultMaxRetries: unset → default 10', () => {
  expect(getDefaultMaxRetries()).toBe(10)
})

test('getDefaultMaxRetries: valid integer is honored', () => {
  process.env[KEY] = '3'
  expect(getDefaultMaxRetries()).toBe(3)
})

test('getDefaultMaxRetries: non-numeric value falls back to default instead of NaN', () => {
  process.env[KEY] = 'abc'
  const result = getDefaultMaxRetries()
  expect(Number.isFinite(result)).toBe(true)
  expect(result).toBe(10)
})

test('getDefaultMaxRetries: negative value falls back to default', () => {
  process.env[KEY] = '-1'
  expect(getDefaultMaxRetries()).toBe(10)
})

test('retry configuration cannot exceed ten reconnection rounds', () => {
  process.env[KEY] = '100'
  expect(getDefaultMaxRetries()).toBe(10)
})

test('retry configuration rejects fractional and partially parsed numbers', () => {
  for (const value of ['1.5', '2garbage', 'Infinity']) {
    process.env[KEY] = value
    expect(getDefaultMaxRetries()).toBe(10)
  }
})

test('retry-after cannot create negative or unbounded backoff', () => {
  expect(getRetryDelay(1, '-20')).toBeGreaterThanOrEqual(0)
  expect(getRetryDelay(1, '999999')).toBeLessThanOrEqual(32_000)
})

test('model fallback cannot reserve an eleventh reconnect after budget exhaustion', async () => {
  const previous = process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS
  process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = '1'
  const budget = new RetryBudget(2)
  let requests = 0
  let error: unknown
  try {
    for await (const event of withRetry(async () => ({} as any), async () => {
      requests++
      throw new APIError(529, undefined, 'overloaded', new Headers({ 'retry-after': '0' }))
    }, { model: 'test', fallbackModel: 'fallback', thinkingConfig: { type: 'disabled' }, retryBudget: budget })) {}
  } catch (caught) { error = caught }
  finally {
    if (previous === undefined) delete process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS
    else process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS = previous
  }
  expect(error).toBeInstanceOf(CannotRetryError)
  expect(requests).toBe(3)
})

// ---- 双类预算（0.2.128 修正版）：网络与服务类（断连/超时/5xx/529）10 轮、
//      其余（429/409/瞬态上游 4xx）5 轮 ---------------------------------------

const THINKING = { type: 'disabled' as const }
const NO_DELAY = new Headers({ 'retry-after': '0' })

test('transport class: connection-level errors are network, the rest are api', () => {
  expect(retryErrorClass(new APIConnectionError({ message: 'fetch failed' }))).toBe('network')
  expect(retryErrorClass(new APIError(408, undefined, 'timeout', NO_DELAY))).toBe('network')
  expect(retryErrorClass(new APIError(429, undefined, 'rate limited', NO_DELAY))).toBe('api')
  expect(retryErrorClass(new APIError(500, undefined, 'server', NO_DELAY))).toBe('api')
})

test('budget class: network and server errors are infra (10), the rest are other (5)', () => {
  expect(retryBudgetClass(new APIConnectionError({ message: 'fetch failed' }))).toBe('infra')
  expect(retryBudgetClass(new APIError(408, undefined, 'timeout', NO_DELAY))).toBe('infra')
  expect(retryBudgetClass(new APIError(500, undefined, 'server error', NO_DELAY))).toBe('infra')
  expect(retryBudgetClass(new APIError(503, undefined, 'unavailable', NO_DELAY))).toBe('infra')
  expect(retryBudgetClass(new APIError(529, undefined, '"type":"overloaded_error"', NO_DELAY))).toBe('infra')
  expect(retryBudgetClass(new APIError(429, undefined, 'rate limited', NO_DELAY))).toBe('other')
  expect(retryBudgetClass(new APIError(409, undefined, 'lock timeout', NO_DELAY))).toBe('other')
})

test('RetryBudget splits infra (10) and other (5) caps', () => {
  const budget = new RetryBudget()
  expect(budget.maxRetries).toBe(10)
  expect(budget.otherMaxRetries).toBe(5)
  for (let i = 0; i < 5; i++) expect(budget.consumeClass('other')).toBe(true)
  expect(budget.consumeClass('other')).toBe(false)
  expect(budget.exhaustedFor('other')).toBe(true)
  expect(budget.exhaustedFor('infra')).toBe(false)
})

test('server 5xx keeps the full ten rounds with x/10 in yields', async () => {
  const savedBase = process.env.DOGE_NETWORK_RETRY_BASE_MS
  process.env.DOGE_NETWORK_RETRY_BASE_MS = '10'
  let requests = 0
  const events: Array<{ retryAttempt: number; maxRetries: number }> = []
  let error: unknown
  try {
    for await (const event of withRetry(async () => ({} as any), async () => {
      requests++
      throw new APIError(503, undefined, 'service unavailable', NO_DELAY)
    }, { model: 'test', thinkingConfig: THINKING })) {
      events.push({ retryAttempt: event.retryAttempt, maxRetries: event.maxRetries })
    }
  } catch (caught) { error = caught }
  finally {
    if (savedBase === undefined) delete process.env.DOGE_NETWORK_RETRY_BASE_MS
    else process.env.DOGE_NETWORK_RETRY_BASE_MS = savedBase
  }
  expect(error).toBeInstanceOf(CannotRetryError)
  expect(requests).toBe(11)
  expect(events.map(e => e.maxRetries)).toEqual(Array.from({ length: 10 }, () => 10))
  expect(events.at(-1)?.retryAttempt).toBe(10)
}, 30_000)

test('server 429 exhausts at five retries and reports x/5 in yields', async () => {
  let requests = 0
  const events: Array<{ retryAttempt: number; maxRetries: number }> = []
  let error: unknown
  try {
    for await (const event of withRetry(async () => ({} as any), async () => {
      requests++
      throw new APIError(429, undefined, 'rate limit: resets in 5h', NO_DELAY)
    }, { model: 'test', thinkingConfig: THINKING })) {
      events.push({ retryAttempt: event.retryAttempt, maxRetries: event.maxRetries })
    }
  } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(CannotRetryError)
  expect(requests).toBe(6)
  expect(events).toEqual([
    { retryAttempt: 1, maxRetries: 5 },
    { retryAttempt: 2, maxRetries: 5 },
    { retryAttempt: 3, maxRetries: 5 },
    { retryAttempt: 4, maxRetries: 5 },
    { retryAttempt: 5, maxRetries: 5 },
  ])
})

test('connection errors keep the full ten rounds with x/10 in yields', async () => {
  const savedBase = process.env.DOGE_NETWORK_RETRY_BASE_MS
  process.env.DOGE_NETWORK_RETRY_BASE_MS = '10'
  let requests = 0
  const events: Array<{ retryAttempt: number; maxRetries: number }> = []
  let error: unknown
  try {
    for await (const event of withRetry(async () => ({} as any), async () => {
      requests++
      throw new APIConnectionError({ message: 'fetch failed' })
    }, { model: 'test', thinkingConfig: THINKING })) {
      events.push({ retryAttempt: event.retryAttempt, maxRetries: event.maxRetries })
    }
  } catch (caught) { error = caught }
  finally {
    if (savedBase === undefined) delete process.env.DOGE_NETWORK_RETRY_BASE_MS
    else process.env.DOGE_NETWORK_RETRY_BASE_MS = savedBase
  }
  expect(error).toBeInstanceOf(CannotRetryError)
  expect(requests).toBe(11)
  expect(events.map(e => e.maxRetries)).toEqual(Array.from({ length: 10 }, () => 10))
  expect(events.at(-1)?.retryAttempt).toBe(10)
  // 指数退避 10ms 起步 ×10 轮 ≈ 10–13s，默认 5s 超时不够
}, 30_000)

test('mixed error sequence budgets the two classes independently', async () => {
  // 2 次断连（infra）+ 4 次 429（other）后第 7 次请求成功：
  // infra 还剩 8 轮、other 还剩 1 轮，互不挪用
  const savedBase = process.env.DOGE_NETWORK_RETRY_BASE_MS
  process.env.DOGE_NETWORK_RETRY_BASE_MS = '10'
  const script: Array<'network' | 'api'> = ['network', 'network', 'api', 'api', 'api', 'api']
  let requests = 0
  try {
    const gen = withRetry(async () => ({} as any), async () => {
      const kind = script[requests]
      requests++
      if (kind === 'network') throw new APIConnectionError({ message: 'fetch failed' })
      if (kind === 'api') throw new APIError(429, undefined, 'rate limited', NO_DELAY)
      return 'ok'
    }, { model: 'test', thinkingConfig: THINKING })
    let result: unknown
    while (true) {
      const step = await gen.next()
      if (step.done) { result = step.value; break }
    }
    expect(result).toBe('ok')
    expect(requests).toBe(7)
  } finally {
    if (savedBase === undefined) delete process.env.DOGE_NETWORK_RETRY_BASE_MS
    else process.env.DOGE_NETWORK_RETRY_BASE_MS = savedBase
  }
})

test('CLAUDE_CODE_MAX_RETRIES caps both classes for test harnesses', () => {
  process.env[KEY] = '2'
  const budget = new RetryBudget()
  expect(budget.maxRetries).toBe(2)
  expect(budget.otherMaxRetries).toBe(2)
})

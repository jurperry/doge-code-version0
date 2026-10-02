import { test, expect, beforeEach, afterEach } from 'bun:test'
import { getDefaultMaxRetries, getRetryDelay, withRetry, RetryBudget, CannotRetryError } from './withRetry.js'
import { APIError } from '@anthropic-ai/sdk'

const KEY = 'CLAUDE_CODE_MAX_RETRIES'
const saved = process.env[KEY]

beforeEach(() => {
  delete process.env[KEY]
})

afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
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

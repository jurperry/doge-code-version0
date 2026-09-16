import { test, expect, beforeEach, afterEach } from 'bun:test'
import { getDefaultMaxRetries } from './withRetry.js'

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

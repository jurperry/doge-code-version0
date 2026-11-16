import { test, expect, beforeEach, afterEach } from 'bun:test'
import { describeEffortApplication } from './effort.js'

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_COMPATIBLE_API_PROVIDER',
  'CLAUDE_CODE_DISABLE_EFFORT',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

test('Opus 4.8 accepts the full ladder unchanged', () => {
  expect(describeEffortApplication('claude-opus-4-8', 'max')).toEqual({
    supported: true,
    requested: 'max',
    applied: 'max',
    downgraded: false,
  })
})

test('Sonnet 5 downgrades max/xhigh to high (product contract: max is Opus 4.8 only)', () => {
  expect(describeEffortApplication('claude-sonnet-5', 'xhigh')).toMatchObject({
    supported: true,
    requested: 'xhigh',
    applied: 'high',
    downgraded: true,
  })
})

test('Opus 4.5 keeps effort per the cached capability doc; older 4.5 variants do not', () => {
  expect(describeEffortApplication('claude-opus-4-5-20251101', 'high')).toMatchObject({
    supported: true,
    applied: 'high',
  })
  expect(describeEffortApplication('claude-sonnet-4-5-20250929', 'high')).toMatchObject({
    supported: false,
    applied: undefined,
  })
})

test('models without effort report the selection as unsupported', () => {
  expect(describeEffortApplication('claude-haiku-4-5-20251001', 'high')).toMatchObject({
    supported: false,
    requested: 'high',
    applied: undefined,
    downgraded: false,
  })
})

test('auto keeps following the model default', () => {
  expect(describeEffortApplication('claude-sonnet-5', undefined)).toEqual({
    supported: true,
    requested: undefined,
    applied: undefined,
    downgraded: false,
  })
})

test('disabled effort reports unsupported even for capable models', () => {
  process.env.CLAUDE_CODE_DISABLE_EFFORT = '1'
  expect(describeEffortApplication('claude-opus-4-8', 'high')).toMatchObject({
    supported: false,
    applied: undefined,
  })
})

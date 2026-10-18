import { test, expect, beforeEach, afterEach } from 'bun:test'
import { describeEffortApplication } from './effort.js'
import { clearModelCapabilityOverrideCache } from './model/modelSupportOverrides.js'

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
  clearModelCapabilityOverrideCache()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  clearModelCapabilityOverrideCache()
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

test('custom endpoints can enable max via tier capability declaration', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gw.test'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'gateway-model'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
    'effort,max_effort'
  expect(describeEffortApplication('gateway-model', 'max')).toMatchObject({
    supported: true,
    applied: 'max',
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

test('GLM 5.3 reports the mapped wire strength (xhigh → max)', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  expect(describeEffortApplication('glm-5.3', 'xhigh')).toMatchObject({
    supported: true,
    requested: 'xhigh',
    applied: 'max',
    downgraded: true,
  })
})

test('GLM Anthropic endpoint reports unsupported instead of pretending', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
  const result = describeEffortApplication('glm-5.3', 'high')
  expect(result.supported).toBe(false)
  expect(result.reason).toBeDefined()
})

test('xAI maps max down to the model wire ceiling (4.6 → xhigh, 4.5 → high)', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.x.ai/v1'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  expect(describeEffortApplication('grok-4.6', 'max')).toMatchObject({
    supported: true,
    requested: 'max',
    applied: 'xhigh',
    downgraded: true,
  })
  expect(describeEffortApplication('grok-4.5', 'max')).toMatchObject({
    supported: true,
    requested: 'max',
    applied: 'high',
    downgraded: true,
  })
})

test('Kimi forced-thinking models report unsupported strength control', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.moonshot.cn/v1'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  const result = describeEffortApplication('kimi-k2.7-code', 'high')
  expect(result.supported).toBe(false)
  expect(result.reason).toBeDefined()
})

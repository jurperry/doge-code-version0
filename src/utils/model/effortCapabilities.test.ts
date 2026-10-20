import { test, expect, beforeEach, afterEach } from 'bun:test'
import {
  clearEffortRejections,
  EFFORT_LEVELS,
  getEffortCapability,
  recordEffortRejection,
} from './effortCapabilities.js'
import { clearModelCapabilityOverrideCache } from './modelSupportOverrides.js'

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_COMPATIBLE_API_PROVIDER',
  'CLAUDE_CODE_DISABLE_EFFORT',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'USER_TYPE',
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

test('effort levels keep the five-way ladder', () => {
  expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
})

test('first-party Opus 4.8 exposes the full ladder with adaptive thinking', () => {
  const cap = getEffortCapability('claude-opus-4-8')
  expect(cap.supportsEffort).toBe(true)
  expect(cap.supportsMax).toBe(true)
  expect(cap.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(cap.thinking).toBe('adaptive')
  expect(cap.customEndpoint).toBe(false)
})

test('documented effort models: Sonnet 5 and Opus 4.5 without max', () => {
  const sonnet = getEffortCapability('claude-sonnet-5')
  expect(sonnet.supportsEffort).toBe(true)
  expect(sonnet.supportsMax).toBe(false)
  expect(sonnet.levels).toEqual(['low', 'medium', 'high'])
  expect(sonnet.thinking).toBe('adaptive')

  const opus45 = getEffortCapability('claude-opus-4-5-20251101')
  expect(opus45.supportsEffort).toBe(true)
  expect(opus45.levels).toEqual(['low', 'medium', 'high'])
  expect(opus45.thinking).toBe('budget')
})

test('undocumented Claude families keep adaptive thinking but no effort', () => {
  for (const model of [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-5-5',
    'claude-fable-5-1',
  ]) {
    const cap = getEffortCapability(model)
    expect(cap.supportsEffort).toBe(false)
    expect(cap.levels).toEqual([])
    expect(cap.thinking).toBe('adaptive')
  }
})

test('legacy models without effort keep budget/none thinking', () => {
  const haiku = getEffortCapability('claude-haiku-4-5-20251001')
  expect(haiku.supportsEffort).toBe(false)
  expect(haiku.thinking).toBe('budget')

  const sonnet45 = getEffortCapability('claude-sonnet-4-5-20250929')
  expect(sonnet45.supportsEffort).toBe(false)
  expect(sonnet45.thinking).toBe('budget')

  const claude3 = getEffortCapability('claude-3-5-sonnet-20241022')
  expect(claude3.supportsEffort).toBe(false)
  expect(claude3.thinking).toBe('none')
})

test('unknown first-party model keeps the historical permissive default', () => {
  const cap = getEffortCapability('claude-mystery-next')
  expect(cap.supportsEffort).toBe(true)
  expect(cap.supportsMax).toBe(false)
  expect(cap.levels).toEqual(['low', 'medium', 'high'])
  expect(cap.thinking).toBe('adaptive')
})

test('custom endpoints allow non-Claude models but not undocumented Claude families', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gw.test'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'

  const deepseek = getEffortCapability('deepseek-v4-pro')
  expect(deepseek.customEndpoint).toBe(true)
  expect(deepseek.supportsEffort).toBe(true)
  expect(deepseek.supportsMax).toBe(true)
  expect(deepseek.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(deepseek.thinking).toBe('none')

  // A custom proxy exposing an old Claude family must not get effort: the
  // underlying Anthropic model errors on it.
  const oldClaude = getEffortCapability('claude-sonnet-4-5-20250929')
  expect(oldClaude.supportsEffort).toBe(false)
  expect(oldClaude.levels).toEqual([])
})

test('custom endpoint Opus 4.8 stays adaptive and keeps its max gate', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.test'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
  const cap = getEffortCapability('claude-opus-4-8')
  expect(cap.supportsEffort).toBe(true)
  expect(cap.supportsMax).toBe(true)
  expect(cap.thinking).toBe('adaptive')
})

test('gateways without a documented effort wire hide the levels', () => {
  // GLM's Anthropic endpoint does not document effort: no options are shown,
  // not even for a pinned tier model.
  process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5.3'
  expect(getEffortCapability('glm-5.3')).toMatchObject({
    supportsEffort: true,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  })

  // Kimi's forced-thinking variants have no strength control either.
  process.env.ANTHROPIC_BASE_URL = 'https://api.moonshot.cn/v1'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  expect(getEffortCapability('kimi-k2.7-code')).toMatchObject({
    supportsEffort: false,
    levels: [],
  })
})

test('tier-pinned custom models inherit max/xhigh support on OpenAI gateways', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gw.test'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'gateway-model'
  expect(getEffortCapability('gateway-model')).toMatchObject({
    supportsEffort: true,
    supportsMax: true,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  })
})

test('capability declarations can add adaptive thinking to a custom model', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gw.test'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'gateway-model'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
    'effort,max_effort,thinking,adaptive_thinking'
  const cap = getEffortCapability('gateway-model')
  expect(cap.supportsEffort).toBe(true)
  expect(cap.supportsMax).toBe(true)
  expect(cap.thinking).toBe('adaptive')
})

test('custom endpoints can explicitly disable effort', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gw.test'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  process.env.CLAUDE_CODE_DISABLE_EFFORT = '1'
  expect(getEffortCapability('deepseek-v4-pro')).toMatchObject({
    supportsEffort: false,
    supportsMax: false,
    levels: [],
  })
})

test('fresh default GLM tier profiles auto-detect effort with blank declarations', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.test'
  for (const protocol of ['anthropic', 'openai', 'responses']) {
    process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = protocol
    for (const model of ['glm-5.3[1m]', 'glm-5.3-flash[1m]']) {
      for (const tier of ['OPUS', 'SONNET', 'HAIKU']) {
        process.env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = model
        process.env[`ANTHROPIC_DEFAULT_${tier}_MODEL_SUPPORTED_CAPABILITIES`] = ''
      }
      expect(getEffortCapability(model)).toMatchObject({
        supportsEffort: true,
        supportsMax: true,
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      })
      process.env.CLAUDE_CODE_DISABLE_EFFORT = '1'
      expect(getEffortCapability(model).supportsEffort).toBe(false)
      delete process.env.CLAUDE_CODE_DISABLE_EFFORT
    }
  }
})

test('third-party providers stay conservative unless declared', () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  const unknown = getEffortCapability('mystery-model')
  expect(unknown.supportsEffort).toBe(false)
  expect(unknown.thinking).toBe('none')

  const opus = getEffortCapability('us.anthropic.claude-opus-4-8-v1')
  expect(opus.supportsEffort).toBe(true)
  expect(opus.supportsMax).toBe(true)
  expect(opus.thinking).toBe('adaptive')
})

test('always-enable-effort lifts the gate only where a wire mapping exists', () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  const cap = getEffortCapability('mystery-model')
  expect(cap.supportsEffort).toBe(true)
  expect(cap.supportsMax).toBe(false)
  expect(cap.levels).toEqual(['low', 'medium', 'high'])
})

test('context-window suffixes do not break model detection', () => {
  const opus1m = getEffortCapability('claude-opus-4-8[1m]')
  expect(opus1m.supportsEffort).toBe(true)
  expect(opus1m.supportsMax).toBe(true)
  expect(opus1m.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])

  const sonnet1m = getEffortCapability('claude-sonnet-5[1m]')
  expect(sonnet1m.supportsEffort).toBe(true)
  expect(sonnet1m.levels).toEqual(['low', 'medium', 'high'])

  // Vertex IDs carry an @date suffix and must be recognized too.
  const vertex = getEffortCapability('claude-opus-4-5@20251101')
  expect(vertex.supportsEffort).toBe(true)
  expect(vertex.levels).toEqual(['low', 'medium', 'high'])

  process.env.ANTHROPIC_BASE_URL = 'https://api.openai.com/v1'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  expect(getEffortCapability('gpt-4o[1m]').supportsEffort).toBe(false)
})

test('Qwen OpenAI levels disappear when thinking is explicitly disabled', () => {
  process.env.ANTHROPIC_BASE_URL =
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  expect(getEffortCapability('qwen3.8-max').levels).toHaveLength(5)
  process.env.CLAUDE_CODE_DISABLE_THINKING = '1'
  expect(getEffortCapability('qwen3.8-max').levels).toEqual([])
  delete process.env.CLAUDE_CODE_DISABLE_THINKING
})

test('non-reasoning OpenAI models never receive reasoning_effort', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.openai.com/v1'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  const gpt4o = getEffortCapability('gpt-4o')
  expect(gpt4o.supportsEffort).toBe(false)
  expect(gpt4o.levels).toEqual([])
  expect(getEffortCapability('gpt-4-turbo-preview').supportsEffort).toBe(false)
  expect(getEffortCapability('gpt-4-0613').supportsEffort).toBe(false)
  // A reasoning model on the same endpoint is still allowed.
  expect(getEffortCapability('gpt-5.6').supportsEffort).toBe(true)
})

test('a runtime 400 effort rejection disables effort for the session', () => {
  recordEffortRejection('claude-opus-4-8')
  const cap = getEffortCapability('claude-opus-4-8')
  expect(cap.supportsEffort).toBe(false)
  expect(cap.levels).toEqual([])
  clearEffortRejections()
  expect(getEffortCapability('claude-opus-4-8').supportsEffort).toBe(true)
})

test('protocol comes from the configured compatibility provider', () => {
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'responses'
  expect(getEffortCapability('claude-opus-4-8').protocol).toBe('responses')
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'bogus'
  expect(getEffortCapability('claude-opus-4-8').protocol).toBe('anthropic')
})

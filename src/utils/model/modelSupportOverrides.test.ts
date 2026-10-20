import { test, expect, beforeEach, afterEach } from 'bun:test'
import {
  clearModelCapabilityOverrideCache,
  get3PModelCapabilityOverride,
} from './modelSupportOverrides.js'
import { clearProfileEnvVars } from './switchModelProfile.js'

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  clearModelCapabilityOverrideCache()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  clearModelCapabilityOverrideCache()
})

test('capability override follows the current configuration without stale cache entries', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gw.test'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'm-1'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'effort,thinking'
  expect(get3PModelCapabilityOverride('m-1', 'effort')).toBe(true)

  // Same model, new capability set from a different provider profile.
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'max_effort'
  // Routing context is part of the memo key, including capability slots.
  expect(get3PModelCapabilityOverride('m-1', 'effort')).toBe(false)
  clearModelCapabilityOverrideCache()
  expect(get3PModelCapabilityOverride('m-1', 'effort')).toBe(false)
  expect(get3PModelCapabilityOverride('m-1', 'max_effort')).toBe(true)
})

test('clearProfileEnvVars invalidates the memoized overrides', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gw.test'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'm-1'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = 'thinking'
  expect(get3PModelCapabilityOverride('m-1', 'thinking')).toBe(true)

  clearProfileEnvVars()

  // Env gone → the override must resolve undefined, not the stale true.
  expect(get3PModelCapabilityOverride('m-1', 'thinking')).toBeUndefined()
})

test('blank capability declarations mean automatic detection on startup', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://gw.test'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5.3'
  for (const declaration of ['', '   ', '\t\n']) {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = declaration
    for (const capability of ['effort', 'max_effort', 'thinking', 'adaptive_thinking', 'interleaved_thinking'] as const) {
      expect(get3PModelCapabilityOverride('glm-5.3[1m]', capability)).toBeUndefined()
    }
  }
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = ' thinking '
  expect(get3PModelCapabilityOverride('glm-5.3', 'effort')).toBe(false)
  expect(get3PModelCapabilityOverride('glm-5.3', 'thinking')).toBe(true)
})

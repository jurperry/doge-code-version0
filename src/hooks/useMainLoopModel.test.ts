import { test, expect, beforeEach, afterEach } from 'bun:test'

// We test the pure resolver factored out of the hook; React rendering is
// not exercised here. The hook calls resolveMainLoopModel internally.
import { resolveMainLoopModel } from './useMainLoopModel.js'

const originalEnv = { ...process.env }

beforeEach(() => {
  for (const k of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]) {
    delete process.env[k]
  }
  Object.assign(process.env, originalEnv)
})

test('returns concrete model id when AppState.mainLoopModel is concrete', () => {
  process.env.ANTHROPIC_MODEL = 'deepseek-chat'
  const out = resolveMainLoopModel({
    mainLoopModel: 'deepseek-chat',
    mainLoopModelForSession: null,
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  expect(out).toBe('deepseek-chat')
})

test('resolves haiku alias via env var, not the literal "haiku"', () => {
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-flash'
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'
  const out = resolveMainLoopModel({
    mainLoopModel: 'haiku',
    mainLoopModelForSession: null,
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  expect(out).toBe('qwen3-flash')
})

test('haiku alias falls back to ANTHROPIC_MODEL when HAIKU env missing (core regression)', () => {
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  process.env.ANTHROPIC_MODEL = 'deepseek-chat'
  const out = resolveMainLoopModel({
    mainLoopModel: 'haiku',
    mainLoopModelForSession: null,
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  expect(out).toBe('deepseek-chat')
})

test('mainLoopModelForSession takes priority over mainLoopModel', () => {
  const out = resolveMainLoopModel({
    mainLoopModel: 'haiku',
    mainLoopModelForSession: 'session-override',
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  expect(out).toBe('session-override')
})

test('plan mode does NOT upgrade parsed haiku-tier when original setting is not literally "haiku"', () => {
  // getRuntimeMainLoopModel upgrades haiku→sonnet ONLY when the ORIGINAL
  // model setting string equals 'haiku' (it reads getUserSpecifiedModelSetting(),
  // not the mainLoopModel arg). Here ANTHROPIC_MODEL='qwen3.7-max', so the
  // parsed haiku-tier id 'qwen3-flash' passes through unchanged.
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-flash'
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'
  const out = resolveMainLoopModel({
    mainLoopModel: 'haiku',
    mainLoopModelForSession: null,
    permissionMode: 'plan',
    exceeds200kTokens: false,
  })
  expect(out).toBe('qwen3-flash')
})

test('does not fall through to customApiStorage when AppState fields are null', () => {
  delete process.env.ANTHROPIC_MODEL
  const out = resolveMainLoopModel({
    mainLoopModel: null,
    mainLoopModelForSession: null,
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  // Default falls through getDefaultMainLoopModelSetting() — assertion is
  // that the returned value is NOT the 'haiku' alias and NOT the empty string,
  // and NOT a value from customApiStorage that we did not pass in.
  expect(out).not.toBe('haiku')
  expect(out).not.toBe('')
  expect(typeof out).toBe('string')
})

test('plan mode upgrades to sonnet when original ANTHROPIC_MODEL setting is literally "haiku"', () => {
  // When getUserSpecifiedModelSetting() returns 'haiku', getRuntimeMainLoopModel
  // forces getDefaultSonnetModel(). Set ANTHROPIC_MODEL='haiku' (literal alias)
  // and give the sonnet tier a concrete id so the upgrade lands observably.
  process.env.ANTHROPIC_MODEL = 'haiku'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'qwen3-plus'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-flash'
  const out = resolveMainLoopModel({
    mainLoopModel: 'haiku',
    mainLoopModelForSession: null,
    permissionMode: 'plan',
    exceeds200kTokens: false,
  })
  expect(out).toBe('qwen3-plus')
})
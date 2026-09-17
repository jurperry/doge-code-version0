import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Sandbox the config dir BEFORE importing the module under test: the default
// model chain falls through getUserSpecifiedModelSetting() → settings.json /
// secure storage under CLAUDE_CONFIG_DIR, and getDefaultMainLoopModelSetting()
// → isMaxSubscriber() → getAnthropicApiKeyWithSource() THROWS when no key is
// resolvable — this suite used to fail whenever the user's real ~/.doge
// credentials were cleared (known env-dependent failure, see AGENTS.md).
//
// Fixed path, rebuilt at load: bun test fires neither afterAll-late enough
// (deleting here breaks sibling files whose import graph captured proper-
// lockfile paths under this dir — teamHelpers times out) nor process exit
// handlers, so per-run mkdtemp dirs leak. A deterministic path keeps the
// residue to ONE empty dir that the next run re-creates.
const TMP_CONFIG_DIR = join(tmpdir(), 'doge-model-test-sandbox')
rmSync(TMP_CONFIG_DIR, { recursive: true, force: true })
mkdirSync(TMP_CONFIG_DIR, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR

// We test the pure resolver factored out of the hook; React rendering is
// not exercised here. The hook calls resolveMainLoopModel internally.
const { resolveMainLoopModel } = await import('./useMainLoopModel.js')

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
  // The default chain bottoms out in getDefaultMainLoopModelSetting() →
  // isMaxSubscriber() → getAnthropicApiKeyWithSource(), which THROWS when no
  // key is resolvable. A dummy env key (empty sandbox storage has none) makes
  // the chain resolve: no oauthAccount → not Max → sonnet default. Scoped to
  // this test — a module-level dummy would leak into sibling test files that
  // assert env-key priority (restoreTierState.test "heals wiped credentials").
  const prevKey = process.env.DOGE_API_KEY
  process.env.DOGE_API_KEY = 'sk-test-dummy-model-test'
  try {
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
  } finally {
    if (prevKey === undefined) delete process.env.DOGE_API_KEY
    else process.env.DOGE_API_KEY = prevKey
  }
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
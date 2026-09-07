// resolveSessionDefaultModel — single source of truth for what
// "Default (recommended)" maps to. switchTier(null) commits its result and
// the /model command renders it in "Set model to …", so both must resolve
// the same chain: env sonnet tier → stored main profile's sonnet field →
// ANTHROPIC_MODEL → stored main model → null.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const TMP = join(process.cwd(), 'test', '.tmp-bindings-test')

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const
let originalEnv: Record<string, string | undefined> = {}
let resolveSessionDefaultModel: () => string | null
let switchTierBound: typeof import('./switchModelProfile.bindings.js').switchTierBound

beforeAll(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key]
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  // Must be set before the dynamic import so the module chain's config-dir
  // memoize (keyed on the env value) never resolves the real ~/.doge.
  process.env.CLAUDE_CONFIG_DIR = TMP
  const mod = await import('./switchModelProfile.bindings.js')
  resolveSessionDefaultModel = mod.resolveSessionDefaultModel
  switchTierBound = mod.switchTierBound
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    const v = originalEnv[key]
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
  }
  rmSync(TMP, { recursive: true, force: true })
})

function clearEnv() {
  for (const key of ENV_KEYS) {
    if (key !== 'CLAUDE_CONFIG_DIR') delete process.env[key]
  }
}

function writeStorage(customApiEndpoint: Record<string, unknown>) {
  writeFileSync(join(TMP, '.credentials.json'), JSON.stringify({ customApiEndpoint }))
}

test('env sonnet tier wins over everything else', () => {
  clearEnv()
  writeStorage({ model: 'deepseek-v4-pro[1m]' })
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'tier-from-env'
  expect(resolveSessionDefaultModel()).toBe('tier-from-env')
})

test('falls back to the stored main profile sonnet field when env tier is unset', () => {
  clearEnv()
  writeStorage({
    model: 'deepseek-v4-pro[1m]',
    modelProfiles: [
      {
        model: 'deepseek-v4-pro[1m]',
        defaultSonnetModel: 'deepseek-v4-pro',
      },
    ],
  })
  expect(resolveSessionDefaultModel()).toBe('deepseek-v4-pro')
})

test('baseline profile sonnet must NOT outrank the active provider main model', () => {
  clearEnv()
  writeStorage({
    model: 'deepseek-v4-pro[1m]',
    modelProfiles: [
      { model: 'deepseek-v4-pro[1m]', defaultSonnetModel: 'deepseek-v4-pro' },
    ],
  })
  // Session switched to kimi, whose profile has no sonnet tier → the tier
  // env var was DELETED by applyModelProfile. Default must fall to the
  // ACTIVE provider's main model, never the baseline's sonnet tier — a
  // baseline tier model id sent to the active endpoint is a wrong-model
  // request.
  process.env.ANTHROPIC_MODEL = 'kimi-k3[1m]'
  expect(resolveSessionDefaultModel()).toBe('kimi-k3[1m]')
})

test('active profile sonnet field is honored when the env tier var is missing', () => {
  clearEnv()
  writeStorage({
    model: 'deepseek-v4-pro[1m]',
    modelProfiles: [
      { model: 'deepseek-v4-pro[1m]', defaultSonnetModel: 'deepseek-v4-pro' },
      { model: 'kimi-k3[1m]', defaultSonnetModel: 'kimi-k3-sonnet-view' },
    ],
  })
  process.env.ANTHROPIC_MODEL = 'kimi-k3[1m]'
  expect(resolveSessionDefaultModel()).toBe('kimi-k3-sonnet-view')
})

test('switchTierBound opus — active provider main model wins over baseline tier', () => {
  clearEnv()
  writeStorage({
    model: 'deepseek-v4-pro[1m]',
    modelProfiles: [
      { model: 'deepseek-v4-pro[1m]', defaultOpusModel: 'deepseek-v4-opus' },
    ],
  })
  process.env.ANTHROPIC_MODEL = 'kimi-k3[1m]'
  let state: { mainLoopModel: string | null; mainLoopModelForSession: string | null } = {
    mainLoopModel: 'deepseek-v4-pro[1m]',
    mainLoopModelForSession: null,
  }
  switchTierBound('opus', {
    syncToDisk: () => {
      throw new Error('session tier switch must not persist')
    },
    setAppState: (updater: (prev: any) => any) => {
      state = updater(state)
    },
  })
  expect(state.mainLoopModelForSession).toBe('kimi-k3[1m]')
  expect(state.mainLoopModel).toBe('deepseek-v4-pro[1m]')
})

test('session-scoped provider switch (env model) outranks the disk baseline', () => {
  // Regression for the "Set model to deepseek-v4-pro after picking Default
  // while running kimi" bug: the disk baseline model must NOT be what the
  // message shows when the active provider is described by env.
  clearEnv()
  writeStorage({ model: 'deepseek-v4-pro[1m]' })
  process.env.ANTHROPIC_MODEL = 'kimi-k3[1m]'
  expect(resolveSessionDefaultModel()).toBe('kimi-k3[1m]')
})

test('falls back to the stored main model when no env is set', () => {
  clearEnv()
  writeStorage({ model: 'deepseek-v4-pro[1m]' })
  expect(resolveSessionDefaultModel()).toBe('deepseek-v4-pro[1m]')
})

test('returns null for a first-party user with no custom config', () => {
  clearEnv()
  writeStorage({})
  expect(resolveSessionDefaultModel()).toBeNull()
})

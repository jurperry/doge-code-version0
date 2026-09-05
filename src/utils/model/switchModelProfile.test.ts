import { test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  clearProfileEnvVars,
  captureEnvSnapshot,
  restoreEnvSnapshot,
  ModelSwitchError,
} from './switchModelProfile.js'
import { PROFILE_MANAGED_ENV_KEYS } from './profileEnvKeys.js'
import type { ModelProfile } from '../customApiStorage.js'

// Save & restore env around each test so they don't bleed.
let originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  originalEnv = {}
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    originalEnv[key] = process.env[key]
  }
})

afterEach(() => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    const v = originalEnv[key]
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
  }
})

test('clearProfileEnvVars deletes every key in the whitelist', () => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    process.env[key] = 'preset-value'
  }
  clearProfileEnvVars()
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    expect(process.env[key]).toBeUndefined()
  }
})

test('clearProfileEnvVars is idempotent on undefined keys', () => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    delete process.env[key]
  }
  expect(() => clearProfileEnvVars()).not.toThrow()
})

test('captureEnvSnapshot + restoreEnvSnapshot round-trip preserves undefined keys', () => {
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'foo-opus'
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  const snap = captureEnvSnapshot()
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'CONTAMINATED'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'CONTAMINATED'
  restoreEnvSnapshot(snap)
  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('foo-opus')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
})

test('ModelSwitchError exposes phase and cause', () => {
  const inner = new Error('disk read-only')
  const err = new ModelSwitchError('persist', inner)
  expect(err.phase).toBe('persist')
  expect(err.cause).toBe(inner)
  expect(err.message).toContain('persist')
  expect(err.message).toContain('disk read-only')
})

// ── Test helpers ────────────────────────────────────────────────────
function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    model: 'test-model',
    provider: 'openai',
    baseURL: 'https://example.test/v1',
    apiKey: 'sk-test',
    authTokenType: 'DOGE_API_KEY',
    ...overrides,
  } as ModelProfile
}

test('switchModelProfileAtomic — clean path writes new profile env, AppState, disk', async () => {
  const profile = makeProfile({
    model: 'deepseek-chat',
    defaultHaikuModel: undefined,
  })

  // Pre-pollute env with old profile's haiku.
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-flash'
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'

  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})
  const applyMock = mock((p: ModelProfile) => {
    process.env.ANTHROPIC_MODEL = p.model
  })

  const { switchModelProfileAtomic } = await import('./switchModelProfile.js')
  await switchModelProfileAtomic(profile, {
    applyProfile: applyMock,
    syncToDisk: syncMock,
    commitAppState: setAppStateMock,
  })

  // Core regression: haiku env from old profile must be gone.
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
  expect(process.env.ANTHROPIC_MODEL).toBe('deepseek-chat')
  expect(applyMock).toHaveBeenCalledWith(profile)
  // 回归：profile 切换必须携带目标 profile 的凭证落盘（第三参数），
  // 绝不能 clearCredentials=true —— 那会清空顶层凭证，裸重启后
  // 无 key 可用，出现 "Not logged in · Run /login"。
  expect(syncMock).toHaveBeenCalledWith('deepseek-chat', false, profile)
  expect(setAppStateMock).toHaveBeenCalledTimes(1)
})

test('switchModelProfileAtomic — applyProfile throws → env rolled back, AppState untouched', async () => {
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-flash'
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'

  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})
  const applyMock = mock(() => {
    throw new Error('boom')
  })

  const { switchModelProfileAtomic } = await import('./switchModelProfile.js')
  await expect(
    switchModelProfileAtomic(makeProfile(), {
      applyProfile: applyMock,
      syncToDisk: syncMock,
      commitAppState: setAppStateMock,
    }),
  ).rejects.toThrow(ModelSwitchError)

  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qwen3-flash')
  expect(process.env.ANTHROPIC_MODEL).toBe('qwen3.7-max')
  expect(setAppStateMock).not.toHaveBeenCalled()
})

test('switchModelProfileAtomic — syncToDisk throws → env rolled back, throws persist phase', async () => {
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'

  const setAppStateMock = mock(() => {})
  const applyMock = mock((p: ModelProfile) => {
    process.env.ANTHROPIC_MODEL = p.model
  })
  const syncMock = mock(() => {
    throw new Error('EACCES')
  })

  const { switchModelProfileAtomic } = await import('./switchModelProfile.js')
  let caught: ModelSwitchError | null = null
  try {
    await switchModelProfileAtomic(makeProfile({ model: 'deepseek-chat' }), {
      applyProfile: applyMock,
      syncToDisk: syncMock,
      commitAppState: setAppStateMock,
    })
  } catch (e) {
    caught = e as ModelSwitchError
  }
  expect(caught).toBeInstanceOf(ModelSwitchError)
  expect(caught?.phase).toBe('persist')
  expect(process.env.ANTHROPIC_MODEL).toBe('qwen3.7-max')
  expect(setAppStateMock).not.toHaveBeenCalled()
})

test('switchTier(haiku) — persists tier selection only, does NOT rewrite the main-model slot', async () => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    process.env[key] = `preset-${key}`
  }

  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})
  const persistTierMock = mock(() => {})

  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: syncMock,
    commitAppState: setAppStateMock,
    resolveTierModel: () => 'deepseek-v4-flash',
    persistTier: persistTierMock,
    getStoredMainModel: () => 'deepseek-v4-pro[1m]',
  })

  // 仍不碰白名单 env（不动 env 不变式保留）
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    expect(process.env[key]).toBe(`preset-${key}`)
  }
  // 新语义：只持久化层级选择，绝不把 tier 模型写进主模型槽位
  // （旧实现 syncToDisk(realTierModel) 污染主模型，导致重启后所有
  //  tier fallback 到该模型 —— /model 全部显示同一模型的 bug）
  expect(syncMock).not.toHaveBeenCalled()
  expect(persistTierMock).toHaveBeenCalledWith('haiku')
  expect(setAppStateMock).toHaveBeenCalledTimes(1)
})

test('switchTier(null) — custom API user: clears tier, returns to stored main model, keeps credentials', async () => {
  let committed: any = null
  const syncMock = mock(() => {})
  const persistTierMock = mock(() => {})
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier(null, {
    syncToDisk: syncMock,
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'deepseek-v4-flash', mainLoopModelForSession: 'x' })
    },
    resolveTierModel: () => 'unused',
    persistTier: persistTierMock,
    getStoredMainModel: () => 'deepseek-v4-pro[1m]',
  })
  expect(committed.mainLoopModel).toBe('deepseek-v4-pro[1m]')
  expect(committed.mainLoopModelForSession).toBeNull()
  // 清层级选择；凭证与主模型槽位不动（不调 syncToDisk）
  expect(persistTierMock).toHaveBeenCalledWith(null)
  expect(syncMock).not.toHaveBeenCalled()
})

test('switchTier(null) — first-party user: commits mainLoopModel as null, clears credentials (legacy default path)', async () => {
  let committed: any = null
  let synced: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier(null, {
    syncToDisk: (model, clearCreds, _profile) => { synced = { model, clearCreds, _profile } },
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'haiku', mainLoopModelForSession: 'x' })
    },
    resolveTierModel: () => 'unused',
    persistTier: () => {},
    getStoredMainModel: () => undefined,
  })
  expect(committed.mainLoopModel).toBeNull()
  expect(committed.mainLoopModelForSession).toBeNull()
  // 官方用户 default 路径：清凭证 + 清 model + 无凭证来源（保持原有语义）
  expect(synced.model).toBe('')
  expect(synced.clearCreds).toBe(true)
  expect(synced._profile).toBeUndefined()
})

test('switchModelProfileAtomic — apply failure rolls back NON-whitelisted endpoint/key/provider too', async () => {
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'
  process.env.ANTHROPIC_BASE_URL = 'https://qwen.test/v1'
  process.env.DOGE_API_KEY = 'qwen-key'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  delete process.env.ANTHROPIC_AUTH_TOKEN

  const applyMock = mock(() => {
    throw new Error('boom')
  })

  const { switchModelProfileAtomic } = await import('./switchModelProfile.js')
  await expect(
    switchModelProfileAtomic(makeProfile({ model: 'deepseek-chat' }), {
      applyProfile: applyMock,
      syncToDisk: mock(() => {}),
      commitAppState: mock(() => {}),
    }),
  ).rejects.toThrow(ModelSwitchError)

  // All four non-whitelisted env vars must be restored to old values, not leaked.
  expect(process.env.ANTHROPIC_MODEL).toBe('qwen3.7-max')
  expect(process.env.ANTHROPIC_BASE_URL).toBe('https://qwen.test/v1')
  expect(process.env.DOGE_API_KEY).toBe('qwen-key')
  expect(process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER).toBe('openai')
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
})

test('switchModelProfileAtomic — persist failure rolls back endpoint/key/provider', async () => {
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'
  process.env.ANTHROPIC_BASE_URL = 'https://qwen.test/v1'
  process.env.DOGE_API_KEY = 'qwen-key'
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'

  const applyMock = mock((p: ModelProfile) => {
    // New profile writes its own endpoint/key/provider before throw happens later.
    process.env.ANTHROPIC_MODEL = p.model
    process.env.ANTHROPIC_BASE_URL = 'https://deepseek.test/v1'
    process.env.DOGE_API_KEY = 'deepseek-key'
    process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
  })
  const syncMock = mock(() => {
    throw new Error('EACCES')
  })

  const { switchModelProfileAtomic } = await import('./switchModelProfile.js')
  let caught: ModelSwitchError | null = null
  try {
    await switchModelProfileAtomic(makeProfile({ model: 'deepseek-chat' }), {
      applyProfile: applyMock,
      syncToDisk: syncMock,
      commitAppState: mock(() => {}),
    })
  } catch (e) {
    caught = e as ModelSwitchError
  }
  expect(caught?.phase).toBe('persist')
  // After rollback the NEW profile's endpoint/key must be gone, old values restored.
  expect(process.env.ANTHROPIC_BASE_URL).toBe('https://qwen.test/v1')
  expect(process.env.DOGE_API_KEY).toBe('qwen-key')
  expect(process.env.ANTHROPIC_MODEL).toBe('qwen3.7-max')
})

test('switchModelProfileAtomic — commit failure reverts disk via syncToDisk(oldModel, true)', async () => {
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'

  const applyMock = mock((p: ModelProfile) => {
    process.env.ANTHROPIC_MODEL = p.model
  })
  const syncMock = mock(() => {})
  const commitMock = mock(() => {
    throw new Error('store corrupt')
  })

  const { switchModelProfileAtomic } = await import('./switchModelProfile.js')
  let caught: ModelSwitchError | null = null
  try {
    await switchModelProfileAtomic(makeProfile({ model: 'deepseek-chat' }), {
      applyProfile: applyMock,
      syncToDisk: syncMock,
      commitAppState: commitMock,
    })
  } catch (e) {
    caught = e as ModelSwitchError
  }
  expect(caught?.phase).toBe('commit')
  // env rolled back
  expect(process.env.ANTHROPIC_MODEL).toBe('qwen3.7-max')
  // disk revert: syncToDisk called again with the old model id
  expect(syncMock).toHaveBeenCalledWith('qwen3.7-max', true)
})

test('switchTier(opus) — resolves real opus model ID with [1m] suffix preserved, main-model slot untouched', async () => {
  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})
  const persistTierMock = mock(() => {})

  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('opus', {
    syncToDisk: syncMock,
    commitAppState: setAppStateMock,
    resolveTierModel: () => 'deepseek-v4-pro[1m]',
    persistTier: persistTierMock,
    getStoredMainModel: () => 'deepseek-v4-flash',
  })

  expect(syncMock).not.toHaveBeenCalled()
  expect(persistTierMock).toHaveBeenCalledWith('opus')
})

test('switchTier(haiku) — no stored main model still persists tier without crashing', async () => {
  const setAppStateMock = mock(() => {})
  const persistTierMock = mock(() => {})

  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: () => {},
    commitAppState: setAppStateMock,
    resolveTierModel: () => 'deepseek-v4-flash',
    persistTier: persistTierMock,
    getStoredMainModel: () => undefined,
  })

  expect(persistTierMock).toHaveBeenCalledWith('haiku')
  expect(setAppStateMock).toHaveBeenCalledTimes(1)
})

test('switchTier(haiku) — commitAppState mainLoopModel === resolved real tier model ID', async () => {
  let committed: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: () => {},
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'old-haiku', mainLoopModelForSession: 'sess' })
    },
    resolveTierModel: () => 'deepseek-v4-flash',
    persistTier: () => {},
    getStoredMainModel: () => 'deepseek-v4-pro[1m]',
  })
  // 核心：mainLoopModel 是真实 tier 模型 ID，不是字面 'haiku'
  expect(committed.mainLoopModel).toBe('deepseek-v4-flash')
  expect(committed.mainLoopModelForSession).toBeNull()
})

test('switchTier(haiku) — resolveTierModel returns main model when no tier env (graceful degradation)', async () => {
  // 模拟降级：resolveTierModel 解析不出真实 tier 模型，回落主模型 ID
  const setAppStateMock = mock(() => {})
  let committed: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: () => {},
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'old', mainLoopModelForSession: null })
      setAppStateMock()
    },
    resolveTierModel: () => 'main-model-id',
    persistTier: () => {},
    getStoredMainModel: () => 'main-model-id',
  })
  // 降级为真实主模型 ID 仍优于现状（不发出字面 'haiku'）
  expect(committed.mainLoopModel).toBe('main-model-id')
})

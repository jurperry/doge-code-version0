import { test, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  clearProfileEnvVars,
  captureEnvSnapshot,
  restoreEnvSnapshot,
  ModelSwitchError,
} from './switchModelProfile.js'
import { PROFILE_MANAGED_ENV_KEYS } from './profileEnvKeys.js'
import { modelProfileEnvPatch, type ModelProfile } from '../customApiStorage.js'

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

test('profile patch carries catalog selection ids', () => {
  const profile = {
    id: 'c1',
    connectionId: 'c1',
    catalogModelId: 'm1',
    model: 'm'
  } as ModelProfile
  const patch = modelProfileEnvPatch(profile)
  expect(patch.DOGE_ACTIVE_CONNECTION_ID).toBe('c1')
  expect(patch.DOGE_ACTIVE_MODEL_ID).toBe('m1')
  expect(patch.DOGE_REASONING_POLICY).toBeUndefined()
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

// ── switchTier (2026-09-07 provider refactor: tiers are session-scoped) ──

test('switchTier(haiku) — session commit only; never persists, never syncs disk', async () => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    process.env[key] = `preset-${key}`
  }

  let committed: any = null
  const setAppStateMock = mock((updater: any) => {
    committed = updater({ mainLoopModel: 'deepseek-v4-pro', mainLoopModelForSession: null })
  })
  const syncMock = mock(() => {})

  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: syncMock,
    commitAppState: setAppStateMock,
    resolveTierModel: () => 'deepseek-v4-flash',
    resolveDefaultModel: () => 'unused',
    getStoredMainModel: () => 'deepseek-v4-pro[1m]',
  })

  // 仍不碰白名单 env（不动 env 不变式保留）
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    expect(process.env[key]).toBe(`preset-${key}`)
  }
  // 档位选择一律会话级：只写 mainLoopModelForSession，绝不改主模型槽位、
  // 绝不落盘（旧实现把 tier 选择持久化成 activeTier/tierModels，其他终端
  // 启动时被强制进该档位 —— 跨终端 custom model 污染 bug 的根源）
  expect(committed.mainLoopModel).toBe('deepseek-v4-pro')
  expect(committed.mainLoopModelForSession).toBe('deepseek-v4-flash')
  expect(syncMock).not.toHaveBeenCalled()
})

test('switchTier(haiku) global scope — STILL session commit (tiers never persist)', async () => {
  let committed: any = null
  const syncMock = mock(() => {})
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: syncMock,
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'old', mainLoopModelForSession: null })
    },
    resolveTierModel: () => 'deepseek-v4-flash',
    resolveDefaultModel: () => 'unused',
    getStoredMainModel: () => 'deepseek-v4-pro[1m]',
    sessionScoped: false,
  })
  // 即使 DOGE_MODEL_SCOPE=global / --save，档位别名也不持久化：
  // 把 tier 模型写进主模型槽位是旧 bug（重启后所有档位 fallback 到它）
  expect(committed.mainLoopModel).toBe('old')
  expect(committed.mainLoopModelForSession).toBe('deepseek-v4-flash')
  expect(syncMock).not.toHaveBeenCalled()
})

test('switchTier(null) session — commits the provider default (sonnet tier or main model)', async () => {
  let committed: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier(null, {
    syncToDisk: mock(() => {}),
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'deepseek-v4-pro', mainLoopModelForSession: 'x' })
    },
    resolveTierModel: () => 'unused',
    resolveDefaultModel: () => 'deepseek-v4-air',
    getStoredMainModel: () => 'deepseek-v4-pro[1m]',
    sessionScoped: true,
  })
  // Default = 当前 provider 的 sonnet 档（未配置则回落主模型），而非
  // 清掉会话覆盖回到启动基线 —— 否则会话内切换 provider 后选 Default
  // 会错误回到旧 provider 的模型
  expect(committed.mainLoopModelForSession).toBe('deepseek-v4-air')
  expect(committed.mainLoopModel).toBe('deepseek-v4-pro')
})

test('switchTier(null) session — unresolvable default (first-party) clears the session override', async () => {
  let committed: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier(null, {
    syncToDisk: mock(() => {}),
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'claude-sonnet-5', mainLoopModelForSession: 'x' })
    },
    resolveTierModel: () => 'unused',
    resolveDefaultModel: () => null,
    getStoredMainModel: () => undefined,
    sessionScoped: true,
  })
  expect(committed.mainLoopModelForSession).toBeNull()
})

test('switchTier(null) global custom user — scrubs legacy tier state, returns to stored main model', async () => {
  let committed: any = null
  const syncMock = mock(() => {})
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier(null, {
    syncToDisk: syncMock,
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'deepseek-v4-flash', mainLoopModelForSession: 'x' })
    },
    resolveTierModel: () => 'unused',
    resolveDefaultModel: () => 'unused',
    getStoredMainModel: () => 'deepseek-v4-pro[1m]',
    sessionScoped: false,
  })
  expect(committed.mainLoopModel).toBe('deepseek-v4-pro[1m]')
  expect(committed.mainLoopModelForSession).toBeNull()
  // 凭证与主模型槽位不动（不调 syncToDisk）
  expect(syncMock).not.toHaveBeenCalled()
})

test('switchTier(null) global first-party — commits mainLoopModel as null, clears credentials (legacy default path)', async () => {
  let committed: any = null
  let synced: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier(null, {
    syncToDisk: (model, clearCreds, _profile) => { synced = { model, clearCreds, _profile } },
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'haiku', mainLoopModelForSession: 'x' })
    },
    resolveTierModel: () => 'unused',
    resolveDefaultModel: () => null,
    clearLegacyTier: mock(() => {}),
    getStoredMainModel: () => undefined,
    sessionScoped: false,
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

test('switchTier(opus) — resolved model lands in the SESSION slot with [1m] suffix preserved', async () => {
  let committed: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('opus', {
    syncToDisk: mock(() => {}),
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'deepseek-v4-flash', mainLoopModelForSession: 'sess' })
    },
    resolveTierModel: () => 'deepseek-v4-pro[1m]',
    resolveDefaultModel: () => 'unused',
    getStoredMainModel: () => 'deepseek-v4-flash',
  })
  // 核心：会话槽位拿到的是真实 tier 模型 ID（含 [1m] 后缀），主模型槽不动
  expect(committed.mainLoopModelForSession).toBe('deepseek-v4-pro[1m]')
  expect(committed.mainLoopModel).toBe('deepseek-v4-flash')
})

test('switchTier(haiku) — no stored main model still commits without crashing', async () => {
  const setAppStateMock = mock(() => {})
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: () => {},
    commitAppState: setAppStateMock,
    resolveTierModel: () => 'deepseek-v4-flash',
    resolveDefaultModel: () => null,
    getStoredMainModel: () => undefined,
  })
  expect(setAppStateMock).toHaveBeenCalledTimes(1)
})

test('switchTier(haiku) — resolveTierModel returns main model when no tier env (graceful degradation)', async () => {
  // 模拟降级：resolveTierModel 解析不出真实 tier 模型，回落主模型 ID
  let committed: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: () => {},
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'old', mainLoopModelForSession: null })
    },
    resolveTierModel: () => 'main-model-id',
    resolveDefaultModel: () => null,
    getStoredMainModel: () => 'main-model-id',
  })
  // 降级为真实主模型 ID 仍优于现状（不发出字面 'haiku'）
  expect(committed.mainLoopModelForSession).toBe('main-model-id')
})

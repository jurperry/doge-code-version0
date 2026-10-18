import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

// 集成测试：用临时 CLAUDE_CONFIG_DIR 隔离真实的 .claude.json/.credentials.json。
// 产物写入仓库 test/ 目录（开发纪律），测试结束清理。
const TMP_CONFIG_DIR = join(process.cwd(), 'test', 'tier-restore-config')
/** Auth env vars shadow credentials; isolate them so the healing scenario is deterministic. */
const AUTH_ENV_KEYS = [
  'DOGE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const
const savedAuthEnv = new Map<string, string | undefined>()

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR
  mkdirSync(TMP_CONFIG_DIR, { recursive: true })
  for (const key of AUTH_ENV_KEYS) {
    savedAuthEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterAll(() => {
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(TMP_CONFIG_DIR, { recursive: true, force: true })
  for (const key of AUTH_ENV_KEYS) {
    const value = savedAuthEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function writeCredentials(data: Record<string, unknown>): void {
  writeFileSync(join(TMP_CONFIG_DIR, '.credentials.json'), JSON.stringify(data))
}

function readCredentials(): Record<string, any> {
  const p = join(TMP_CONFIG_DIR, '.credentials.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}

beforeEach(async () => {
  rmSync(TMP_CONFIG_DIR, { recursive: true, force: true })
  mkdirSync(TMP_CONFIG_DIR, { recursive: true })
  delete process.env.ANTHROPIC_MODEL
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  await resetGlobalConfig()
})

// NODE_ENV=test 时 getGlobalConfig/saveGlobalConfig 走内存对象
// TEST_GLOBAL_CONFIG_FOR_TESTING，不落盘 —— .claude.json 侧断言用
// getGlobalConfig() 读回（与生产语义等价：同一缓存对象）。
async function readGlobalConfig(): Promise<Record<string, any>> {
  const { getGlobalConfig } = await import('../config.js')
  return getGlobalConfig() as Record<string, any>
}

async function resetGlobalConfig(): Promise<void> {
  const { saveGlobalConfig } = await import('../config.js')
  saveGlobalConfig((c: any) => ({ ...c, customApiEndpoint: undefined }))
}

// ── clearLegacyTierState ────────────────────────────────────────────

test('clearLegacyTierState — scrubs activeTier/tierModels from secure storage + .claude.json, keeps the rest', async () => {
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      apiKey: 'sk-keep',
      activeTier: 'haiku',
      tierModels: { opus: 'deepseek-v4-pro[1m]', haiku: 'deepseek-v4-flash' },
    },
  })
  const { saveGlobalConfig } = await import('../config.js')
  saveGlobalConfig((c: any) => ({
    ...c,
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      apiKey: 'sk-keep',
      activeTier: 'haiku',
      tierModels: { haiku: 'deepseek-v4-flash' },
    },
  }))

  const { clearLegacyTierState } = await import('../customApiStorage.js')
  clearLegacyTierState()

  const stored = readCredentials().customApiEndpoint
  expect(stored.activeTier).toBeUndefined()
  expect(stored.tierModels).toBeUndefined()
  expect(stored.model).toBe('deepseek-v4-pro[1m]')
  expect(stored.apiKey).toBe('sk-keep')

  const claudeJson = (await readGlobalConfig()).customApiEndpoint
  expect(claudeJson.activeTier).toBeUndefined()
  expect(claudeJson.tierModels).toBeUndefined()
  expect(claudeJson.model).toBe('deepseek-v4-pro[1m]')
})

test('clearLegacyTierState — no-op when no legacy fields are present', async () => {
  writeCredentials({
    customApiEndpoint: { model: 'glm-5.3', apiKey: 'sk-ok' },
  })
  const { clearLegacyTierState } = await import('../customApiStorage.js')
  expect(() => clearLegacyTierState()).not.toThrow()
  expect(readCredentials().customApiEndpoint.model).toBe('glm-5.3')
})

// ── restoreTierStateFromStorage（2026-09-07 重构后语义） ──────────────

test('restoreTierStateFromStorage — injects tier env from the ACTIVE PROFILE only; activeTier no longer hijacks the main model', async () => {
  // 旧版遗留状态：activeTier/tierModels 指向别的终端选过的档位。
  // 重构后：档位 env 只来自主模型自己的 profile，且绝不注入
  // ANTHROPIC_MODEL（否则新终端直接跑在别的终端选的档位模型上 ——
  // 跨终端 custom model 污染 bug）。
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      activeTier: 'haiku',
      tierModels: {
        opus: 'STALE-opus',
        sonnet: 'STALE-sonnet',
        haiku: 'STALE-haiku',
      },
      modelProfiles: [
        {
          model: 'deepseek-v4-pro[1m]',
          defaultOpusModel: 'deepseek-v4-pro[1m]',
          defaultSonnetModel: 'deepseek-v4-pro[1m]',
          defaultHaikuModel: 'deepseek-v4-flash',
        },
      ],
    },
  })

  const { restoreTierStateFromStorage } = await import('./restoreTierState.js')
  restoreTierStateFromStorage()

  // profile 字段生效，全局快照被忽略
  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro[1m]')
  expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro[1m]')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
  // 关键回归：activeTier 不再把主循环模型劫持成档位模型
  expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
  // 启动迁移：遗留全局档位字段被从 secure storage 抹掉
  const stored = readCredentials().customApiEndpoint
  expect(stored.activeTier).toBeUndefined()
  expect(stored.tierModels).toBeUndefined()
  expect(stored.model).toBe('deepseek-v4-pro[1m]')
})

test('restoreTierStateFromStorage — start-script env wins, never overwritten', async () => {
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      modelProfiles: [
        {
          model: 'deepseek-v4-pro[1m]',
          defaultOpusModel: 'stored-opus',
          defaultHaikuModel: 'stored-haiku',
        },
      ],
    },
  })
  process.env.ANTHROPIC_MODEL = 'script-main'
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'script-opus'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'script-haiku'

  const { restoreTierStateFromStorage } = await import('./restoreTierState.js')
  restoreTierStateFromStorage()

  expect(process.env.ANTHROPIC_MODEL).toBe('script-main')
  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('script-opus')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('script-haiku')
  // profile 里没有 sonnet 配置 → 不注入（不作假的显式 tier 配置）
  expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
})

test('restoreTierStateFromStorage — bare launch with no start-script env injects profile tiers', async () => {
  writeCredentials({
    customApiEndpoint: {
      model: 'glm-5.3',
      modelProfiles: [
        {
          model: 'glm-5.3',
          defaultOpusModel: 'glm-5.3',
          defaultSonnetModel: 'glm-5.3',
          defaultHaikuModel: 'glm-5.3-flash',
        },
      ],
    },
  })

  const { restoreTierStateFromStorage } = await import('./restoreTierState.js')
  restoreTierStateFromStorage()

  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3')
  expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash')
  // 主循环模型走 settings/env 链，恢复逻辑不再代选
  expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
})

test('restoreTierStateFromStorage — no custom config → no-op', async () => {
  const { restoreTierStateFromStorage } = await import('./restoreTierState.js')
  expect(() => restoreTierStateFromStorage()).not.toThrow()
  expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
})

test('healStoredCredentials — repairs top-level credentials wiped by profile switch', async () => {
  // 模拟用户被清空的状态：顶层凭证全空，但 modelProfiles 完好。
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      savedModels: ['glm-5.3'],
      modelProfiles: [
        {
          model: 'deepseek-v4-pro[1m]',
          provider: 'openai',
          baseURL: 'https://relay.test/v1',
          apiKey: 'sk-heal',
          authTokenType: 'DOGE_API_KEY',
        },
      ],
    },
  })

  const { healStoredCredentials, readCustomApiStorage } = await import('../customApiStorage.js')
  expect(healStoredCredentials()).toBe(true)

  const healed = readCustomApiStorage()
  expect(healed.apiKey).toBe('sk-heal')
  expect(healed.provider).toBe('openai')
  expect(healed.baseURL).toBe('https://relay.test/v1')
  expect(healed.authTokenType).toBe('DOGE_API_KEY')
  expect(healed.model).toBe('deepseek-v4-pro[1m]')

  // 回归：自愈运行在 enableConfigs() 之前的启动期，绝不能触碰全局 config
  // （config 守卫未解锁时 saveGlobalConfig 会直接崩掉 CLI）。
  const { getGlobalConfig } = await import('../config.js')
  expect((getGlobalConfig() as any).customApiEndpoint?.apiKey).toBeUndefined()
})

test('healStoredCredentials — no-op when credentials already match the profile', async () => {
  writeCredentials({
    customApiEndpoint: {
      model: 'glm-5.3',
      provider: 'anthropic',
      baseURL: 'https://glm.test/v1',
      apiKey: 'sk-ok',
      authTokenType: 'DOGE_API_KEY',
      modelProfiles: [
        {
          model: 'glm-5.3',
          provider: 'anthropic',
          baseURL: 'https://glm.test/v1',
          apiKey: 'sk-ok',
          authTokenType: 'DOGE_API_KEY',
        },
      ],
    },
  })

  const { healStoredCredentials, readCustomApiStorage } = await import('../customApiStorage.js')
  expect(healStoredCredentials()).toBe(false)
  // 不应产生写入副作用
  expect(readCustomApiStorage().apiKey).toBe('sk-ok')
})

test('healStoredCredentials — no profile or cred-less profile → no-op', async () => {
  writeCredentials({
    customApiEndpoint: {
      model: 'unknown-model',
      modelProfiles: [],
    },
  })
  const { healStoredCredentials } = await import('../customApiStorage.js')
  expect(healStoredCredentials()).toBe(false)

  writeCredentials({
    customApiEndpoint: {
      model: 'no-key-model',
      modelProfiles: [{ model: 'no-key-model', provider: 'anthropic' }],
    },
  })
  expect(healStoredCredentials()).toBe(false)
})

test('restoreTierStateFromStorage — heals wiped credentials end-to-end (user scenario)', async () => {
  // 用户实际场景：profile 切换清空顶层凭证 → 裸 doge 重启 → Not logged in。
  // 启动自愈后 getAnthropicApiKeyWithSource 应能取到 key。
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      tierModels: { opus: 'deepseek-v4-pro[1m]', haiku: 'deepseek-v4-flash' },
      modelProfiles: [
        {
          model: 'deepseek-v4-pro[1m]',
          provider: 'openai',
          baseURL: 'https://relay.test/v1',
          apiKey: 'sk-user',
          authTokenType: 'DOGE_API_KEY',
        },
      ],
    },
  })

  const { restoreTierStateFromStorage } = await import('./restoreTierState.js')
  restoreTierStateFromStorage()

  const { getAnthropicApiKeyWithSource } = await import('../auth.js')
  const { key, source } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  expect(key).toBe('sk-user')
  expect(source).toBe('DOGE_API_KEY')
})

test('restoreTierStateFromStorage — main model without any tier config injects NOTHING (no fake explicit tiers)', async () => {
  // 回归：主模型无 profile、无 tier 配置。若把主模型当作 tier 配置注入
  // env，/model 里三个 tier 会全部显示成主模型并带 (current) 标记。
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-flash',
      savedModels: ['glm-5.3'],
      modelProfiles: [],
    },
  })

  const { restoreTierStateFromStorage } = await import('./restoreTierState.js')
  restoreTierStateFromStorage()

  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
  expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
  expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
})

test('applyModelProfile — clears deprecated global tier state on persist', async () => {
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      activeTier: 'haiku',
      tierModels: { opus: 'deepseek-v4-pro[1m]', haiku: 'deepseek-v4-flash' },
    },
  })

  const { applyModelProfile } = await import('../customApiStorage.js')
  applyModelProfile({
    model: 'glm-5.3',
    defaultOpusModel: 'glm-5.3',
    defaultHaikuModel: 'glm-5.3-flash',
  })

  const stored = readCredentials().customApiEndpoint
  expect(stored.model).toBe('glm-5.3')
  // 档位映射只存在于 profile 自身字段；全局快照不再刷新（一并清除）
  expect(stored.activeTier).toBeUndefined()
  expect(stored.tierModels).toBeUndefined()
})

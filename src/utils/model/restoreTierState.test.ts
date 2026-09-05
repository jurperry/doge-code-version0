import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

// 集成测试：用临时 CLAUDE_CONFIG_DIR 隔离真实的 .claude.json/.credentials.json。
// 产物写入仓库 test/ 目录（开发纪律），测试结束清理。
const TMP_CONFIG_DIR = join(process.cwd(), 'test', 'tier-restore-config')

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR
  mkdirSync(TMP_CONFIG_DIR, { recursive: true })
})

afterAll(() => {
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(TMP_CONFIG_DIR, { recursive: true, force: true })
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

test('persistTierSelection(haiku) — writes activeTier + snapshot, keeps main model & credentials', async () => {
  // 生产中 .credentials.json 与 .claude.json 由 syncModelConfigToDisk 双写
  // 保持同步，两侧都预置相同的 customApiEndpoint。
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      provider: 'openai',
      apiKey: 'sk-keep',
      savedModels: ['glm-5.3'],
      modelProfiles: [],
    },
  })
  const { saveGlobalConfig } = await import('../config.js')
  saveGlobalConfig((c: any) => ({
    ...c,
    customApiEndpoint: { model: 'deepseek-v4-pro[1m]', provider: 'openai', apiKey: 'sk-keep' },
  }))

  const { persistTierSelection } = await import('../customApiStorage.js')
  persistTierSelection('haiku', {
    opus: 'deepseek-v4-pro[1m]',
    sonnet: 'deepseek-v4-pro[1m]',
    haiku: 'deepseek-v4-flash',
  })

  const stored = readCredentials().customApiEndpoint
  expect(stored.activeTier).toBe('haiku')
  expect(stored.tierModels).toEqual({
    opus: 'deepseek-v4-pro[1m]',
    sonnet: 'deepseek-v4-pro[1m]',
    haiku: 'deepseek-v4-flash',
  })
  // 主模型槽位与凭证不受层级切换影响（旧 bug：主模型被写成 tier 模型）
  expect(stored.model).toBe('deepseek-v4-pro[1m]')
  expect(stored.apiKey).toBe('sk-keep')

  const claudeJson = (await readGlobalConfig()).customApiEndpoint
  expect(claudeJson.activeTier).toBe('haiku')
  expect(claudeJson.model).toBe('deepseek-v4-pro[1m]')
})

test('persistTierSelection(null) — clears activeTier, keeps tier snapshot', async () => {
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      activeTier: 'haiku',
      tierModels: { opus: 'deepseek-v4-pro[1m]', haiku: 'deepseek-v4-flash' },
    },
  })

  const { persistTierSelection } = await import('../customApiStorage.js')
  // env 全空 → 快照为空 → 保留旧快照
  persistTierSelection(null)

  const stored = readCredentials().customApiEndpoint
  expect(stored.activeTier).toBeUndefined()
  expect(stored.tierModels).toEqual({ opus: 'deepseek-v4-pro[1m]', haiku: 'deepseek-v4-flash' })
  expect(stored.model).toBe('deepseek-v4-pro[1m]')
})

test('persistTierSelection defaults snapshot from current env', async () => {
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.7'
  const { persistTierSelection } = await import('../customApiStorage.js')
  persistTierSelection('haiku')

  const stored = readCredentials().customApiEndpoint
  expect(stored.activeTier).toBe('haiku')
  expect(stored.tierModels.haiku).toBe('glm-4.7')
})

test('restoreTierStateFromStorage — injects tier env + tier-selected main model when env empty', async () => {
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      activeTier: 'haiku',
      tierModels: {
        opus: 'deepseek-v4-pro[1m]',
        sonnet: 'deepseek-v4-pro[1m]',
        haiku: 'deepseek-v4-flash',
      },
    },
  })

  const { restoreTierStateFromStorage } = await import('./restoreTierState.js')
  restoreTierStateFromStorage()

  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro[1m]')
  expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro[1m]')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
  // activeTier=haiku → 主循环模型跟随 haiku 层
  expect(process.env.ANTHROPIC_MODEL).toBe('deepseek-v4-flash')
})

test('restoreTierStateFromStorage — start-script env wins, never overwritten', async () => {
  writeCredentials({
    customApiEndpoint: {
      model: 'deepseek-v4-pro[1m]',
      activeTier: 'opus',
      tierModels: { opus: 'stored-opus', haiku: 'stored-haiku' },
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
  // 快照里没有 sonnet 配置 → 不注入（主模型不作假的显式 tier 配置）
  expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
})

test('restoreTierStateFromStorage — falls back to main-model profile when no snapshot', async () => {
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
  // 无 activeTier → 不注入 ANTHROPIC_MODEL（主循环模型走 settings 链）
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
      activeTier: undefined,
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
  // 回归：主模型无 profile、无 tierModels 快照（旧 bug 污染后的典型状态）。
  // 若把主模型当作 tier 配置注入 env，/model 里三个 tier 会全部显示成
  // 主模型并带 (current) 标记 —— 正是要修的显示混乱。
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

test('applyModelProfile — resets activeTier and refreshes tier snapshot from profile', async () => {
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
  expect(stored.activeTier).toBeUndefined()
  expect(stored.tierModels).toEqual({ opus: 'glm-5.3', haiku: 'glm-5.3-flash' })
})

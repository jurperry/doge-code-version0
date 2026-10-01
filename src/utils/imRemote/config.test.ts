import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'fs/promises'
import { join } from 'path'
import {
  generatePairCode,
  imRemoteConfigReady,
  imRemoteWebReady,
  normalizeImRemoteConfig,
  normalizeImRemoteWebConfig,
  PAIR_CODE_TTL_MS,
  saveImRemoteConfig,
  loadImRemoteConfig,
  saveImRemoteWebConfig,
  loadImRemoteWebConfig,
} from './config.js'

const SANDBOX = join(import.meta.dir, 'config.test.tmp')

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DOGE_IM_REMOTE_CONFIG
  const prevWeb = process.env.DOGE_IM_REMOTE_WEB_CONFIG
  process.env.DOGE_IM_REMOTE_CONFIG = join(SANDBOX, 'im-remote.json')
  process.env.DOGE_IM_REMOTE_WEB_CONFIG = join(SANDBOX, 'im-remote-web.json')
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.DOGE_IM_REMOTE_CONFIG
    else process.env.DOGE_IM_REMOTE_CONFIG = prev
    if (prevWeb === undefined) delete process.env.DOGE_IM_REMOTE_WEB_CONFIG
    else process.env.DOGE_IM_REMOTE_WEB_CONFIG = prevWeb
  }
}

afterEach(async () => {
  await rm(SANDBOX, { recursive: true, force: true }).catch(() => {})
})

describe('normalizeImRemoteConfig', () => {
  test('fills defaults and drops junk', () => {
    const cfg = normalizeImRemoteConfig({
      platform: 'feishu',
      enabled: true,
      allowedUsers: ['u1', 42, null],
      summaryEvery: 'bogus',
      port: 99999,
      nope: 'dropped',
      feishu: { appId: 'a', appSecret: 's', chatId: 'c', apiBase: 'http://x/' },
    })
    expect(cfg).not.toBeNull()
    expect(cfg!.summaryEvery).toBe(10)
    expect(cfg!.port).toBe(4763)
    expect(cfg!.allowedUsers).toEqual(['u1'])
    expect(cfg!.autoMode).toBeTrue()
    expect(cfg!.feishu?.apiBase).toBe('http://x/')
    expect('nope' in cfg!).toBeFalse()
  })

  test('rejects non-objects and short tokens get regenerated on save', () => {
    expect(normalizeImRemoteConfig(null)).toBeNull()
    expect(normalizeImRemoteConfig('x')).toBeNull()
    const cfg = normalizeImRemoteConfig({ token: 'short' })
    expect(cfg!.token).toBe('')
  })

  test('platform defaults to telegram; readiness needs credentials', () => {
    expect(normalizeImRemoteConfig({})!.platform).toBe('telegram')
    expect(imRemoteConfigReady(normalizeImRemoteConfig({})!)).toBeFalse()
    expect(
      imRemoteConfigReady(normalizeImRemoteConfig({ telegram: { botToken: 't' } })!),
    ).toBeTrue()
    expect(
      imRemoteConfigReady(
        normalizeImRemoteConfig({ platform: 'feishu', feishu: { appId: 'a' } })!,
      ),
    ).toBeFalse()
  })

  test('wecom platform normalizes and gates readiness on both credentials', () => {
    const cfg = normalizeImRemoteConfig({
      platform: 'wecom',
      wecom: { botId: 'b1', secret: 's1' },
    })!
    expect(cfg.platform).toBe('wecom')
    expect(cfg.wecom?.botId).toBe('b1')
    expect(cfg.wecom?.wsBase).toBeUndefined()
    expect(imRemoteConfigReady(cfg)).toBeTrue()
    expect(
      imRemoteConfigReady(normalizeImRemoteConfig({ platform: 'wecom', wecom: { botId: 'b1' } })!),
    ).toBeFalse()
    // 未知平台值回落 telegram，不误入 wecom 分支
    expect(normalizeImRemoteConfig({ platform: 'qq' })!.platform).toBe('telegram')
  })
})

describe('web channel config (separate file)', () => {
  test('normalize fills defaults; readiness needs enabled + token', () => {
    const cfg = normalizeImRemoteWebConfig({})
    expect(cfg).not.toBeNull()
    expect(cfg!.port).toBe(4764)
    expect(cfg!.enabled).toBeFalse()
    expect(cfg!.token).toBe('')
    expect(imRemoteWebReady(cfg!)).toBeFalse()
    expect(imRemoteWebReady(normalizeImRemoteWebConfig({ enabled: true, token: 'x'.repeat(24) })!)).toBeTrue()
    // 端口清洗：非法值回落 4764，不串到主配置的 4763
    expect(normalizeImRemoteWebConfig({ port: 99999 })!.port).toBe(4764)
    expect(normalizeImRemoteWebConfig(null)).toBeNull()
  })

  test('save/load round-trips and mints token; stays a separate file', async () => {
    await withEnv(async () => {
      const cfg = normalizeImRemoteWebConfig({ enabled: true, port: 4800 })!
      await saveImRemoteWebConfig(cfg)
      const loaded = await loadImRemoteWebConfig()
      expect(loaded).not.toBeNull()
      expect(loaded!.enabled).toBeTrue()
      expect(loaded!.port).toBe(4800)
      expect(loaded!.token.length).toBeGreaterThanOrEqual(16)
      // 互不污染：主配置仍不存在
      expect(await loadImRemoteConfig()).toBeNull()
    })
  })
})

describe('config persistence', () => {
  test('save then load round-trips and mints a token', async () => {
    await withEnv(async () => {
      const cfg = normalizeImRemoteConfig({ enabled: true })!
      await saveImRemoteConfig(cfg)
      const loaded = await loadImRemoteConfig()
      expect(loaded).not.toBeNull()
      expect(loaded!.enabled).toBeTrue()
      expect(loaded!.token.length).toBeGreaterThanOrEqual(16)
    })
  })

  test('missing file loads null', async () => {
    await withEnv(async () => {
      expect(await loadImRemoteConfig()).toBeNull()
    })
  })
})

describe('pair codes', () => {
  test('shape and TTL constant', () => {
    const code = generatePairCode()
    expect(code).toMatch(/^[a-z0-9]{6}$/)
    expect(PAIR_CODE_TTL_MS).toBe(60 * 60 * 1000)
  })
})

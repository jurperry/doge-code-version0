import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'fs/promises'
import { join } from 'path'
import {
  generatePairCode,
  imRemoteConfigReady,
  normalizeImRemoteConfig,
  PAIR_CODE_TTL_MS,
  saveImRemoteConfig,
  loadImRemoteConfig,
} from './config.js'

const SANDBOX = join(import.meta.dir, 'config.test.tmp')

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DOGE_IM_REMOTE_CONFIG
  process.env.DOGE_IM_REMOTE_CONFIG = join(SANDBOX, 'im-remote.json')
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.DOGE_IM_REMOTE_CONFIG
    else process.env.DOGE_IM_REMOTE_CONFIG = prev
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

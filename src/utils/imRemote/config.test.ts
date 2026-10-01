import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'fs/promises'
import { join } from 'path'
import {
  allowedUsersFor,
  canConsumePair,
  feishuReady,
  generatePairCode,
  imRemoteConfigReady,
  pairCodeFor,
  selectBotPlatforms,
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
      allowedUsersByPlatform: { telegram: ['u1', 42, null], feishu: [] },
      summaryEvery: 'bogus',
      port: 99999,
      nope: 'dropped',
      feishu: { appId: 'a', appSecret: 's', chatId: 'c', apiBase: 'http://x/' },
    })
    expect(cfg).not.toBeNull()
    expect(cfg!.summaryEvery).toBe(10)
    expect(cfg!.port).toBe(4763)
    expect(cfg!.allowedUsersByPlatform).toEqual({ telegram: ['u1'] })
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

describe('per-platform pairing state (2.1.274)', () => {
  test('pairs normalize per platform; junk codes/shapes dropped', () => {
    const now = Date.now()
    const cfg = normalizeImRemoteConfig({
      telegram: { botToken: 't' },
      feishu: { appId: 'a', appSecret: 's' },
      pairs: {
        telegram: { code: 'ab3x9k', expires: now + 1000 },
        feishu: { code: 'TOOLONG7', expires: now + 1000 },
        wecom: { code: 'cd34gh', expires: 'bogus' },
        nonsense: { code: 'zzzz99', expires: now + 1000 },
      },
    })!
    // 非平台键与非法码被丢；expires 归一为 0（过期）但条目保留——过期判定
    // 归 pairCodeFor（读取时），归一化层不改写数据
    expect(Object.keys(cfg.pairs ?? {}).sort()).toEqual(['telegram', 'wecom'])
    expect(cfg.pairs?.telegram?.code).toBe('ab3x9k')
    expect(cfg.pairs?.wecom?.expires).toBe(0)
    expect(pairCodeFor(cfg, 'telegram')).toBe('ab3x9k')
    expect(pairCodeFor(cfg, 'wecom')).toBeNull()
    // 过期 → null；未铸 → null
    const expired = normalizeImRemoteConfig({
      telegram: { botToken: 't' },
      pairs: { telegram: { code: 'ab3x9k', expires: now - 1 } },
    })!
    expect(pairCodeFor(expired, 'telegram')).toBeNull()
    expect(pairCodeFor(cfg, 'wecom')).toBeNull()
  })

  test('legacy global allowedUsers migrates only when exactly ONE platform is credentialed', () => {
    // 单平台（绝大多数用户）：无歧义，无损迁移
    const single = normalizeImRemoteConfig({
      telegram: { botToken: 't' },
      allowedUsers: ['4242', 42],
    })!
    expect(single.allowedUsersByPlatform).toEqual({ telegram: ['4242'] })
    // 多平台：属主无法推断 → 作废（重新配对一次）
    const multi = normalizeImRemoteConfig({
      telegram: { botToken: 't' },
      feishu: { appId: 'a', appSecret: 's' },
      allowedUsers: ['4242'],
    })!
    expect(multi.allowedUsersByPlatform).toEqual({})
    // 新键在场时 legacy 键被忽略（新键优先，勿叠加）
    const preferred = normalizeImRemoteConfig({
      telegram: { botToken: 't' },
      allowedUsers: ['legacy-user'],
      allowedUsersByPlatform: { telegram: ['new-user'] },
    })!
    expect(preferred.allowedUsersByPlatform).toEqual({ telegram: ['new-user'] })
  })

  test('legacy global pair is dropped outright; daemon re-mints per platform', () => {
    const cfg = normalizeImRemoteConfig({
      telegram: { botToken: 't' },
      pair: { code: 'ab3x9k', expires: Date.now() + 1000 },
    })!
    expect(cfg.pairs).toEqual({})
    expect(pairCodeFor(cfg, 'telegram')).toBeNull()
  })

  test('canConsumePair：验码即耗码的原子门（同码二次必拒，磁盘复活也拦住）', () => {
    const now = Date.now()
    const pair = { code: 'ab3x9k', expires: now + 1000 }
    const consumed = new Set<string>()
    // 首验通过；随后（调用方立即）入集合
    expect(canConsumePair(pair, 'telegram', 'ab3x9k', consumed, now)).toBeTrue()
    consumed.add('telegram:ab3x9k')
    // 同码二次（哪怕磁盘重读把码复活回内存）必拒——TOCTOU 根修
    expect(canConsumePair(pair, 'telegram', 'ab3x9k', consumed, now)).toBeFalse()
    // 集合按平台分键：飞书的同值码不受 telegram 已耗影响
    expect(canConsumePair(pair, 'feishu', 'ab3x9k', consumed, now)).toBeTrue()
    // 码本身无效仍拒
    expect(canConsumePair(pair, 'telegram', 'zzzz99', consumed, now)).toBeFalse()
    expect(canConsumePair(undefined, 'telegram', 'ab3x9k', consumed, now)).toBeFalse()
  })

  test('allowedUsersFor reads per platform; save/load round-trips the new shape', async () => {
    await withEnv(async () => {
      const cfg = normalizeImRemoteConfig({
        enabled: true,
        telegram: { botToken: 't' },
        wecom: { botId: 'b', secret: 's' },
        allowedUsersByPlatform: { telegram: ['42'], wecom: ['wecom-user'] },
        outboundChats: { telegram: '900', wecom: 42, nonsense: 'x' },
      })!
      expect(allowedUsersFor(cfg, 'telegram')).toEqual(['42'])
      expect(allowedUsersFor(cfg, 'wecom')).toEqual(['wecom-user'])
      expect(allowedUsersFor(cfg, 'feishu')).toEqual([])
      // 出站绑定：字符串留、非字符串与非平台键丢
      expect(cfg.outboundChats).toEqual({ telegram: '900' })
      await saveImRemoteConfig(cfg)
      const loaded = await loadImRemoteConfig()
      expect(loaded!.allowedUsersByPlatform).toEqual({ telegram: ['42'], wecom: ['wecom-user'] })
      expect(loaded!.outboundChats).toEqual({ telegram: '900' })
    })
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

describe('wecom botLink (cross-network scan entry)', () => {
  test('http(s) URLs pass through trimmed; anything else drops to undefined', () => {
    const cfg = normalizeImRemoteConfig({
      platform: 'wecom',
      wecom: { botId: 'b1', secret: 's1', botLink: '  https://work.weixin.qq.com/ca/abc  ' },
    })!
    expect(cfg.wecom?.botLink).toBe('https://work.weixin.qq.com/ca/abc')

    expect(normalizeImRemoteConfig({ platform: 'wecom', wecom: { botId: 'b1', secret: 's1', botLink: 'work.weixin.qq.com/ca' } })!.wecom?.botLink).toBeUndefined()
    expect(normalizeImRemoteConfig({ platform: 'wecom', wecom: { botId: 'b1', secret: 's1', botLink: 'ftp://x/y' } })!.wecom?.botLink).toBeUndefined()
    expect(normalizeImRemoteConfig({ platform: 'wecom', wecom: { botId: 'b1', secret: 's1', botLink: 42 } })!.wecom?.botLink).toBeUndefined()
  })
})

describe('selectBotPlatforms（2.1.272 多平台并发）', () => {
  test('凭据齐备的平台全选、顺序稳定；platform 字段不再决定启停', () => {
    const cfg = normalizeImRemoteConfig({
      enabled: true,
      platform: 'telegram',
      telegram: { botToken: 't1' },
      feishu: { appId: 'cli_x', appSecret: 's' },
      wecom: { botId: 'b1', secret: 's1' },
    })!
    expect(selectBotPlatforms(cfg)).toEqual(['telegram', 'feishu', 'wecom'])
    expect(imRemoteConfigReady(cfg)).toBeTrue()
    // 单凭据也启动（只配飞书 + platform 字段还写着 telegram）
    const fsOnly = normalizeImRemoteConfig({ platform: 'telegram', feishu: { appId: 'a', appSecret: 's' } })!
    expect(selectBotPlatforms(fsOnly)).toEqual(['feishu'])
  })

  test('飞书不再强制 chatId（首条入站自动绑定）；不完整凭据不选', () => {
    expect(feishuReady(normalizeImRemoteConfig({ feishu: { appId: 'a', appSecret: 's' } })!)).toBeTrue()
    expect(selectBotPlatforms(normalizeImRemoteConfig({ feishu: { appId: 'a' } })!)).toEqual([])
    expect(selectBotPlatforms(normalizeImRemoteConfig({ wecom: { botId: 'b' } })!)).toEqual([])
    expect(imRemoteConfigReady(normalizeImRemoteConfig({})!)).toBeFalse()
  })
})

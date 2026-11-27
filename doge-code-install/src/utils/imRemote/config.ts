import { randomBytes, randomInt } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { isPairCodeValid } from './format.js'
import type {
  ImPlatform,
  ImPlatformAllowedUsers,
  ImPlatformPairs,
  ImRemoteConfig,
  ImRemotePairState,
  ImRemoteWebConfig,
} from './types.js'

const CONFIG_NAME = 'im-remote.json'
const WEB_CONFIG_NAME = 'im-remote-web.json'

export function imRemoteConfigPath(): string {
  return process.env.DOGE_IM_REMOTE_CONFIG ?? join(getClaudeConfigHomeDir(), CONFIG_NAME)
}

export function imRemoteWebConfigPath(): string {
  return process.env.DOGE_IM_REMOTE_WEB_CONFIG ?? join(getClaudeConfigHomeDir(), WEB_CONFIG_NAME)
}

const DEFAULT_SUMMARY_EVERY = 10
const DEFAULT_PORT = 4763

function sanitizePort(value: unknown, fallback: number = DEFAULT_PORT): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1024 || n > 65535) {
    return fallback
  }
  return n
}

/** bot 平台全集（顺序稳定：TG → 飞书 → 企微）——归一化与帧校验共用。 */
export const BOT_PLATFORMS: readonly ImPlatform[] = ['telegram', 'feishu', 'wecom']

function normalizePairs(raw: unknown): ImPlatformPairs {
  const out: ImPlatformPairs = {}
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  for (const p of BOT_PLATFORMS) {
    const st = r[p]
    if (st && typeof st === 'object' && typeof (st as any).code === 'string') {
      const code = String((st as any).code)
      const expires = Number((st as any).expires) || 0
      if (/^[a-z0-9]{6}$/.test(code)) out[p] = { code, expires }
    }
  }
  return out
}

function normalizeAllowedByPlatform(raw: unknown): ImPlatformAllowedUsers {
  const out: ImPlatformAllowedUsers = {}
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  for (const p of BOT_PLATFORMS) {
    const list = r[p]
    if (!Array.isArray(list)) continue
    const users = list.filter((u): u is string => typeof u === 'string')
    if (users.length > 0) out[p] = users
  }
  return out
}

function normalizeOutboundChats(raw: unknown): Partial<Record<ImPlatform, string>> {
  const out: Partial<Record<ImPlatform, string>> = {}
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  for (const p of BOT_PLATFORMS) {
    const chat = r[p]
    if (typeof chat === 'string' && chat) out[p] = chat
  }
  return out
}

/**
 * Parse + normalize a raw config object. Unknown keys are dropped so a
 * hand-edited file cannot smuggle junk into the daemon. Returns null when
 * the payload is not an object.
 *
 * Legacy migration (2.1.274, pairing became per-platform):
 *  - legacy global `allowedUsers` is attributed to the one platform with
 *    complete credentials when exactly ONE is configured (unambiguous);
 *    with multiple platforms the owner can't be inferred, so it is dropped;
 *  - legacy global `pair` is dropped outright — a global code has no
 *    platform owner, and the daemon re-mints per-platform codes at startup.
 */
export function normalizeImRemoteConfig(raw: unknown): ImRemoteConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const platform =
    r.platform === 'feishu' || r.platform === 'wecom' ? r.platform : 'telegram'
  const token = typeof r.token === 'string' && r.token.length >= 16 ? r.token : ''
  const telegram = r.telegram && typeof r.telegram === 'object' ? telegramConfig(r.telegram) : undefined
  const feishu = r.feishu && typeof r.feishu === 'object' ? feishuConfig(r.feishu) : undefined
  const wecom = r.wecom && typeof r.wecom === 'object' ? wecomConfig(r.wecom) : undefined
  const partial = {
    version: 1 as const,
    enabled: r.enabled === true,
    platform,
    telegram,
    feishu,
    wecom,
    autoMode: r.autoMode !== false,
    summaryEvery: Number.isFinite(Number(r.summaryEvery)) && Number(r.summaryEvery) > 0
      ? Math.min(100, Math.floor(Number(r.summaryEvery)))
      : DEFAULT_SUMMARY_EVERY,
    port: sanitizePort(r.port),
    token,
  }
  const base: ImRemoteConfig = {
    ...partial,
    allowedUsersByPlatform: {},
    pairs: {},
  }
  let allowedBy = normalizeAllowedByPlatform(r.allowedUsersByPlatform)
  if (Object.keys(allowedBy).length === 0 && Array.isArray(r.allowedUsers)) {
    const legacy = r.allowedUsers.filter((u): u is string => typeof u === 'string')
    if (legacy.length > 0) {
      const ready = selectBotPlatforms(base)
      if (ready.length === 1) allowedBy = { [ready[0]]: legacy }
    }
  }
  return {
    ...base,
    allowedUsersByPlatform: allowedBy,
    pairs: normalizePairs(r.pairs),
    outboundChats: normalizeOutboundChats(r.outboundChats),
  }
}

function telegramConfig(raw: Record<string, unknown>): ImRemoteConfig['telegram'] {
  return {
    botToken: String(raw.botToken ?? ''),
    apiBase: typeof raw.apiBase === 'string' && raw.apiBase ? raw.apiBase : undefined,
    chatId: typeof raw.chatId === 'string' && raw.chatId ? raw.chatId : undefined,
  }
}

function feishuConfig(raw: Record<string, unknown>): ImRemoteConfig['feishu'] {
  return {
    appId: String(raw.appId ?? ''),
    appSecret: String(raw.appSecret ?? ''),
    apiBase: typeof raw.apiBase === 'string' && raw.apiBase ? raw.apiBase : undefined,
    chatId: String(raw.chatId ?? ''),
  }
}

function wecomConfig(raw: Record<string, unknown>): ImRemoteConfig['wecom'] {
  // 深链必须是可解析的 http(s) URL——手滑粘进的说明文字/带控制字符的串直接
  // 丢掉，别渲染成坏二维码（new URL 比前缀正则多拦 URL 中部的非法字符）
  let botLink: string | undefined
  if (typeof raw.botLink === 'string' && /^https?:\/\//i.test(raw.botLink.trim())) {
    try {
      new URL(raw.botLink.trim())
      botLink = raw.botLink.trim()
    } catch {
      botLink = undefined
    }
  }
  return {
    botId: String(raw.botId ?? ''),
    secret: String(raw.secret ?? ''),
    wsBase: typeof raw.wsBase === 'string' && raw.wsBase ? raw.wsBase : undefined,
    botLink,
  }
}

/** Missing credentials for the selected platform (daemon refuses to start). */
export function imRemoteConfigReady(config: ImRemoteConfig): boolean {
  return selectBotPlatforms(config).length > 0
}

/** 逐平台凭据就绪判定（2.1.272 多平台并发）：配了谁就跑谁。飞书不再强制
 *  chatId——适配器对空 chatId 走「首条入站消息自动绑定」回退。 */
export function telegramReady(c: ImRemoteConfig): boolean {
  return !!c.telegram?.botToken
}
export function feishuReady(c: ImRemoteConfig): boolean {
  return !!(c.feishu?.appId && c.feishu?.appSecret)
}
export function wecomReady(c: ImRemoteConfig): boolean {
  return !!(c.wecom?.botId && c.wecom?.secret)
}

/** 凭据齐备、应当启动的 bot 平台列表（顺序稳定：TG → 飞书 → 企微）。 */
export function selectBotPlatforms(c: ImRemoteConfig): ImPlatform[] {
  const out: ImPlatform[] = []
  if (telegramReady(c)) out.push('telegram')
  if (feishuReady(c)) out.push('feishu')
  if (wecomReady(c)) out.push('wecom')
  return out
}

/** 该平台已配对、可控制会话的用户列表（2.1.274 起按平台分键）。 */
export function allowedUsersFor(c: ImRemoteConfig, platform: ImPlatform): string[] {
  return c.allowedUsersByPlatform?.[platform] ?? []
}

/** 该平台当前有效的配对码（过期/未铸 → null）。 */
export function pairCodeFor(c: ImRemoteConfig, platform: ImPlatform, now = Date.now()): string | null {
  const st: ImRemotePairState | undefined = c.pairs?.[platform]
  return st && st.expires > now ? st.code : null
}

/**
 * 配对门判定（2.1.274）：码对该平台有效，且未被本进程消耗过。`consumedKeys`
 * 封 TOCTOU——验证与持久化之间隔着 await（日志/写盘），同批第二条同码 /pair
 * 重读磁盘会把已耗的码在内存里复活；进程内已耗集合让「验码即耗码」成为
 * 原子决策（调用方验证通过后必须立即把 key 加进集合）。
 */
export function canConsumePair(
  pair: ImRemotePairState | null | undefined,
  platform: ImPlatform,
  code: string,
  consumedKeys: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  return !consumedKeys.has(platform + ':' + code.toLowerCase()) && isPairCodeValid(pair, code, now)
}

export async function loadImRemoteConfig(): Promise<ImRemoteConfig | null> {
  let raw: string
  try {
    raw = await readFile(imRemoteConfigPath(), 'utf8')
  } catch {
    return null
  }
  try {
    return normalizeImRemoteConfig(JSON.parse(raw))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// QR web channel config (separate file by design — see ImRemoteWebConfig)
// ---------------------------------------------------------------------------

const DEFAULT_WEB_PORT = 4764

export function normalizeImRemoteWebConfig(raw: unknown): ImRemoteWebConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const token = typeof r.token === 'string' && r.token.length >= 16 ? r.token : ''
  return {
    version: 1,
    enabled: r.enabled === true,
    port: sanitizePort(r.port, DEFAULT_WEB_PORT),
    token,
  }
}

export function imRemoteWebReady(config: ImRemoteWebConfig): boolean {
  return config.enabled && !!config.token
}

export async function loadImRemoteWebConfig(): Promise<ImRemoteWebConfig | null> {
  let raw: string
  try {
    raw = await readFile(imRemoteWebConfigPath(), 'utf8')
  } catch {
    return null
  }
  try {
    return normalizeImRemoteWebConfig(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function saveImRemoteWebConfig(config: ImRemoteWebConfig): Promise<void> {
  const next = { ...config }
  if (!next.token) {
    next.token = randomBytes(24).toString('hex')
  }
  await mkdir(configDirOf(imRemoteWebConfigPath()), { recursive: true }).catch(() => {})
  await writeFile(imRemoteWebConfigPath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
}

export async function saveImRemoteConfig(config: ImRemoteConfig): Promise<void> {
  const next = { ...config }
  if (!next.token) {
    next.token = randomBytes(24).toString('hex')
  }
  await mkdir(configDirOf(imRemoteConfigPath()), { recursive: true }).catch(() => {})
  await writeFile(imRemoteConfigPath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
}

function configDirOf(p: string): string {
  return dirname(p)
}

/** Six-char pairing code from the Crockford-ish letters-only alphabet. */
export function generatePairCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += alphabet[randomInt(alphabet.length)]
  }
  return code
}

export const PAIR_CODE_TTL_MS = 60 * 60 * 1000

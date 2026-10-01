import { randomBytes, randomInt } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { ImPlatform, ImRemoteConfig, ImRemoteWebConfig } from './types.js'

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

/**
 * Parse + normalize a raw config object. Unknown keys are dropped so a
 * hand-edited file cannot smuggle junk into the daemon. Returns null when
 * the payload is not an object.
 */
export function normalizeImRemoteConfig(raw: unknown): ImRemoteConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const platform =
    r.platform === 'feishu' || r.platform === 'wecom' ? r.platform : 'telegram'
  const token = typeof r.token === 'string' && r.token.length >= 16 ? r.token : ''
  const pair =
    r.pair && typeof r.pair === 'object' && typeof (r.pair as any).code === 'string'
      ? {
          code: String((r.pair as any).code),
          expires: Number((r.pair as any).expires) || 0,
        }
      : undefined
  const telegram = r.telegram && typeof r.telegram === 'object' ? telegramConfig(r.telegram) : undefined
  const feishu = r.feishu && typeof r.feishu === 'object' ? feishuConfig(r.feishu) : undefined
  const wecom = r.wecom && typeof r.wecom === 'object' ? wecomConfig(r.wecom) : undefined
  return {
    version: 1,
    enabled: r.enabled === true,
    platform,
    telegram,
    feishu,
    wecom,
    allowedUsers: Array.isArray(r.allowedUsers)
      ? r.allowedUsers.filter((u): u is string => typeof u === 'string')
      : [],
    autoMode: r.autoMode !== false,
    summaryEvery: Number.isFinite(Number(r.summaryEvery)) && Number(r.summaryEvery) > 0
      ? Math.min(100, Math.floor(Number(r.summaryEvery)))
      : DEFAULT_SUMMARY_EVERY,
    port: sanitizePort(r.port),
    token,
    pair,
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

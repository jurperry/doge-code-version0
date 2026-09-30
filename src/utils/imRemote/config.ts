import { randomBytes, randomInt } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { ImRemoteConfig } from './types.js'

const CONFIG_NAME = 'im-remote.json'

export function imRemoteConfigPath(): string {
  return process.env.DOGE_IM_REMOTE_CONFIG ?? join(getClaudeConfigHomeDir(), CONFIG_NAME)
}

const DEFAULT_SUMMARY_EVERY = 10
const DEFAULT_PORT = 4763

function sanitizePort(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n) || n < 1024 || n > 65535) {
    return DEFAULT_PORT
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
  const platform = r.platform === 'feishu' ? 'feishu' : 'telegram'
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
  return {
    version: 1,
    enabled: r.enabled === true,
    platform,
    telegram,
    feishu,
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

/** Missing credentials for the selected platform (daemon refuses to start). */
export function imRemoteConfigReady(config: ImRemoteConfig): boolean {
  if (config.platform === 'telegram') {
    return !!config.telegram?.botToken
  }
  return !!(config.feishu?.appId && config.feishu?.appSecret && config.feishu?.chatId)
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

export async function saveImRemoteConfig(config: ImRemoteConfig): Promise<void> {
  const next = { ...config }
  if (!next.token) {
    next.token = randomBytes(24).toString('hex')
  }
  await mkdir(imRemoteConfigDir(), { recursive: true }).catch(() => {})
  await writeFile(imRemoteConfigPath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
}

function imRemoteConfigDir(): string {
  const p = imRemoteConfigPath()
  return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))
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

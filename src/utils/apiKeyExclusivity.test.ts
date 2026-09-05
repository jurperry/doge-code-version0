import { test, expect, beforeEach, afterEach } from 'bun:test'
import {
  enforceApiKeyExclusivityWithDeps,
  resolveApiKeyConflict,
} from './apiKeyExclusivity.js'

const GUARDED_ENV_KEYS = [
  'DOGE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_ENTRYPOINT',
] as const

const noProfile = () => undefined

// Save & restore env around each test so they don't bleed.
let originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  originalEnv = {}
  for (const key of GUARDED_ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of GUARDED_ENV_KEYS) {
    const v = originalEnv[key]
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
  }
})

// --- resolveApiKeyConflict (pure arbitration) ---

test('resolveApiKeyConflict: no conflict when only one (or neither) key is set', () => {
  expect(resolveApiKeyConflict({ dogeKey: 'a', authKey: undefined })).toBeNull()
  expect(resolveApiKeyConflict({ dogeKey: undefined, authKey: 'b' })).toBeNull()
  expect(resolveApiKeyConflict({ dogeKey: undefined, authKey: undefined })).toBeNull()
})

test('resolveApiKeyConflict: DOGE_API_KEY wins by default when both are set', () => {
  expect(
    resolveApiKeyConflict({ dogeKey: 'a', authKey: 'b' }),
  ).toEqual({ keep: 'DOGE_API_KEY', remove: 'ANTHROPIC_AUTH_TOKEN' })
})

test('resolveApiKeyConflict: profile declaring ANTHROPIC_AUTH_TOKEN with a matching key flips the decision', () => {
  expect(
    resolveApiKeyConflict({
      dogeKey: 'a',
      authKey: 'b',
      profileApiKey: 'b',
      profileAuthTokenType: 'ANTHROPIC_AUTH_TOKEN',
    }),
  ).toEqual({ keep: 'ANTHROPIC_AUTH_TOKEN', remove: 'DOGE_API_KEY' })
})

test('resolveApiKeyConflict: profile key mismatch or DOGE-typed profile keeps DOGE winner', () => {
  // Profile key differs from the env ANTHROPIC_AUTH_TOKEN → no evidence to
  // override the default.
  expect(
    resolveApiKeyConflict({
      dogeKey: 'a',
      authKey: 'b',
      profileApiKey: 'c',
      profileAuthTokenType: 'ANTHROPIC_AUTH_TOKEN',
    }),
  ).toEqual({ keep: 'DOGE_API_KEY', remove: 'ANTHROPIC_AUTH_TOKEN' })
  // Profile explicitly DOGE-typed → default stands.
  expect(
    resolveApiKeyConflict({
      dogeKey: 'a',
      authKey: 'b',
      profileApiKey: 'b',
      profileAuthTokenType: 'DOGE_API_KEY',
    }),
  ).toEqual({ keep: 'DOGE_API_KEY', remove: 'ANTHROPIC_AUTH_TOKEN' })
})

// --- enforceApiKeyExclusivityWithDeps (process.env side effects) ---

test('enforce: no-op when only DOGE_API_KEY is set', () => {
  process.env.DOGE_API_KEY = 'k1'
  expect(enforceApiKeyExclusivityWithDeps({ getActiveProfileCredentials: noProfile })).toBeUndefined()
  expect(process.env.DOGE_API_KEY).toBe('k1')
})

test('enforce: no-op when only ANTHROPIC_AUTH_TOKEN is set', () => {
  process.env.ANTHROPIC_AUTH_TOKEN = 'k2'
  expect(enforceApiKeyExclusivityWithDeps({ getActiveProfileCredentials: noProfile })).toBeUndefined()
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('k2')
})

test('enforce: both set with no profile evidence → keeps DOGE_API_KEY, deletes ANTHROPIC_AUTH_TOKEN', () => {
  process.env.DOGE_API_KEY = 'k1'
  process.env.ANTHROPIC_AUTH_TOKEN = 'k2'
  expect(
    enforceApiKeyExclusivityWithDeps({ getActiveProfileCredentials: noProfile }),
  ).toBe('DOGE_API_KEY')
  expect(process.env.DOGE_API_KEY).toBe('k1')
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
})

test('enforce: profile says ANTHROPIC_AUTH_TOKEN and its key matches → keeps Bearer var, deletes DOGE_API_KEY', () => {
  process.env.DOGE_API_KEY = 'stray'
  process.env.ANTHROPIC_AUTH_TOKEN = 'k2'
  expect(
    enforceApiKeyExclusivityWithDeps({
      getActiveProfileCredentials: () => ({
        apiKey: 'k2',
        authTokenType: 'ANTHROPIC_AUTH_TOKEN',
      }),
    }),
  ).toBe('ANTHROPIC_AUTH_TOKEN')
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('k2')
  expect(process.env.DOGE_API_KEY).toBeUndefined()
})

test('enforce: profile lookup throwing does not break startup (default arbitration applies)', () => {
  process.env.DOGE_API_KEY = 'k1'
  process.env.ANTHROPIC_AUTH_TOKEN = 'k2'
  expect(
    enforceApiKeyExclusivityWithDeps({
      getActiveProfileCredentials: () => {
        throw new Error('storage unreadable')
      },
    }),
  ).toBe('DOGE_API_KEY')
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
})

test('enforce: ssh tunnel placeholder context is left untouched', () => {
  process.env.ANTHROPIC_UNIX_SOCKET = 'tcp://127.0.0.1:1'
  process.env.DOGE_API_KEY = 'k1'
  process.env.ANTHROPIC_AUTH_TOKEN = 'k2'
  expect(
    enforceApiKeyExclusivityWithDeps({ getActiveProfileCredentials: noProfile }),
  ).toBeUndefined()
  expect(process.env.DOGE_API_KEY).toBe('k1')
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('k2')
})

test('enforce: managed OAuth context (CLAUDE_CODE_REMOTE / claude-desktop) is left untouched', () => {
  process.env.CLAUDE_CODE_REMOTE = '1'
  process.env.DOGE_API_KEY = 'k1'
  process.env.ANTHROPIC_AUTH_TOKEN = 'k2'
  expect(
    enforceApiKeyExclusivityWithDeps({ getActiveProfileCredentials: noProfile }),
  ).toBeUndefined()
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('k2')

  delete process.env.CLAUDE_CODE_REMOTE
  process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
  expect(
    enforceApiKeyExclusivityWithDeps({ getActiveProfileCredentials: noProfile }),
  ).toBeUndefined()
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('k2')
})

test('enforce: idempotent — second call on already-resolved env is a no-op', () => {
  process.env.DOGE_API_KEY = 'k1'
  process.env.ANTHROPIC_AUTH_TOKEN = 'k2'
  enforceApiKeyExclusivityWithDeps({ getActiveProfileCredentials: noProfile })
  expect(
    enforceApiKeyExclusivityWithDeps({ getActiveProfileCredentials: noProfile }),
  ).toBeUndefined()
  expect(process.env.DOGE_API_KEY).toBe('k1')
})

import { test, expect, beforeEach, afterEach } from 'bun:test'
import {
  clearProfileEnvVars,
  captureEnvSnapshot,
  restoreEnvSnapshot,
  ModelSwitchError,
} from './switchModelProfile.js'
import { PROFILE_MANAGED_ENV_KEYS } from './profileEnvKeys.js'

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

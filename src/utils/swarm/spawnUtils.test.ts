import { afterEach, describe, expect, test } from 'bun:test'
import { buildInheritedEnvVars, isEnvOnlyCredentialConfig } from './spawnUtils.js'

const saved = { ...process.env }

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k]
  }
  Object.assign(process.env, saved)
})

describe('buildInheritedEnvVars — non-secret provider forwarding (audit fix)', () => {
  test('forwards provider format + tier slots when set', () => {
    process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'gpt-5.2-mini'
    const envStr = buildInheritedEnvVars()
    expect(envStr).toContain('CLAUDECODE=1')
    expect(envStr).toContain('CLAUDE_CODE_COMPATIBLE_API_PROVIDER=openai')
    expect(envStr).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-5.2-mini')
  })

  test('NEVER forwards API keys — the string lands on the ps-visible tmux command line', () => {
    process.env.DOGE_API_KEY = 'sk-secret'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-secret'
    const envStr = buildInheritedEnvVars()
    expect(envStr).not.toContain('sk-secret')
    expect(envStr).not.toContain('tok-secret')
    expect(envStr).not.toContain('DOGE_API_KEY=')
    expect(envStr).not.toContain('ANTHROPIC_AUTH_TOKEN=')
  })

  test('quotes values so spaces cannot smuggle extra shell words', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://relay.test/v1 ; rm -rf /'
    const envStr = buildInheritedEnvVars()
    // The value must be a single quoted shell word — not spliced raw after =.
    expect(envStr).toContain(`ANTHROPIC_BASE_URL='https://relay.test/v1 ; rm -rf /'`)
    expect(envStr).not.toMatch(/ANTHROPIC_BASE_URL=[^']/)
  })
})

describe('isEnvOnlyCredentialConfig — env-only credential detection', () => {
  test('true when the key exists only in env (not persisted)', () => {
    process.env.DOGE_API_KEY = 'sk-only-in-env'
    expect(isEnvOnlyCredentialConfig({ apiKey: undefined })).toBe(true)
  })

  test('false when storage holds the key (teammates can read it from disk)', () => {
    process.env.DOGE_API_KEY = 'sk-persisted'
    expect(isEnvOnlyCredentialConfig({ apiKey: 'sk-persisted' })).toBe(false)
  })

  test('false when no key is configured at all', () => {
    delete process.env.DOGE_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    expect(isEnvOnlyCredentialConfig({ apiKey: undefined })).toBe(false)
  })

  test('ANTHROPIC_AUTH_TOKEN counts as the env-only key too', () => {
    delete process.env.DOGE_API_KEY
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-only-in-env'
    expect(isEnvOnlyCredentialConfig({ apiKey: undefined })).toBe(true)
  })
})

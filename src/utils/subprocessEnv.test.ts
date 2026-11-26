import { afterEach, describe, expect, test } from 'bun:test'
import { subprocessEnv } from './subprocessEnv.js'

const FLAG = 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'
const savedFlag = process.env[FLAG]
const savedEnv = { ...process.env }

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = savedFlag
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
})

describe('subprocessEnv — fork credential scrub (audit fix)', () => {
  test('scrubs doge credentials by DEFAULT (no flag set)', () => {
    delete process.env[FLAG]
    process.env.DOGE_API_KEY = 'sk-secret'
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-secret'
    const env = subprocessEnv()
    expect(env.DOGE_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.DOGE_API_KEY in env).toBe(false)
  })

  test('keeps non-secret provider config vars by default', () => {
    delete process.env[FLAG]
    process.env.ANTHROPIC_BASE_URL = 'https://relay.test/v1'
    process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
    const env = subprocessEnv()
    expect(env.ANTHROPIC_BASE_URL).toBe('https://relay.test/v1')
    expect(env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER).toBe('openai')
  })

  test('keeps ambient cloud creds by default (aws in Bash tool is legit)', () => {
    delete process.env[FLAG]
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret'
    const env = subprocessEnv()
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('aws-secret')
  })

  test('full mode (flag truthy) also scrubs the CI list', () => {
    process.env[FLAG] = '1'
    process.env.DOGE_API_KEY = 'sk-secret'
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret'
    const env = subprocessEnv()
    expect(env.DOGE_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  test('explicit opt-out (flag falsy) disables scrubbing entirely', () => {
    process.env[FLAG] = '0'
    process.env.DOGE_API_KEY = 'sk-secret'
    const env = subprocessEnv()
    expect(env.DOGE_API_KEY).toBe('sk-secret')
  })

  test('never mutates the real process.env', () => {
    delete process.env[FLAG]
    process.env.DOGE_API_KEY = 'sk-secret'
    void subprocessEnv()
    expect(process.env.DOGE_API_KEY).toBe('sk-secret')
  })
})

test('scrubs SSH tunnel capability variables in default and full modes', () => {
  process.env.DOGE_SSH_PROXY_TOKEN = 'tunnel-secret'
  process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/doge-ssh-test.sock'
  process.env.INPUT_DOGE_SSH_PROXY_TOKEN = 'input-tunnel-secret'
  delete process.env[FLAG]
  const defaults = subprocessEnv()
  expect(defaults.DOGE_SSH_PROXY_TOKEN).toBeUndefined()
  expect(defaults.ANTHROPIC_UNIX_SOCKET).toBeUndefined()
  expect(defaults.INPUT_DOGE_SSH_PROXY_TOKEN).toBeUndefined()
  process.env[FLAG] = '1'
  const full = subprocessEnv()
  expect(full.DOGE_SSH_PROXY_TOKEN).toBeUndefined()
  expect(full.ANTHROPIC_UNIX_SOCKET).toBeUndefined()
  expect(process.env.DOGE_SSH_PROXY_TOKEN).toBe('tunnel-secret')
  expect(process.env.ANTHROPIC_UNIX_SOCKET).toBe('/tmp/doge-ssh-test.sock')
})

test('explicit opt-out retains SSH tunnel variables', () => {
  process.env[FLAG] = '0'
  process.env.DOGE_SSH_PROXY_TOKEN = 'tunnel-secret'
  process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/doge-ssh-test.sock'
  const env = subprocessEnv()
  expect(env.DOGE_SSH_PROXY_TOKEN).toBe('tunnel-secret')
  expect(env.ANTHROPIC_UNIX_SOCKET).toBe('/tmp/doge-ssh-test.sock')
})

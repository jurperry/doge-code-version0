import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'test', 'model-runtime-context')
const saved = { ...process.env }
beforeAll(() => { process.env.CLAUDE_CONFIG_DIR = dir; mkdirSync(dir, { recursive: true }) })
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(dir, { recursive: true, force: true })
})

test('worker generator pins API, tier and key at creation across yields and leader switches', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const { getDefaultHaikuModel } = await import('../src/utils/model/model.js')
  process.env.ANTHROPIC_MODEL = 'a-main'
  process.env.ANTHROPIC_BASE_URL = 'https://a.invalid'
  process.env.DOGE_API_KEY = 'fake-a'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'a-fast'
  const worker = ctx.iterateWithModelEnvironment(async function* () {
    yield [ctx.getModelEnvironment().ANTHROPIC_BASE_URL, getDefaultHaikuModel(), ctx.getModelEnvironment().DOGE_API_KEY]
    await Promise.resolve()
    yield [ctx.getModelEnvironment().ANTHROPIC_BASE_URL, getDefaultHaikuModel(), ctx.getModelEnvironment().DOGE_API_KEY]
  })
  process.env.ANTHROPIC_BASE_URL = 'https://b.invalid'
  process.env.DOGE_API_KEY = 'fake-b'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'b-fast'
  expect((await worker.next()).value).toEqual(['https://a.invalid', 'a-fast', 'fake-a'])
  expect(ctx.getModelEnvironment().DOGE_API_KEY).toBe('fake-b')
  expect((await worker.next()).value).toEqual(['https://a.invalid', 'a-fast', 'fake-a'])
  await worker.return(undefined)
  expect(ctx.getModelEnvironment().DOGE_API_KEY).toBe('fake-b')
})

test('snapshot captures missing env fallback once and explicit anthropic outranks disk openai', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  delete process.env.DOGE_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'anthropic'
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ customApiEndpoint: {
    provider: 'openai', baseURL: 'https://old.invalid', apiKey: 'old-key',
  } }))
  const snapshot = ctx.captureModelEnvironment()
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ customApiEndpoint: {
    provider: 'responses', baseURL: 'https://new.invalid', apiKey: 'new-key',
  } }))
  ctx.runWithModelEnvironment(snapshot, () => {
    expect(ctx.readModelApiStorage().apiKey).toBe('old-key')
    expect(ctx.getModelConnection().provider).toBe('anthropic')
    expect(ctx.getModelConnection().baseURL).toBe('https://old.invalid')
  })
})

test('nested and parallel contexts retain their own routing and restore after exceptions', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const a = ctx.captureModelEnvironment({ ...process.env, DOGE_API_KEY: 'A' })
  const b = ctx.captureModelEnvironment({ ...process.env, DOGE_API_KEY: 'B' })
  const results = await Promise.all([a, b].map(snapshot => ctx.runWithModelEnvironment(snapshot, async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
    const nested = ctx.captureModelEnvironment()
    expect(nested.env.DOGE_API_KEY).toBe(snapshot.env.DOGE_API_KEY)
    return ctx.getModelEnvironment().DOGE_API_KEY
  })))
  expect(results).toEqual(['A', 'B'])
  expect(() => ctx.runWithModelEnvironment(a, () => { throw Error('stop') })).toThrow('stop')
  expect(ctx.hasModelEnvironment()).toBe(false)
})

test('OAuth refresh rotation reaches sibling workers of the same credential lineage', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const old = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: old }))
  const a = ctx.captureModelEnvironment()
  const b = ctx.captureModelEnvironment()
  ctx.runWithModelEnvironment(a, () => ctx.updateModelOAuthTokens({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 999 }))
  ctx.runWithModelEnvironment(b, () => expect(ctx.getModelOAuthTokens()?.accessToken).toBe('new-access'))
  ctx.updateModelOAuthTokens({ accessToken: 'latest-access', refreshToken: 'latest-refresh', expiresAt: 9999 }, { accessToken: 'new-access', refreshToken: 'new-refresh' })
  ctx.runWithModelEnvironment(a, () => expect(ctx.getModelOAuthTokens()?.accessToken).toBe('latest-access'))
})

test('worker default model does not follow later leader bootstrap overrides', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const { setMainLoopModelOverride } = await import('../src/bootstrap/state.js')
  const { getMainLoopModel, getDefaultHaikuModel } = await import('../src/utils/model/model.js')
  delete process.env.ANTHROPIC_MODEL
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  setMainLoopModelOverride('old-model')
  const snapshot = ctx.captureModelEnvironment()
  setMainLoopModelOverride('new-model')
  ctx.runWithModelEnvironment(snapshot, () => {
    expect(getMainLoopModel()).toBe('old-model')
    expect(getDefaultHaikuModel()).toBe('old-model')
  })
  setMainLoopModelOverride(undefined)
})

test('OAuth refresh reads a newer token for the same account without following a login switch', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const { saveGlobalConfig } = await import('../src/utils/config.js')
  saveGlobalConfig(current => ({ ...current, oauthAccount: { accountUuid: 'account-a' } as any }))
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'account-a-old', refreshToken: 'a-refresh' } }))
  const worker = ctx.captureModelEnvironment()
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'account-a-new', refreshToken: 'a-new-refresh' } }))
  await ctx.runWithModelEnvironment(worker, async () => expect((await ctx.readUpdatedModelOAuthTokens())?.accessToken).toBe('account-a-new'))
  saveGlobalConfig(current => ({ ...current, oauthAccount: { accountUuid: 'account-b' } as any }))
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'account-b', refreshToken: 'b-refresh' } }))
  await ctx.runWithModelEnvironment(worker, async () => expect((await ctx.readUpdatedModelOAuthTokens())?.accessToken).toBe('account-a-new'))
})

test('worker defaults retain settings.model when bootstrap override is absent', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const { setMainLoopModelOverride } = await import('../src/bootstrap/state.js')
  const { updateSettingsForSource } = await import('../src/utils/settings/settings.js')
  const { getMainLoopModel } = await import('../src/utils/model/model.js')
  setMainLoopModelOverride(undefined)
  delete process.env.ANTHROPIC_MODEL
  updateSettingsForSource('userSettings', { model: 'settings-a' })
  const worker = ctx.captureModelEnvironment()
  updateSettingsForSource('userSettings', { model: 'settings-b' })
  ctx.runWithModelEnvironment(worker, () => expect(getMainLoopModel()).toBe('settings-a'))
})

test('login-managed API key stays with its worker after the leader saves another key', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const { saveApiKey, getAnthropicApiKeyWithSource } = await import('../src/utils/auth.js')
  const { saveGlobalConfig, enableConfigs } = await import('../src/utils/config.js')
  enableConfigs()
  const nodeEnv = process.env.NODE_ENV
  const ci = process.env.CI
  try {
    process.env.NODE_ENV = 'production'
    delete process.env.CI
    delete process.env.DOGE_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    writeFileSync(join(dir, '.credentials.json'), '{}')
    saveGlobalConfig(current => ({ ...current, customApiEndpoint: undefined, oauthAccount: undefined }))
    await saveApiKey('fake-login-a')
    const oldWorker = ctx.captureModelEnvironment()
    await saveApiKey('fake-login-b')
    const newWorker = ctx.captureModelEnvironment()
    ctx.runWithModelEnvironment(oldWorker, () => expect(getAnthropicApiKeyWithSource().key).toBe('fake-login-a'))
    ctx.runWithModelEnvironment(newWorker, () => expect(getAnthropicApiKeyWithSource().key).toBe('fake-login-b'))
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
    if (ci === undefined) delete process.env.CI
    else process.env.CI = ci
  }
})

test('old-account worker refresh cannot overwrite the new leader account credentials', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const { saveGlobalConfig } = await import('../src/utils/config.js')
  const { saveOAuthTokensIfNeeded } = await import('../src/utils/auth.js')
  const { readFileSync } = await import('node:fs')
  saveGlobalConfig(current => ({ ...current, oauthAccount: { accountUuid: 'isolated-a' } as any }))
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'isolated-a', refreshToken: 'a-refresh', scopes: ['user:inference'] } }))
  const worker = ctx.captureModelEnvironment()
  saveGlobalConfig(current => ({ ...current, oauthAccount: { accountUuid: 'isolated-b' } as any }))
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'isolated-b', refreshToken: 'b-refresh', scopes: ['user:inference'] } }))
  ctx.runWithModelEnvironment(worker, () => saveOAuthTokensIfNeeded({ accessToken: 'a-refreshed', refreshToken: 'a-rotated', expiresAt: Date.now() + 100000, scopes: ['user:inference'] }))
  expect(JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken).toBe('isolated-b')
  ctx.runWithModelEnvironment(worker, () => expect(ctx.getModelOAuthTokens()?.accessToken).toBe('a-refreshed'))
})

test('a login change during async credential read cannot enter the old worker', async () => {
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const { saveGlobalConfig } = await import('../src/utils/config.js')
  const { getSecureStorage } = await import('../src/utils/secureStorage/index.js')
  saveGlobalConfig(current => ({ ...current, oauthAccount: { accountUuid: 'race-a' } as any }))
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'race-a', refreshToken: 'race-a-refresh' } }))
  const worker = ctx.captureModelEnvironment()
  const storage = getSecureStorage() as any
  const original = storage.readAsync
  storage.readAsync = async () => {
    saveGlobalConfig(current => ({ ...current, oauthAccount: { accountUuid: 'race-b' } as any }))
    return { claudeAiOauth: { accessToken: 'race-b', refreshToken: 'race-b-refresh' } }
  }
  try {
    await ctx.runWithModelEnvironment(worker, async () => expect((await ctx.readUpdatedModelOAuthTokens())?.accessToken).toBe('race-a'))
  } finally { storage.readAsync = original }
})

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const saved = { ...process.env }
const dir = join(process.cwd(), 'test', 'model-host-context')
mkdirSync(dir, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = dir
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(dir, { recursive: true, force: true })
})

test('host-owned connection never adopts disk defaults or settings routing on reload', async () => {
  const profile = { id: 'b', model: 'shared', provider: 'responses', baseURL: 'https://b.invalid', apiKey: 'fake-b', defaultHaikuModel: 'b-fast' }
  const endpoint = { ...profile, activeProfileId: 'b', modelProfiles: [profile] }
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ customApiEndpoint: endpoint }))
  const { saveGlobalConfig } = await import('../src/utils/config.js')
  saveGlobalConfig(current => ({ ...current, customApiEndpoint: endpoint as any }))
  const { updateSettingsForSource } = await import('../src/utils/settings/settings.js')
  updateSettingsForSource('userSettings', { env: {
    ANTHROPIC_MODEL: 'disk-model', ANTHROPIC_BASE_URL: 'https://settings.invalid',
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'responses', CLAUDE_CODE_DISABLE_EFFORT: '1',
  } })
  Object.assign(process.env, {
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', DOGE_ACTIVE_MODEL_PROFILE: 'a',
    ANTHROPIC_MODEL: 'shared', ANTHROPIC_BASE_URL: 'https://a.invalid', DOGE_API_KEY: 'fake-a',
    ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'openai',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: '', CLAUDE_CODE_DISABLE_EFFORT: '',
  })
  const { applySafeConfigEnvironmentVariables, applyConfigEnvironmentVariables } = await import('../src/utils/managedEnv.js')
  applySafeConfigEnvironmentVariables()
  applyConfigEnvironmentVariables()
  applyConfigEnvironmentVariables()
  expect(process.env.ANTHROPIC_MODEL).toBe('shared')
  expect(process.env.ANTHROPIC_BASE_URL).toBe('https://a.invalid')
  expect(process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER).toBe('openai')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('')
  expect(process.env.DOGE_API_KEY).toBe('fake-a')

  const { applyProfileForModelIfMatch, findProfileByModel } = await import('../src/utils/model/switchModelProfile.bindings.js')
  expect(findProfileByModel('shared')).toBeTruthy()
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'a-fast'
  const { getAgentModel } = await import('../src/utils/model/agent.js')
  expect(getAgentModel(undefined, 'previous', 'haiku')).toBe('a-fast')
  expect(await applyProfileForModelIfMatch('shared')).toBe(false)
  expect(process.env.ANTHROPIC_BASE_URL).toBe('https://a.invalid')
  expect(getAgentModel(undefined, 'shared', 'haiku')).toBe('a-fast')
  expect(getAgentModel(undefined, 'shared', 'inherit')).toBe('shared')
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'a-explicit'
  expect(getAgentModel(undefined, 'shared', 'haiku')).toBe('a-explicit')
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
})

test('explicit empty host URL and credentials cannot be filled from disk profiles', async () => {
  Object.assign(process.env, { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', DOGE_ACTIVE_MODEL_PROFILE: 'b', ANTHROPIC_BASE_URL: '', DOGE_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'anthropic' })
  const { getModelConnection } = await import('../src/utils/model/runtimeModelContext.js')
  expect(getModelConnection()).toMatchObject({ baseURL: 'https://api.anthropic.com', apiKey: null, provider: 'anthropic' })
  const { getAnthropicApiKeyWithSource } = await import('../src/utils/auth.js')
  expect(() => getAnthropicApiKeyWithSource({ skipApiKeyHelper: true })).toThrow('required')
})

test('real SDK client keeps the explicit host key and official default URL in request headers', async () => {
  process.env.DOGE_API_KEY = 'explicit-host-a'
  const { ensureBootstrapMacro } = await import('../src/bootstrapMacro.js')
  ensureBootstrapMacro()
  const { getAnthropicClient } = await import('../src/services/api/client.js')
  let observed: Request | undefined
  const client = await getAnthropicClient({ maxRetries: 0, model: 'test-model', fetchOverride: async (input, init) => {
    observed = new Request(input, init)
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
  } })
  await client.messages.create({ model: 'test-model', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] })
  expect(observed?.url).toStartWith('https://api.anthropic.com/')
  expect(observed?.headers.get('x-api-key')).toBe('explicit-host-a')
  expect(observed?.headers.get('authorization')).toBeNull()
})

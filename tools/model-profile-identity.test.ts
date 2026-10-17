import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'test', 'model-profile-identity')
const saved = { ...process.env }
const profiles = [
  { id: 'provider-a', model: 'shared-model', providerName: 'A', provider: 'openai' as const, baseURL: 'https://a.invalid', apiKey: 'fake-a' },
  { id: 'provider-b', model: 'shared-model', providerName: 'B', provider: 'responses' as const, baseURL: 'https://b.invalid', apiKey: 'fake-b' },
]
beforeAll(() => { process.env.CLAUDE_CONFIG_DIR = dir; mkdirSync(dir, { recursive: true }) })
beforeEach(() => {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ customApiEndpoint: {
    model: 'shared-model', activeProfileId: 'provider-b', modelProfiles: profiles,
  } }))
  process.env.ANTHROPIC_MODEL = 'shared-model'
  process.env.DOGE_ACTIVE_MODEL_PROFILE = 'provider-b'
  process.env.ANTHROPIC_BASE_URL = 'https://b.invalid'
  process.env.DOGE_API_KEY = 'fake-b'
})
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(dir, { recursive: true, force: true })
})

test('explicit profile reference selects A despite active B sharing its model', async () => {
  const { getModelProfile } = await import('../src/utils/customApiStorage.js')
  expect(getModelProfile('profile:provider-a')?.providerName).toBe('A')
  expect(getModelProfile('shared-model')?.providerName).toBe('B')
})

test('model picker and provider manager expose both same-model providers', async () => {
  const { getModelOptions } = await import('../src/utils/model/modelOptions.js')
  const values = getModelOptions().map(p => p.value)
  expect(values).toContain('profile:provider-a')
  expect(values).toContain('profile:provider-b')
  const { getProviderEntries } = await import('../src/commands/provider/provider-entries.js')
  expect(getProviderEntries().filter(p => p.profile).length).toBe(2)
})

test('editing provider name and main model preserves its durable identity', async () => {
  const { upsertModelProfile } = await import('../src/commands/provider/provider-storage.js')
  const renamed = { model: 'new-model', providerName: 'Renamed', provider: 'openai' as const }
  const result = upsertModelProfile(profiles, renamed, profiles[0])
  expect(result[0]?.id).toBe('provider-a')
  expect(result[1]?.id).toBe('provider-b')
})

test('profile reference is resolved before the model reaches the API', async () => {
  const { parseUserSpecifiedModel } = await import('../src/utils/model/model.js')
  expect(parseUserSpecifiedModel('profile:provider-a')).toBe('shared-model')
  expect(() => parseUserSpecifiedModel('profile:deleted')).toThrow()
})

test('switch patch and persistence carry the exact provider identity', async () => {
  const { modelProfileEnvPatch, applyModelProfile, readCustomApiStorage } = await import('../src/utils/customApiStorage.js')
  expect(modelProfileEnvPatch(profiles[0]).DOGE_ACTIVE_MODEL_PROFILE).toBe('provider-a')
  applyModelProfile(profiles[0], { persist: false })
  expect(readCustomApiStorage().activeProfileId).toBe('provider-b')
  applyModelProfile(profiles[0])
  expect(readCustomApiStorage().activeProfileId).toBe('provider-a')
})

test('removing A preserves B even when both expose the same main model', async () => {
  const { doRemoveProvider } = await import('../src/commands/provider/provider-remove.js')
  const { readCustomApiStorage } = await import('../src/utils/customApiStorage.js')
  const result = doRemoveProvider('profile:provider-a')
  expect(result.success).toBe(true)
  expect(readCustomApiStorage().modelProfiles?.map(p => p.id)).toEqual(['provider-b'])
  expect(readCustomApiStorage().activeProfileId).toBe('provider-b')
  expect(process.env.ANTHROPIC_BASE_URL).toBe('https://b.invalid')
})

test('credential repair honors persisted identity despite a different active session', async () => {
  const { healStoredCredentials, readCustomApiStorage } = await import('../src/utils/customApiStorage.js')
  process.env.DOGE_ACTIVE_MODEL_PROFILE = 'provider-a'
  process.env.ANTHROPIC_BASE_URL = 'https://a.invalid'
  process.env.DOGE_API_KEY = 'fake-a'
  healStoredCredentials()
  expect(readCustomApiStorage().apiKey).toBe('fake-b')
})

test('reusing an old provider name after rename creates a separate identity', async () => {
  const { saveAndActivateProvider, defaultProviderSaveDeps } = await import('../src/commands/provider/provider-storage.js')
  const { readCustomApiStorage } = await import('../src/utils/customApiStorage.js')
  const legacy = { model: 'old-main', providerName: 'Original' }
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ customApiEndpoint: { modelProfiles: [legacy] } }))
  await saveAndActivateProvider({ model: 'renamed-main', providerName: 'Renamed' }, defaultProviderSaveDeps(), () => {}, legacy)
  await saveAndActivateProvider({ model: 'fresh-main', providerName: 'Original' }, defaultProviderSaveDeps(), () => {})
  const stored = readCustomApiStorage().modelProfiles!
  expect(stored.map(p => p.providerName)).toEqual(['Renamed', 'Original'])
  expect(stored[0]?.id).not.toBe(stored[1]?.id)
})

test('saving a bare model cannot leave a stale profile identity that replaces it on restart', async () => {
  const { syncModelConfigToDisk } = await import('../src/utils/model/syncModelConfig.js')
  const { readCustomApiStorage } = await import('../src/utils/customApiStorage.js')
  syncModelConfigToDisk('bare-model', false)
  expect(readCustomApiStorage().model).toBe('bare-model')
  expect(readCustomApiStorage().activeProfileId).toBeUndefined()
})

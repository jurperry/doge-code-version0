import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetModelTestState } from './modelTestIsolation.js'

const dir = join(process.cwd(), 'test', 'model-startup-context')
const saved = { ...process.env }
beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  mkdirSync(dir, { recursive: true })
})
beforeEach(async () => {
  process.env.CLAUDE_CONFIG_DIR = dir
  await resetModelTestState({ managed: true })
})
afterAll(async () => {
  await resetModelTestState({ managed: true })
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(dir, { recursive: true, force: true })
})

test('settings selecting same-model endpoint B survive both startup phases with B tiers', async () => {
  const profiles = [
    { id: 'a', providerName: 'A', model: 'shared', provider: 'openai', baseURL: 'https://a.invalid', apiKey: 'fake-a', defaultHaikuModel: 'a-fast' },
    { id: 'b', providerName: 'B', model: 'shared', provider: 'responses', baseURL: 'https://b.invalid', apiKey: 'fake-b', defaultHaikuModel: 'b-fast' },
  ]
  const endpoint = { model: 'shared', activeProfileId: 'a', modelProfiles: profiles }
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ customApiEndpoint: endpoint }))
  const { saveGlobalConfig } = await import('../src/utils/config.js')
  saveGlobalConfig(current => ({ ...current, customApiEndpoint: endpoint as any }))
  const { updateSettingsForSource } = await import('../src/utils/settings/settings.js')
  updateSettingsForSource('userSettings', { env: { ANTHROPIC_MODEL: 'shared', ANTHROPIC_BASE_URL: 'https://b.invalid', DOGE_API_KEY: 'fake-b' } })
  for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL', 'DOGE_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'DOGE_ACTIVE_MODEL_PROFILE', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_COMPATIBLE_API_PROVIDER']) delete process.env[key]
  const { applySafeConfigEnvironmentVariables, applyConfigEnvironmentVariables } = await import('../src/utils/managedEnv.js')
  applySafeConfigEnvironmentVariables()
  applyConfigEnvironmentVariables()
  const { readCustomApiStorage } = await import('../src/utils/customApiStorage.js')
  const expectedProfileId = readCustomApiStorage().modelProfiles?.find(p => p.providerName?.startsWith('B'))?.id
  expect(process.env.DOGE_ACTIVE_MODEL_PROFILE).toBe(expectedProfileId)
  expect(process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER).toBe('responses')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('b-fast')
  applyConfigEnvironmentVariables()
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('b-fast')
})

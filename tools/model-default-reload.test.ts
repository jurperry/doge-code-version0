import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const saved = { ...process.env }, dir = join(process.cwd(), 'test', 'model-default-reload')
mkdirSync(dir, { recursive: true })
for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|DOGE_|CLAUDE_CODE_)/.test(key)) delete process.env[key]
process.env.CLAUDE_CONFIG_DIR = dir
afterAll(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); rmSync(dir, { recursive: true, force: true }) })
test('trusted startup freezes disk-restored profile while later defaults remain independent', async () => {
  const { saveGlobalConfig } = await import('../src/utils/config.js')
  const select = (id: string) => {
    const endpoint = { model: `model-${id}`, activeProfileId: id, modelProfiles: [{ id, model: `model-${id}`, baseURL: `https://${id}.invalid`, apiKey: `fake-${id}`, provider: 'openai', defaultHaikuModel: `fast-${id}` }] }
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ customApiEndpoint: endpoint }))
    saveGlobalConfig(current => ({ ...current, customApiEndpoint: endpoint as any }))
  }
  select('a')
  const { applySafeConfigEnvironmentVariables, applyConfigEnvironmentVariables } = await import('../src/utils/managedEnv.js')
  applySafeConfigEnvironmentVariables(); applyConfigEnvironmentVariables()
  select('b'); applyConfigEnvironmentVariables()
  expect(process.env.ANTHROPIC_MODEL).toBe('model-a')
  expect(process.env.ANTHROPIC_BASE_URL).toBe('https://a.invalid')
  expect(process.env.DOGE_API_KEY).toBe('fake-a')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('fast-a')
})

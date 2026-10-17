import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'test', 'model-routing-regression')
const saved = { ...process.env }
beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = dir
  mkdirSync(dir, { recursive: true })
})
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(dir, { recursive: true, force: true })
})

test('startup restores tiers for explicit main B instead of disk baseline A', async () => {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ customApiEndpoint: {
    model: 'a-main', modelProfiles: [
      { model: 'a-main', providerName: 'A', defaultHaikuModel: 'a-fast' },
      { model: 'b-main', providerName: 'B', defaultHaikuModel: 'b-fast' },
    ],
  } }))
  process.env.ANTHROPIC_MODEL = 'b-main'
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  const { restoreTierStateFromStorage } = await import('../src/utils/model/restoreTierState.js')
  restoreTierStateFromStorage()
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('b-fast')
})

test('unknown explicit main does not inherit disk baseline tiers', async () => {
  process.env.ANTHROPIC_MODEL = 'unknown-main'
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  const { restoreTierStateFromStorage } = await import('../src/utils/model/restoreTierState.js')
  restoreTierStateFromStorage()
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
})

test('workflow inherit and tier suffix stay inside the selected provider', async () => {
  const { profileStepModel } = await import('../src/tools/WorkflowTool/headlessStep.js')
  const profile = { model: 'b-main', defaultHaikuModel: 'b-fast' }
  expect(profileStepModel(profile, 'inherit')).toBe('b-main')
  expect(profileStepModel(profile, 'haiku[2m]')).toBe('b-fast[2m]')
  expect(profileStepModel(profile, 'opus')).toBe('b-main')
})

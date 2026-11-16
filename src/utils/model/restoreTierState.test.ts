import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeModelCatalog } from './modelCatalog.js'

const TMP = join(process.cwd(), 'test', '.tmp-restore-tier')
const KEYS = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const
let original: Record<string, string | undefined> = {}
let restoreTierStateFromStorage: typeof import('./restoreTierState.js').restoreTierStateFromStorage

beforeAll(async () => {
  for (const key of KEYS) original[key] = process.env[key]
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = TMP
  restoreTierStateFromStorage = (await import('./restoreTierState.js')).restoreTierStateFromStorage
})

afterAll(() => {
  for (const key of KEYS) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(TMP, { recursive: true, force: true })
})

function clearEnv(): void {
  for (const key of KEYS) if (key !== 'CLAUDE_CONFIG_DIR') delete process.env[key]
}

function writeCatalog(): void {
  writeModelCatalog({
    version: 2,
    connections: [{
      id: 'c1',
      name: 'catalog',
      protocol: 'anthropic',
      baseURL: 'https://example.test',
      models: [
        { id: 'main', upstreamModel: 'main-model', displayName: 'main-model' },
        { id: 'opus', upstreamModel: 'opus-model', displayName: 'opus-model' },
        { id: 'sonnet', upstreamModel: 'sonnet-model', displayName: 'sonnet-model' },
        { id: 'haiku', upstreamModel: 'haiku-model', displayName: 'haiku-model' },
      ],
      defaultModelId: 'main',
      roles: { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' },
    }],
    defaultModel: { connectionId: 'c1', modelId: 'main' },
  })
}

test('restores tier env from catalog roles without activeTier persistence', () => {
  clearEnv()
  writeCatalog()
  restoreTierStateFromStorage()
  expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('opus-model')
  expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet-model')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('haiku-model')
})

test('explicit start-script env wins over catalog roles', () => {
  clearEnv()
  writeCatalog()
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'script-opus'
  restoreTierStateFromStorage()
  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('script-opus')
  expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('sonnet-model')
})

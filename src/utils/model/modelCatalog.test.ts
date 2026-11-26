import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getModelOptions } from './modelOptions.js'
import { matchModelProfile, profileSelection } from './profileIdentity.js'
import { getEffortCapability } from './effortCapabilities.js'
import { persistCatalogModelSelection } from './syncModelConfig.js'
import { getProviderEntries } from '../../commands/provider/provider-entries.js'
import { enableConfigs } from '../config.js'
import {
  endpointToCatalog,
  catalogToEndpoint,
  inferCatalogReasoningPolicy,
  readModelCatalog,
  writeModelCatalog,
  type ModelCatalog,
} from './modelCatalog.js'

const originalConfig = process.env.CLAUDE_CONFIG_DIR
let dir = ''

beforeEach(() => {
  dir = join(tmpdir(), `doge-catalog-${process.pid}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
})

function catalogWithThreeModels(): ModelCatalog {
  return {
    version: 2,
    connections: [{
      id: 'c1',
      name: 'provider',
      protocol: 'openai',
      baseURL: 'https://x.test',
      apiKey: 'k',
      models: [
        { id: 'm1', upstreamModel: 'model-a', displayName: 'A' },
        { id: 'm2', upstreamModel: 'model-b', displayName: 'B' },
        { id: 'm3', upstreamModel: 'model-c', displayName: 'C' },
      ],
      defaultModelId: 'm1',
    }],
    defaultModel: { connectionId: 'c1', modelId: 'm1' },
  }
}

test('model and provider menus preserve connection identity, including same-name models', () => {
  const catalog = catalogWithThreeModels()
  const [first] = catalog.connections
  first.models[1].contextWindow = 300_000
  first.models[1].reasoning = {
    preset: 'generic',
    thinking: { mode: 'always' },
    effort: { mode: 'named', field: 'reasoning_effort', levels: ['low', 'xhigh'], defaultLevel: 'xhigh' },
    response: { openaiFields: [], display: 'none' },
  }
  catalog.connections.push({
    ...first, id: 'c/2:x', name: 'second', apiKey: 'different-fake-key', defaultModelId: 'm2',
    models: [{ ...first.models[1], reasoning: { ...first.models[1].reasoning, effort: { mode: 'none' } } }],
  })
  writeModelCatalog(catalog)
  enableConfigs()
  const profiles = catalogToEndpoint(catalog).modelProfiles!
  const firstChoice = profileSelection(profiles[0], 'm2')
  const secondChoice = profileSelection(profiles[1], 'm2')
  expect(getModelOptions().filter(option => option.label === 'B')).toEqual([
    expect.objectContaining({ value: firstChoice, description: 'Custom model(provider)' }),
    expect.objectContaining({ value: secondChoice, description: 'Custom model(second)' }),
  ])
  expect(getProviderEntries().map(entry => [entry.profile.id, entry.model])).toEqual([['c1', 'model-a'], ['c/2:x', 'model-b']])
  expect(getEffortCapability(firstChoice)).toMatchObject({ levels: ['low', 'xhigh'], defaultLevel: 'xhigh' })
  expect(getEffortCapability(secondChoice).levels).toEqual([])
  expect(matchModelProfile(profiles, secondChoice, {})).toMatchObject({
    model: 'model-b', catalogModelId: 'm2', apiKey: 'different-fake-key', contextWindow: 300_000,
  })
  expect(persistCatalogModelSelection(secondChoice)).toBe(true)
  const saved = readModelCatalog()!
  expect(saved.defaultModel).toEqual({ connectionId: 'c/2:x', modelId: 'm2' })
  expect(saved.connections).toEqual(catalog.connections)
})

test('projection never fabricates roles and preserves models + reasoning', () => {
  const catalog = catalogWithThreeModels()
  catalog.connections[0]!.models[0]!.reasoning = {
    preset: 'deepseek',
    thinking: { mode: 'always' },
    effort: { mode: 'named', field: 'reasoning_effort', levels: ['low', 'high', 'max'] },
    response: { openaiFields: ['reasoning_content', 'reasoning'], display: 'full' },
  }
  writeModelCatalog(catalog)
  const round = endpointToCatalog(catalogToEndpoint(readModelCatalog()), readModelCatalog())
  expect(round.connections[0]?.roles).toBeUndefined()
  expect(round.connections[0]?.models.map(m => m.upstreamModel)).toEqual(['model-a', 'model-b', 'model-c'])
  expect(round.connections[0]?.models[0]?.reasoning?.preset).toBe('deepseek')
  expect(round.defaultModel).toEqual({ connectionId: 'c1', modelId: 'm1' })
})

test('projection preserves only explicit roles, never fabricates missing ones', () => {
  const catalog = catalogWithThreeModels()
  catalog.connections[0]!.roles = { opus: 'm2', subagent: 'm3' }
  writeModelCatalog(catalog)
  const round = endpointToCatalog(catalogToEndpoint(readModelCatalog()), readModelCatalog())
  expect(round.connections[0]?.roles).toEqual({ opus: 'm2', subagent: 'm3' })
})

test('projection represents model deletion and rename', () => {
  writeModelCatalog(catalogWithThreeModels())
  const endpoint = catalogToEndpoint(readModelCatalog())
  endpoint.modelProfiles![0]!.models = endpoint.modelProfiles![0]!.models!.filter(m => m.upstreamModel !== 'model-b')
  endpoint.modelProfiles![0]!.model = 'model-a'
  const next = endpointToCatalog(endpoint, readModelCatalog())
  expect(next.connections[0]?.models.map(m => m.upstreamModel)).toEqual(['model-a', 'model-c'])
})

test('empty connections survive a catalog roundtrip', () => {
  writeModelCatalog({
    version: 2,
    connections: [
      { id: 'c-empty', name: 'empty', protocol: 'openai', models: [] },
      ...catalogWithThreeModels().connections,
    ],
  })
  const round = endpointToCatalog(catalogToEndpoint(readModelCatalog()), readModelCatalog())
  expect(round.connections.map(c => c.name)).toEqual(['empty', 'provider'])
  expect(round.connections[0]?.models).toEqual([])
})

test('adding a provider to a non-empty catalog never mutates another connection', () => {
  const existing: ModelCatalog = {
    version: 2,
    connections: [
      { id: 'c-a', name: 'A', protocol: 'openai', baseURL: 'https://a.test', apiKey: 'key-a', models: [{ id: 'm-a', upstreamModel: 'a-model', displayName: 'a-model' }], defaultModelId: 'm-a' },
      { id: 'c-b', name: 'B', protocol: 'openai', baseURL: 'https://b.test', apiKey: 'key-b', models: [{ id: 'm-b', upstreamModel: 'b-model', displayName: 'b-model' }], defaultModelId: 'm-b' },
    ],
    defaultModel: { connectionId: 'c-a', modelId: 'm-a' },
  }
  const endpoint = catalogToEndpoint(existing)
  endpoint.modelProfiles!.push({
    id: 'new-provider-uuid',
    providerName: 'New',
    provider: 'responses',
    baseURL: 'https://new.test',
    apiKey: 'new-key',
    model: 'new-model',
  })
  endpoint.activeProfileId = 'new-provider-uuid'
  endpoint.provider = 'responses'
  endpoint.baseURL = 'https://new.test'
  endpoint.apiKey = 'new-key'
  endpoint.model = 'new-model'
  const next = endpointToCatalog(endpoint, existing)
  expect(next.connections.find(c => c.id === 'c-a')).toMatchObject({
    baseURL: 'https://a.test', apiKey: 'key-a', models: [{ upstreamModel: 'a-model' }],
  })
  expect(next.connections.find(c => c.id === 'c-b')?.apiKey).toBe('key-b')
  expect(next.connections.find(c => c.name === 'New')).toMatchObject({
    baseURL: 'https://new.test', apiKey: 'new-key', protocol: 'responses',
  })
  expect(next.defaultModel).toMatchObject({ connectionId: next.connections.find(c => c.name === 'New')?.id })
})

test('legacy migration preserves the context window and materializes the reasoning policy', () => {
  const migrated = endpointToCatalog({
    model: 'DeepSeek-V4.1-Flash',
    modelProfiles: [{
      id: 'p-legacy',
      providerName: 'tongji',
      provider: 'openai',
      baseURL: 'https://agi.tongji.edu.cn',
      apiKey: 'k',
      model: 'DeepSeek-V4.1-Flash',
      contextWindow: 1_000_000,
    }],
  })
  expect(migrated.connections[0]?.models[0]?.reasoning?.preset).toBe('deepseek')
  expect(migrated.connections[0]?.models[0]?.contextWindow).toBe(1_000_000)
  expect(migrated.connections[0]?.models[0]?.reasoning?.effort).toMatchObject({
    field: 'reasoning_effort',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  })
})

test('legacy migration gives the active duplicate profile context window priority', () => {
  const base = {
    connectionId: 'c-shared', providerName: 'tongji', provider: 'openai' as const, baseURL: 'https://agi.tongji.edu.cn',
    apiKey: 'k', model: 'DeepSeek-V4.1-Flash', contextWindow: 128_000,
  }
  const active = { ...base, id: 'p-active', contextWindow: 1_000_000 }
  const migrated = endpointToCatalog({
    model: 'DeepSeek-V4.1-Flash', activeProfileId: active.id,
    modelProfiles: [{ ...base, id: 'p-first' }, active],
  })
  expect(migrated.connections[0]?.models[0]?.contextWindow).toBe(1_000_000)
})

test('changing connection protocol rewires/rematerializes model policies', () => {
  const catalog: ModelCatalog = {
    version: 2,
    connections: [{
      id: 'c1', name: 'p', protocol: 'anthropic', baseURL: 'https://x.test', apiKey: 'k',
      models: [{
        id: 'm1', upstreamModel: 'DeepSeek-V4.1-Flash', displayName: 'DeepSeek',
        reasoning: {
          preset: 'deepseek', thinking: { mode: 'always' },
          effort: { mode: 'named', field: 'output_config.effort', levels: ['low', 'high', 'max'] },
          response: { openaiFields: ['reasoning_content', 'reasoning'], display: 'full' },
        },
      }],
      defaultModelId: 'm1',
    }],
    defaultModel: { connectionId: 'c1', modelId: 'm1' },
  }
  const endpoint = catalogToEndpoint(catalog)
  endpoint.modelProfiles![0]!.provider = 'openai'
  endpoint.provider = 'openai'
  const next = endpointToCatalog(endpoint, catalog)
  expect(next.connections[0]?.protocol).toBe('openai')
  expect(next.connections[0]?.models[0]?.reasoning?.effort).toMatchObject({ field: 'reasoning_effort' })

  // /config style: only the top-level endpoint changes, profiles stay stale.
  const topOnly = catalogToEndpoint(catalog)
  topOnly.provider = 'openai'
  const nextTopOnly = endpointToCatalog(topOnly, catalog)
  expect(nextTopOnly.connections[0]?.protocol).toBe('openai')
  expect(nextTopOnly.connections[0]?.models[0]?.reasoning?.effort).toMatchObject({ field: 'reasoning_effort' })
})

test('CLI migration inference mirrors official/custom Anthropic Claude policy', () => {
  const official = inferCatalogReasoningPolicy('anthropic', 'https://api.anthropic.com', 'claude-opus-4-8')
  expect(official.thinking).toMatchObject({ mode: 'value', value: { type: 'adaptive' } })
  expect(official.effort).toMatchObject({ levels: ['low', 'medium', 'high', 'xhigh', 'max'] })
  const custom = inferCatalogReasoningPolicy('anthropic', 'https://gateway.test', 'claude-opus-4-8')
  expect(custom.thinking).toEqual({ mode: 'none' })
  expect(custom.effort).toMatchObject({ levels: ['low', 'medium', 'high'] })
})

test('duplicate connection names are normalized uniquely', () => {
  writeFileSync(join(dir, 'model-catalog.json'), JSON.stringify({
    modelCatalog: {
      version: 2,
      connections: [
        { id: 'c1', name: 'same', protocol: 'openai', models: [{ id: 'm1', upstreamModel: 'a', displayName: 'a' }], defaultModelId: 'm1' },
        { id: 'c2', name: 'same', protocol: 'openai', models: [{ id: 'm2', upstreamModel: 'b', displayName: 'b' }], defaultModelId: 'm2' },
      ],
      defaultModel: { connectionId: 'c1', modelId: 'm1' },
    },
  }))
  const catalog = readModelCatalog()
  expect(catalog?.connections.map(c => c.name)).toEqual(['same', 'same (2)'])
})

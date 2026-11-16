import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getEffortCapability, recordEffortRejection, clearEffortRejections } from './effortCapabilities.js'

const originalConfig = process.env.CLAUDE_CONFIG_DIR
const originalProvider = process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
const originalBase = process.env.ANTHROPIC_BASE_URL
let configDir = ''

beforeEach(() => {
  configDir = join(tmpdir(), `doge-effort-${process.pid}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(configDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
  delete process.env.ANTHROPIC_BASE_URL
  clearEffortRejections()
})
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  if (originalProvider === undefined) delete process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
  else process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = originalProvider
  if (originalBase === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalBase
  clearEffortRejections()
})

function writeCatalog(reasoning: Record<string, unknown> | undefined): void {
  writeFileSync(join(configDir, 'model-catalog.json'), JSON.stringify({
    modelCatalog: {
      version: 2,
      connections: [{
        id: 'c1',
        name: 'catalog',
        protocol: 'openai',
        baseURL: 'https://agi.tongji.edu.cn',
        models: [{
          id: 'm1',
          upstreamModel: 'DeepSeek-V4.1-Flash',
          displayName: 'DeepSeek-V4.1-Flash',
          ...(reasoning ? { reasoning } : {}),
        }],
        defaultModelId: 'm1',
      }],
      defaultModel: { connectionId: 'c1', modelId: 'm1' },
    },
  }))
}

test('first-party Opus 4.8 exposes the full ladder with adaptive thinking', () => {
  expect(getEffortCapability('claude-opus-4-8')).toMatchObject({
    supportsEffort: true,
    supportsMax: true,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinking: 'adaptive',
  })
})

test('catalog policy is the single source for custom models', () => {
  writeCatalog({
    preset: 'deepseek',
    thinking: { mode: 'always' },
    effort: { mode: 'named', field: 'reasoning_effort', levels: ['low', 'high', 'max'] },
    response: { openaiFields: ['reasoning_content', 'reasoning'], display: 'full' },
  })
  expect(getEffortCapability('DeepSeek-V4.1-Flash')).toMatchObject({
    supportsEffort: true,
    supportsMax: true,
    levels: ['low', 'high', 'max'],
    source: 'catalog',
  })
})

test('catalog policy with effort none hides all levels', () => {
  writeCatalog({
    preset: 'generic',
    thinking: { mode: 'none' },
    effort: { mode: 'none' },
    response: { openaiFields: ['reasoning_content'], display: 'full' },
  })
  expect(getEffortCapability('DeepSeek-V4.1-Flash')).toMatchObject({
    supportsEffort: false,
    levels: [],
    source: 'catalog',
  })
})

test('a runtime 400 effort rejection disables effort for the session', () => {
  writeCatalog({
    preset: 'deepseek',
    thinking: { mode: 'always' },
    effort: { mode: 'named', field: 'reasoning_effort', levels: ['low', 'high', 'max'] },
    response: { openaiFields: ['reasoning_content'], display: 'full' },
  })
  expect(getEffortCapability('DeepSeek-V4.1-Flash').supportsEffort).toBe(true)
  recordEffortRejection('DeepSeek-V4.1-Flash')
  expect(getEffortCapability('DeepSeek-V4.1-Flash').supportsEffort).toBe(false)
  clearEffortRejections()
})

test('protocol comes from the configured compatibility provider', () => {
  process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'responses'
  expect(getEffortCapability('claude-opus-4-8').protocol).toBe('responses')
})

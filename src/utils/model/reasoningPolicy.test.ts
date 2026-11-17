import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { planEffortWire } from './effortGateway.js'
import { getAppliedEffortValue } from '../effort.js'
import { catalogModelForRequest } from './modelCatalog.js'
import {
  getHostReasoningPolicy,
  clearHostReasoningDisables,
  disableHostReasoningPolicy,
  getCatalogReasoningPolicy,
  hostReasoningLevels,
  hostResponseFields,
  planHostReasoning,
  type HostReasoningPolicy,
} from './reasoningPolicy.js'

const originalConfig = process.env.CLAUDE_CONFIG_DIR
const originalConnection = process.env.DOGE_ACTIVE_CONNECTION_ID
let configDir = ''
beforeEach(() => {
  configDir = join(tmpdir(), `doge-reasoning-${process.pid}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(configDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.DOGE_ACTIVE_CONNECTION_ID
})
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  if (originalConnection === undefined) delete process.env.DOGE_ACTIVE_CONNECTION_ID
  else process.env.DOGE_ACTIVE_CONNECTION_ID = originalConnection
})

function writeCatalog(models: Array<{ model: string; policy: HostReasoningPolicy }>): void {
  writeFileSync(join(configDir, 'model-catalog.json'), JSON.stringify({
    modelCatalog: {
      version: 2,
      connections: [{
        id: 'c1',
        name: 'catalog',
        protocol: 'openai',
        models: models.map((item, index) => ({
          id: `m${index}`,
          upstreamModel: item.model,
          displayName: item.model,
          reasoning: item.policy,
        })),
        defaultModelId: 'm0',
      }],
      defaultModel: { connectionId: 'c1', modelId: 'm0' },
    },
  }))
}

const deepseek: HostReasoningPolicy = {
  preset: 'deepseek',
  thinking: { mode: 'always' },
  effort: { mode: 'named', field: 'reasoning_effort', levels: ['low', 'high', 'max'] },
  response: { openaiFields: ['reasoning', 'reasoning_content'], display: 'full' },
}

const qwen: HostReasoningPolicy = {
  preset: 'qwen',
  thinking: { mode: 'toggle', field: 'enable_thinking', on: true, off: false },
  effort: {
    mode: 'budget',
    field: 'thinking_budget',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    budgets: { low: 1024, medium: 4096, high: 16384, xhigh: 24576, max: 32768 },
    maxBudget: 32768,
    reserveOutputTokens: 1024,
  },
  response: { openaiFields: ['reasoning_content'], display: 'full' },
}

const anthropic: HostReasoningPolicy = {
  preset: 'anthropic',
  thinking: { mode: 'value', field: 'thinking', value: { type: 'adaptive', display: 'summarized' } },
  effort: { mode: 'named', field: 'output_config.effort', levels: ['low', 'medium', 'high'] },
  response: { openaiFields: [], display: 'full' },
}

const responses: HostReasoningPolicy = {
  preset: 'openai',
  thinking: { mode: 'value', field: 'reasoning.summary', value: 'auto' },
  effort: { mode: 'named', field: 'reasoning.effort', levels: ['low', 'medium', 'high'] },
  response: { openaiFields: ['reasoning_summary_text'], display: 'summary' },
}

test('reads policy from the model catalog only for matching models', () => {
  writeCatalog([{ model: 'DeepSeek-V4.1-Flash', policy: deepseek }])
  expect(getHostReasoningPolicy('DeepSeek-V4.1-Flash')?.preset).toBe('deepseek')
  expect(getHostReasoningPolicy('GLM-5.3')).toBeUndefined()
})

test('reads a role model policy from the same catalog connection', () => {
  writeCatalog([
    { model: 'DeepSeek-V4.1-Flash', policy: deepseek },
    {
      model: 'GLM-5.3',
      policy: {
        preset: 'glm',
        thinking: { mode: 'always' },
        effort: { mode: 'named', field: 'reasoning_effort', levels: ['low', 'high', 'max'] },
        response: { openaiFields: ['reasoning'], display: 'full' },
      },
    },
  ])
  expect(getHostReasoningPolicy('GLM-5.3')?.preset).toBe('glm')
  expect(getHostReasoningPolicy('DeepSeek-V4.1-Flash')?.preset).toBe('deepseek')
})

test('deepseek named effort maps the selected level and keeps response alias', () => {
  const plan = planHostReasoning({ policy: deepseek, requested: 'high' })
  expect(plan.wireEffort).toBeUndefined()
  expect(plan.extraBody).toEqual({ reasoning_effort: 'high' })
  expect(plan.applied).toBe('high')
  expect(plan.levels).toEqual(['low', 'high', 'max'])
  expect(plan.supportsMax).toBe(true)
  expect(plan.responseFields).toEqual(['reasoning', 'reasoning_content'])
})

test('qwen budget turns on thinking and clamps the budget to output limit', () => {
  const plan = planHostReasoning({ policy: qwen, requested: 'high', maxOutputTokens: 8192 })
  expect(plan.extraBody).toEqual({ enable_thinking: true, thinking_budget: 7168 })
  expect(plan.applied).toBe('high')
  expect(hostResponseFields(qwen)).toEqual(['reasoning_content'])
})

test('anthropic adaptive keeps thinking outside output_config effort', () => {
  const plan = planHostReasoning({ policy: anthropic, requested: 'medium', maxOutputTokens: 4096 })
  expect(plan.wireEffort).toBe('medium')
  expect(plan.extraBody).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } })
  expect(plan.thinking).toBe('adaptive')
})

test('auto requested still emits adaptive thinking but no effort', () => {
  const plan = planHostReasoning({ policy: anthropic, requested: undefined })
  expect(plan.wireEffort).toBeUndefined()
  expect(plan.extraBody).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } })
  expect(plan.applied).toBeUndefined()
})

test('responses effort is nested under reasoning and summary stays', () => {
  const plan = planHostReasoning({ policy: responses, requested: 'high' })
  expect(plan.extraBody).toEqual({ reasoning: { effort: 'high', summary: 'auto' } })
  expect(plan.responseFields).toEqual(['reasoning_summary_text'])
})

test('unsupported requested level downgrades to auto', () => {
  const plan = planHostReasoning({ policy: deepseek, requested: 'xhigh' })
  expect(plan.extraBody).toBeUndefined()
  expect(plan.applied).toBeUndefined()
  expect(plan.downgraded).toBe(true)
  expect(plan.warnings.length).toBe(1)
})

test('auto uses the configured default level', () => {
  const policy: HostReasoningPolicy = {
    ...deepseek,
    effort: { ...deepseek.effort, defaultLevel: 'high' }
  }
  const plan = planHostReasoning({ policy, requested: undefined })
  expect(plan.extraBody).toEqual({ reasoning_effort: 'high' })
  expect(plan.applied).toBe('high')
})

test('levels helper returns the declared ladder only', () => {
  expect(hostReasoningLevels(deepseek)).toEqual(['low', 'high', 'max'])
  expect(hostReasoningLevels({ ...deepseek, effort: { mode: 'none' } })).toEqual([])
})

test('explicit effort suppression keeps independent thinking and host Auto uses the catalog default', () => {
  const prev = process.env.CLAUDE_CODE_EFFORT_LEVEL
  const disabled = process.env.CLAUDE_CODE_DISABLE_EFFORT
  const host = process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
  const hostAuto = process.env.DOGE_HOST_EFFORT_DEFAULT
  const protocol = process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
  const policy: HostReasoningPolicy = { ...anthropic, effort: { ...anthropic.effort, defaultLevel: 'high' } }
  writeCatalog([{ model: 'catalog-model', policy }])
  try {
    for (const value of ['unset', 'auto']) {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = value
      const plan = planEffortWire({ model: 'catalog-model', requested: undefined })
      expect(plan.wireEffort).toBeUndefined()
      expect(plan.extraBody).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } })
      expect(getAppliedEffortValue('catalog-model', undefined)).toBeUndefined()
    }
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.DOGE_HOST_EFFORT_DEFAULT = '1'
    process.env.DOGE_ACTIVE_CONNECTION_ID = 'c1'
    process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'openai'
    expect(planEffortWire({ model: 'catalog-model', requested: undefined }).wireEffort).toBe('high')
    expect(getAppliedEffortValue('catalog-model', undefined)).toBe('high')
    process.env.CLAUDE_CODE_DISABLE_EFFORT = '1'
    expect(planEffortWire({ model: 'catalog-model', requested: undefined }).wireEffort).toBeUndefined()
    expect(getAppliedEffortValue('catalog-model', undefined)).toBeUndefined()
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = prev
    if (disabled === undefined) delete process.env.CLAUDE_CODE_DISABLE_EFFORT
    else process.env.CLAUDE_CODE_DISABLE_EFFORT = disabled
    if (host === undefined) delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    else process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = host
    if (hostAuto === undefined) delete process.env.DOGE_HOST_EFFORT_DEFAULT
    else process.env.DOGE_HOST_EFFORT_DEFAULT = hostAuto
    if (protocol === undefined) delete process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
    else process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = protocol
  }
})

test('catalog limits and reasoning never fall through to an unrelated connection', () => {
  writeFileSync(join(configDir, 'model-catalog.json'), JSON.stringify({ modelCatalog: {
    version: 2,
    connections: [
      { id: 'a', name: 'A', protocol: 'openai', models: [{ id: 'm1', upstreamModel: 'same', maxOutputTokens: 8000 }] },
      { id: 'b', name: 'B', protocol: 'openai', models: [
        { id: 'm2', upstreamModel: 'same', maxOutputTokens: 16000, reasoning: deepseek },
        { id: 'm3', upstreamModel: 'b-only', reasoning: qwen },
      ] },
    ],
  } }))
  expect(catalogModelForRequest('same', { DOGE_ACTIVE_CONNECTION_ID: 'a' })?.maxOutputTokens).toBe(8000)
  expect(catalogModelForRequest('same', { DOGE_ACTIVE_CONNECTION_ID: 'a' })?.reasoning).toBeUndefined()
  expect(catalogModelForRequest('same', { DOGE_ACTIVE_CONNECTION_ID: 'b' })?.maxOutputTokens).toBe(16000)
  expect(catalogModelForRequest('b-only', { DOGE_ACTIVE_CONNECTION_ID: 'a' })).toBeUndefined()
  expect(catalogModelForRequest('same', { DOGE_ACTIVE_CONNECTION_ID: 'deleted' })).toBeUndefined()
})

test('disabled thinking turns off a gateway toggle without sending a budget', () => {
  const plan = planHostReasoning({ policy: qwen, requested: 'high', thinkingEnabled: false })
  expect(plan.extraBody).toEqual({ enable_thinking: false })
  expect(plan.applied).toBeUndefined()
})

test('suppressed effort preserves unrelated nested fields and the Anthropic budget floor', () => {
  const policy = { ...responses, extraBody: { reasoning: { effort: 'high', summary: 'auto' } } }
  expect(planHostReasoning({ policy, requested: 'high', suppressEffort: true }).extraBody).toEqual({ reasoning: { summary: 'auto' } })
  const budgetPolicy: HostReasoningPolicy = { ...anthropic, thinking: { mode: 'budget', field: 'thinking' } }
  expect(planHostReasoning({ policy: budgetPolicy, requested: undefined, maxOutputTokens: 1024 }).extraBody).toBeUndefined()
  expect(planHostReasoning({ policy: budgetPolicy, requested: undefined, maxOutputTokens: 1025 }).extraBody).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } })
})

test('wire rejection leaves response display rules available and applies only to the current route', () => {
  const policy: HostReasoningPolicy = { ...responses, response: { openaiFields: [], display: 'none' } }
  writeCatalog([{ model: 'same-model', policy }])
  process.env.DOGE_ACTIVE_CONNECTION_ID = 'c1'
  try {
    disableHostReasoningPolicy('same-model')
    expect(getHostReasoningPolicy('same-model')).toBeUndefined()
    expect(getCatalogReasoningPolicy('same-model')?.response.display).toBe('none')
    delete process.env.DOGE_ACTIVE_CONNECTION_ID
    expect(getHostReasoningPolicy('same-model')?.response.display).toBe('none')
  } finally {
    clearHostReasoningDisables()
  }
})

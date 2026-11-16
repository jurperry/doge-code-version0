import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getHostReasoningPolicy,
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

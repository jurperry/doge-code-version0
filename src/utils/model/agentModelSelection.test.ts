import { afterEach, expect, test } from 'bun:test'
import { resolveAgentModelSelection } from './agentModelSelection.js'
import { formatAgentModel } from './agentModelIdentity.js'

const saved = { ...process.env }
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

test('agent identity retains aliases while execution uses concrete models', () => {
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.3[1m]'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5.3[1m]'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-5.3-flash[1m]'
  for (const alias of ['opus', 'sonnet', 'haiku', 'inherit'] as const) {
    const real = alias === 'haiku' ? 'glm-5.3-flash[1m]' : 'glm-5.3[1m]'
    const selection = resolveAgentModelSelection(undefined, 'glm-5.3[1m]', alias)
    expect(selection.resolvedModel).toBe(real)
    expect(selection.requestedModel).toBe(alias)
    expect(formatAgentModel(real, selection)).toBe(`${alias}(${real.replace('[1m]', '')})`)
    process.env.ANTHROPIC_MODEL = 'changed-default'
    expect(selection.resolvedModel).toBe(real)
  }
})

test('definition, explicit inherit and environment retain current resolution priority', () => {
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  expect(resolveAgentModelSelection('custom-agent', 'parent', 'inherit')).toMatchObject({ requestedModel: 'inherit', resolvedModel: 'custom-agent', source: 'definition' })
  expect(resolveAgentModelSelection(undefined, 'parent')).toMatchObject({ requestedModel: 'inherit', resolvedModel: 'parent', source: 'inherit' })
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'forced-model'
  const selection = resolveAgentModelSelection('definition', 'parent', 'opus')
  expect(selection).toMatchObject({ requestedModel: 'opus', resolvedModel: 'forced-model', source: 'environment' })
  expect(formatAgentModel(selection.resolvedModel, selection)).toBe('opus(forced-model)')
})

test('old events never guess a real model from a current default', () => {
  expect(formatAgentModel('glm-5.3[1m]')).toBe('glm-5.3')
  expect(formatAgentModel('opus')).toBe('opus(未解析)')
  expect(formatAgentModel(undefined)).toBe('inherit(未解析)')
})

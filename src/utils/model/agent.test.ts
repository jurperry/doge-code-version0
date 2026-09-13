import { afterEach, describe, expect, test } from 'bun:test'
import { getAgentModel } from './agent.js'

const savedSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL

afterEach(() => {
  if (savedSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = savedSubagentModel
  }
})

describe('getAgentModel — tool-specified model', () => {
  test("'inherit' behaves like omitting the parameter (agent def fallback)", () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    const omitted = getAgentModel(
      'haiku',
      'claude-sonnet-4-5',
      undefined,
      'default',
    )
    const explicit = getAgentModel(
      'haiku',
      'claude-sonnet-4-5',
      'inherit',
      'default',
    )
    expect(explicit).toBe(omitted)
    // The regression this guards: a literal 'inherit' reaching the API.
    expect(explicit).not.toBe('inherit')
  })

  test("'inherit' with no agent def resolves to the parent model, not the literal", () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    const resolved = getAgentModel(
      undefined,
      'claude-sonnet-4-5',
      'inherit',
      'default',
    )
    expect(resolved).not.toBe('inherit')
    expect(resolved.length).toBeGreaterThan(0)
  })

  test('a real alias still resolves to a concrete model id', () => {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    const resolved = getAgentModel(
      undefined,
      'claude-sonnet-4-5',
      'opus',
      'default',
    )
    expect(resolved).not.toBe('opus')
    expect(resolved).not.toBe('inherit')
    expect(resolved.length).toBeGreaterThan(0)
  })
})

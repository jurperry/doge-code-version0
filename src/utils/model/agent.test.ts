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

describe('getAgentModel — CLAUDE_CODE_SUBAGENT_MODEL env', () => {
  test("env 'inherit' falls through to agent-def/parent resolution, not the literal (audit fix)", () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'inherit'
    // Agent def also 'inherit' → parent model. The regression this guards:
    // parseUserSpecifiedModel passes unknown strings through unchanged, so the
    // literal 'inherit' used to be sent straight to the API.
    const resolved = getAgentModel(
      'inherit',
      'claude-sonnet-4-5',
      undefined,
      'default',
    )
    expect(resolved).toBe('claude-sonnet-4-5')
  })

  test('env value still overrides everything when concrete', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-haiku-4-5'
    expect(getAgentModel('opus', 'claude-sonnet-4-5', 'haiku', 'default')).toBe(
      'claude-haiku-4-5',
    )
  })
})

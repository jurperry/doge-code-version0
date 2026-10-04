import { afterEach, describe, expect, test } from 'bun:test'
import { buildAgentModelOptions, getAgentModel } from './agent.js'

const savedSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL

afterEach(() => {
  if (savedSubagentModel === undefined) {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  } else {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = savedSubagentModel
  }
})

describe('getAgentModel — tool-specified model', () => {
  test('workflow resolution ignores the global override while ordinary agents retain it', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'global-override'
    expect(getAgentModel(undefined, 'parent', 'haiku', 'default')).toBe('global-override')
    expect(getAgentModel(undefined, 'parent', 'haiku', 'default', { ignoreEnvironmentOverride: true })).not.toBe('global-override')
  })
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

describe('buildAgentModelOptions — /agents model picker', () => {
  test('profiles contribute main model AND tier slots, labelled by provider', () => {
    const options = buildAgentModelOptions(
      [
        {
          model: 'glm-5.2',
          providerName: 'GLM',
          defaultHaikuModel: 'glm-5.2-flash',
        },
      ],
      [],
    )
    const values = options.map((o) => o.value)
    expect(values).toContain('glm-5.2')
    // The blind spot this guards: tier models never entered the legacy
    // savedModels index, so they were invisible in the picker.
    expect(values).toContain('glm-5.2-flash')
    const flash = options.find((o) => o.value === 'glm-5.2-flash')!
    expect(flash.description).toContain('GLM')
    expect(flash.description).toContain('Haiku tier')
  })

  test('standard aliases are ALWAYS present, even with custom models', () => {
    // Old behavior: non-empty savedModels swapped the list to custom-only,
    // dropping sonnet/opus/haiku. Aliases must survive — they resolve
    // against the active provider's tier env at run time.
    const options = buildAgentModelOptions(
      [{ model: 'deepseek-chat', providerName: 'DS' }],
      ['kimi-k3'],
    )
    const values = options.map((o) => o.value)
    for (const alias of ['sonnet', 'opus', 'haiku', 'inherit']) {
      expect(values).toContain(alias)
    }
    expect(values[values.length - 1]).toBe('inherit')
    expect(values).toContain('deepseek-chat')
    expect(values).toContain('kimi-k3')
  })

  test('no profiles, no saved models → exactly the four standard options', () => {
    const values = buildAgentModelOptions([], []).map((o) => o.value)
    expect(values).toEqual(['sonnet', 'opus', 'haiku', 'inherit'])
  })

  test('dedupe by exact string only — [1m] variants stay distinct', () => {
    const options = buildAgentModelOptions(
      [
        {
          model: 'kimi-k3',
          providerName: 'Kimi',
          defaultHaikuModel: 'kimi-k3[1m]',
        },
        { model: 'kimi-k3', providerName: 'Kimi-mirror' },
      ],
      ['kimi-k3', '  glm-5.2  '],
    )
    const values = options.map((o) => o.value)
    expect(values.filter((v) => v === 'kimi-k3')).toHaveLength(1)
    expect(values).toContain('kimi-k3[1m]')
    // Trimmed, not collapsed with the bare id.
    expect(values).toContain('glm-5.2')
  })
})

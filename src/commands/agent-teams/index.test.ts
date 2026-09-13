import { afterEach, describe, expect, test } from 'bun:test'
import { isAgentSwarmsOptedIn } from '../../utils/agentSwarmsEnabled.js'
import agentTeams from './index.js'

const ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'
const savedEnv = process.env[ENV_KEY]

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
})

const fakeContext = {} as Parameters<
  typeof agentTeams.getPromptForCommand
>[1]

describe('/agent-teams command', () => {
  test('is a builtin prompt command with an argument hint', () => {
    expect(agentTeams.type).toBe('prompt')
    expect(agentTeams.name).toBe('agent-teams')
    expect(agentTeams.source).toBe('builtin')
    expect(agentTeams.argumentHint).toContain('requirement')
  })

  test('opts the session into agent teams when invoked', async () => {
    delete process.env[ENV_KEY]
    expect(isAgentSwarmsOptedIn()).toBe(false)
    await agentTeams.getPromptForCommand('do the thing', fakeContext)
    expect(isAgentSwarmsOptedIn()).toBe(true)
  })

  test('prompt carries the requirement and the model menu', async () => {
    const blocks = await agentTeams.getPromptForCommand(
      '重构登录模块并补测试',
      fakeContext,
    )
    const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n')
    expect(text).toContain('重构登录模块并补测试')
    expect(text).toContain('TeamCreate')
    expect(text).toContain('"opus"')
    expect(text).toContain('"sonnet"')
    expect(text).toContain('"haiku"')
    expect(text).toContain('"inherit"')
  })

  test('empty args ask the model to clarify instead of spawning', async () => {
    const blocks = await agentTeams.getPromptForCommand('', fakeContext)
    const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join('\n')
    expect(text).toContain('Ask the user')
  })

  test('is registered in the builtin command list', async () => {
    const { builtInCommandNames } = await import('../../commands.js')
    expect(builtInCommandNames().has('agent-teams')).toBe(true)
  })
})

/**
 * Integration test for the agent-teams keyword redirect in processUserInput:
 * a prompt expressing multi-agent intent, in a session not yet opted in,
 * must enable agent teams and re-route through /agent-teams (the expanded
 * team-lead prompt carries the original text). A session already opted in
 * must pass the text through untouched.
 *
 * Runs the real command resolution, prompt expansion and message assembly;
 * only getAppState/options are faked (attachments discovery finds nothing in
 * a bare context and UserPromptSubmit hooks yield nothing when unconfigured).
 */
import { afterEach, describe, expect, test } from 'bun:test'

const ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'
const savedEnv = process.env[ENV_KEY]

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
})

const { processUserInput } = await import('./processUserInput.js')
const agentTeamsCommand = (await import('../../commands/agent-teams/index.js'))
  .default
const { isAgentSwarmsOptedIn } = await import('../agentSwarmsEnabled.js')

function fakeContext() {
  return {
    options: {
      commands: [agentTeamsCommand],
      isNonInteractiveSession: false,
    },
    getAppState: () => ({
      toolPermissionContext: { mode: 'default' },
      ultraplanSessionUrl: undefined,
      ultraplanLaunching: undefined,
      sessionHooks: new Map(),
    }),
    setAppState: () => {},
    requestPrompt: () => {},
    messages: [],
  } as never
}

function textOf(result: { messages: unknown[] }) {
  return JSON.stringify(result.messages)
}

describe('agent-teams keyword redirect (processUserInput)', () => {
  test('keyword in a not-yet-opted-in session re-routes through /agent-teams', async () => {
    delete process.env[ENV_KEY]
    const result = await processUserInput({
      input: '请用多agent协作重构登录模块',
      mode: 'prompt',
      setToolJSX: () => {},
      context: fakeContext(),
    })
    // Session opted in as a side effect of the redirect.
    expect(isAgentSwarmsOptedIn()).toBe(true)
    // The command-message metadata names /agent-teams with the original text.
    expect(textOf(result)).toContain('/agent-teams')
    // The expanded team-lead prompt carries the original requirement and
    // the team tooling instructions.
    expect(textOf(result)).toContain('请用多agent协作重构登录模块')
    expect(textOf(result)).toContain('TeamCreate')
    expect(result.shouldQuery).toBe(true)
  })

  test('already opted-in session passes the text through as a plain prompt', async () => {
    process.env[ENV_KEY] = '1'
    const result = await processUserInput({
      input: '再提一次多agent协作也无妨',
      mode: 'prompt',
      setToolJSX: () => {},
      context: fakeContext(),
    })
    // Plain text prompt: no /agent-teams command metadata in the messages.
    expect(textOf(result)).not.toContain('/agent-teams')
    expect(textOf(result)).toContain('再提一次多agent协作也无妨')
  })

  test('non-interactive sessions never redirect', async () => {
    delete process.env[ENV_KEY]
    const context = fakeContext()
    context.options.isNonInteractiveSession = true
    const result = await processUserInput({
      input: 'use agent teams here',
      mode: 'prompt',
      setToolJSX: () => {},
      context,
    })
    expect(isAgentSwarmsOptedIn()).toBe(false)
    expect(textOf(result)).not.toContain('/agent-teams')
  })
})

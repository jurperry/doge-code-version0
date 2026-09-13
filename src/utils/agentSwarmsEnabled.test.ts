import { afterEach, describe, expect, test } from 'bun:test'
import {
  enableAgentSwarmsForSession,
  isAgentSwarmsEnabled,
  isAgentSwarmsOptedIn,
} from './agentSwarmsEnabled.js'

const ENV_KEY = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'

const savedEnv = process.env[ENV_KEY]
const savedUserType = process.env.USER_TYPE
const savedArgv = process.argv

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
  process.argv = savedArgv
})

describe('isAgentSwarmsOptedIn', () => {
  test('false with no env var and no flag', () => {
    delete process.env[ENV_KEY]
    process.argv = ['bun', 'doge']
    expect(isAgentSwarmsOptedIn()).toBe(false)
  })

  test('truthy env values count as opt-in', () => {
    process.env[ENV_KEY] = '1'
    process.argv = ['bun', 'doge']
    expect(isAgentSwarmsOptedIn()).toBe(true)
  })

  test('--agent-teams flag counts as opt-in', () => {
    delete process.env[ENV_KEY]
    process.argv = ['bun', 'doge', '--agent-teams']
    expect(isAgentSwarmsOptedIn()).toBe(true)
  })
})

describe('enableAgentSwarmsForSession', () => {
  test('opts the process in (env var set, isAgentSwarmsEnabled flips)', () => {
    delete process.env[ENV_KEY]
    process.argv = ['bun', 'doge']
    process.env.USER_TYPE = 'external'

    expect(isAgentSwarmsOptedIn()).toBe(false)
    enableAgentSwarmsForSession()
    expect(isAgentSwarmsOptedIn()).toBe(true)
    // Full gate follows the runtime opt-in (killswitch defaults to enabled).
    expect(isAgentSwarmsEnabled()).toBe(true)
  })
})

describe('mid-session activation reaches the per-query tool pool', () => {
  // The gate flips at runtime (/agent-teams or keyword trigger), while the
  // REPL's combinedInitialTools memo was snapshotted at mount. This only
  // works because assembleToolPool → getTools → getAllBaseTools re-evaluates
  // the gate on every call and mergeAndFilterTools unions the pools — lock
  // that contract so a future "optimization" can't silently break it.
  test('assembleToolPool picks up TeamCreate after a runtime enable', async () => {
    delete process.env[ENV_KEY]
    process.argv = ['bun', 'doge']
    process.env.USER_TYPE = 'external'

    const { assembleToolPool } = await import('../tools.js')
    const fakePermissionContext = {
      mode: 'default',
      alwaysDenyRules: {},
      denyRules: [],
    } as never

    const before = assembleToolPool(fakePermissionContext, [])
    expect(before.some(t => t.name === 'TeamCreate')).toBe(false)

    enableAgentSwarmsForSession()
    const after = assembleToolPool(fakePermissionContext, [])
    expect(after.some(t => t.name === 'TeamCreate')).toBe(true)
    expect(after.some(t => t.name === 'TeamDelete')).toBe(true)
  })
})

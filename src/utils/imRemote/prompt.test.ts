import { afterEach, describe, expect, test } from 'bun:test'
import { prepareRemotePrompt } from './prompt.js'

const key = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'
const saved = process.env[key]
afterEach(() => {
  if (saved === undefined) delete process.env[key]
  else process.env[key] = saved
})

describe('remote agent-teams prompts', () => {
  test('opts in before the caller assembles tools and expands every request', () => {
    delete process.env[key]
    expect(prepareRemotePrompt('请用多agent协作修复登录')).toBe('/agent-teams 请用多agent协作修复登录')
    expect(process.env[key]).toBe('1')
    expect(prepareRemotePrompt('use agent teams to review')).toBe('/agent-teams use agent teams to review')
  })

  test('explicit command opts in before command expansion', () => {
    delete process.env[key]
    expect(prepareRemotePrompt('  /agent-teams 检查项目')).toBe('/agent-teams 检查项目')
    expect(process.env[key]).toBe('1')
  })

  test.each([
    '  修复登录  ', '解释 `多agent协作` 这段文档', 'agent teams?',
    'look at src/agent-teams/foo.ts', '/rename agent teams', '/agent-teams-extra test', '',
  ])('preserves ordinary text and exclusions: %s', text => {
    delete process.env[key]
    expect(prepareRemotePrompt(text)).toBe(text)
    expect(process.env[key]).toBeUndefined()
  })
})

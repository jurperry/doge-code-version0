import { describe, expect, test } from 'bun:test'
import {
  buildAskAnswers,
  formatAgentEvent,
  formatAskMessage,
  formatPermissionMessage,
  formatToolSummary,
  formatTurnMessage,
  isPairCodeValid,
  isUserAllowed,
  lastAssistantText,
  parseAskPayload,
  parseImCommand,
  summaryDue,
  truncateText,
} from './format.js'
import type { ImRemoteConfig } from './types.js'

describe('parseImCommand', () => {
  test('plain text is a prompt, not a command', () => {
    expect(parseImCommand('帮我修一下登录页')).toBeNull()
    expect(parseImCommand('  /not-a-command 也当提示词')).toBeNull()
  })

  test('pair command validates the code shape', () => {
    expect(parseImCommand('/pair ab3x9k')).toEqual({ kind: 'pair', code: 'ab3x9k' })
    expect(parseImCommand('/PAIR AB3X9K')).toEqual({ kind: 'pair', code: 'ab3x9k' })
    expect(parseImCommand('/pair short')).toBeNull()
    expect(parseImCommand('/pair')).toBeNull()
  })

  test('status/stop/help with Chinese aliases', () => {
    expect(parseImCommand('/status')).toEqual({ kind: 'status' })
    expect(parseImCommand('/状态')).toEqual({ kind: 'status' })
    expect(parseImCommand('/stop')).toEqual({ kind: 'stop' })
    expect(parseImCommand('/帮助')).toEqual({ kind: 'help' })
  })

  test('numeric picks', () => {
    expect(parseImCommand('/2')).toEqual({ kind: 'pick', indices: [2] })
    expect(parseImCommand('/1,3')).toEqual({ kind: 'pick', indices: [1, 3] })
    expect(parseImCommand('/0')).toBeNull()
    expect(parseImCommand('/10')).toBeNull()
  })

  test('allow/deny/skip with aliases', () => {
    expect(parseImCommand('/allow')).toEqual({ kind: 'allow' })
    expect(parseImCommand('/yes')).toEqual({ kind: 'allow' })
    expect(parseImCommand('/deny')).toEqual({ kind: 'deny' })
    expect(parseImCommand('/no')).toEqual({ kind: 'deny' })
    expect(parseImCommand('/skip')).toEqual({ kind: 'skip' })
  })
})

describe('pairing', () => {
  const config = (pair?: { code: string; expires: number }): ImRemoteConfig => ({
    version: 1,
    enabled: true,
    platform: 'telegram',
    allowedUsers: [],
    autoMode: true,
    summaryEvery: 10,
    port: 4763,
    token: 'x'.repeat(24),
    pair,
  })

  test('requires matching unexpired code', () => {
    const now = Date.now()
    expect(isPairCodeValid(config({ code: 'ab3x9k', expires: now + 1000 }), 'ab3x9k', now)).toBeTrue()
    expect(isPairCodeValid(config({ code: 'ab3x9k', expires: now - 1 }), 'ab3x9k', now)).toBeFalse()
    expect(isPairCodeValid(config({ code: 'ab3x9k', expires: now + 1000 }), 'zzzz99', now)).toBeFalse()
    expect(isPairCodeValid(config(), 'ab3x9k', now)).toBeFalse()
  })

  test('allowlist membership', () => {
    expect(isUserAllowed('42', ['42'])).toBeTrue()
    expect(isUserAllowed('42', ['43'])).toBeFalse()
  })
})

describe('summary cadence', () => {
  test('fires only on every N-th call', () => {
    expect(summaryDue(0, 10)).toBeFalse()
    expect(summaryDue(5, 10)).toBeFalse()
    expect(summaryDue(10, 10)).toBeTrue()
    expect(summaryDue(20, 10)).toBeTrue()
    expect(summaryDue(10, 0)).toBeFalse()
  })
})

describe('message formatting', () => {
  test('turn message truncates long output', () => {
    const msg = formatTurnMessage('x'.repeat(2000), false, 65000)
    expect(msg).toContain('回合完成')
    expect(msg).toContain('65s')
    expect(msg.length).toBeLessThan(1700)
    expect(formatTurnMessage('', true, 1000)).toContain('中断')
  })

  test('tool summary mentions count and last tool', () => {
    expect(formatToolSummary(10, 'Edit')).toContain('10 次工具调用')
    expect(formatToolSummary(10, 'Edit')).toContain('Edit')
    expect(formatToolSummary(3, '')).not.toContain('最近')
  })

  test('agent events carry lifecycle wording', () => {
    expect(formatAgentEvent('started', ' researcher')).toContain('已启用子代理')
    expect(formatAgentEvent('completed', 'r', 'done summary')).toContain('子代理已完成')
    expect(formatAgentEvent('teams_on')).toContain('agent-teams')
  })

  test('ask message lists numbered options', () => {
    const msg = formatAskMessage('用哪个方案？', ['方案A', '方案B'], false)
    expect(msg).toContain('/1 方案A')
    expect(msg).toContain('/2 方案B')
    expect(msg).toContain('/skip')
    expect(formatAskMessage('q', ['a', 'b'], true)).toContain('多选')
  })

  test('permission message includes tool and commands', () => {
    const msg = formatPermissionMessage('Bash', 'run tests', 'npm test')
    expect(msg).toContain('Bash')
    expect(msg).toContain('/allow')
    expect(msg).toContain('/deny')
  })

  test('truncateText collapses whitespace', () => {
    expect(truncateText('  a \n b  ', 100)).toBe('a b')
    expect(truncateText('abcdef', 4)).toBe('abc…')
  })
})

describe('AskUserQuestion payload handling', () => {
  const input = {
    questions: [
      {
        question: '选哪个？',
        options: [
          { label: '甲', description: 'first' },
          { label: '乙', description: 'second' },
        ],
      },
    ],
  }

  test('parseAskPayload extracts question + labels', () => {
    expect(parseAskPayload(input)).toEqual({
      question: '选哪个？',
      options: ['甲', '乙'],
      multi: false,
    })
    expect(parseAskPayload({ questions: [] })).toBeNull()
    expect(parseAskPayload({ foo: 1 })).toBeNull()
    expect(parseAskPayload(null)).toBeNull()
  })

  test('parseAskPayload reads multiSelect', () => {
    expect(parseAskPayload({ questions: [{ question: 'q', multiSelect: true, options: [{ label: 'x' }] }] })?.multi).toBeTrue()
  })

  test('buildAskAnswers maps picks to labels joined like ChatPane', () => {
    const answers = buildAskAnswers(input, [2])
    expect(answers?.answers).toEqual({ '选哪个？': '乙' })
    const multi = buildAskAnswers(input, [1, 2])
    expect(multi?.answers).toEqual({ '选哪个？': '甲, 乙' })
    expect(buildAskAnswers(input, [9])).toBeNull()
  })
})

describe('lastAssistantText', () => {
  test('picks the last assistant message with text', () => {
    const messages = [
      { type: 'user', message: { content: 'hi' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '  final  ' }] } },
    ] as Parameters<typeof lastAssistantText>[0]
    expect(lastAssistantText(messages)).toBe('final')
    expect(lastAssistantText([])).toBe('')
  })
})

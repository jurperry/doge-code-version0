import { describe, expect, test } from 'bun:test'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { teammateRowLabel } from './TeammateAgentLine.js'

function fakeTeammate(
  overrides: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    id: 'tm-1',
    type: 'in_process_teammate',
    status: 'running',
    description: 'research',
    startTime: 0,
    outputFile: '/tmp/out',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'alice@team',
      agentName: 'alice',
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 's',
    },
    prompt: '',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  } as InProcessTeammateTaskState
}

describe('teammateRowLabel', () => {
  test('includes the model spec after the person name', () => {
    expect(teammateRowLabel(fakeTeammate({ model: 'opus' }))).toBe(
      'sub-agent-alice-opus(未解析)',
    )
  })

  test('shows the resolved model id (context suffix stripped)', () => {
    expect(teammateRowLabel(fakeTeammate({ model: 'glm-4.7[1m]' }))).toBe(
      'sub-agent-alice-glm-4.7',
    )
  })

  test('falls back to inherit when no model is recorded (legacy tasks)', () => {
    expect(teammateRowLabel(fakeTeammate())).toBe('sub-agent-alice-inherit(未解析)')
  })
})

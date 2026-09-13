import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import {
  TEAMMATE_PANEL_GRACE_MS,
  applyTeammatePanelTick,
  teammatePanelTickAction,
} from './teammatePanel.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'

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

describe('teammatePanelTickAction', () => {
  const NOW = 10_000

  test('running teammate → none', () => {
    expect(teammatePanelTickAction(fakeTeammate(), NOW)).toBe('none')
  })

  test('terminal without deadline → grace (first sighting)', () => {
    const t = fakeTeammate({ status: 'killed', notified: true })
    expect(teammatePanelTickAction(t, NOW)).toBe('grace')
  })

  test('terminal dismissed via x (evictAfter 0) → none', () => {
    const t = fakeTeammate({ status: 'killed', notified: true, evictAfter: 0 })
    expect(teammatePanelTickAction(t, NOW)).toBe('none')
  })

  test('terminal inside grace window → none', () => {
    const t = fakeTeammate({
      status: 'killed',
      notified: true,
      evictAfter: NOW + 1,
    })
    expect(teammatePanelTickAction(t, NOW)).toBe('none')
  })

  test('terminal past deadline → evict', () => {
    const t = fakeTeammate({ status: 'killed', notified: true, evictAfter: NOW })
    expect(teammatePanelTickAction(t, NOW)).toBe('evict')
  })
})

describe('applyTeammatePanelTick', () => {
  const NOW = 10_000

  function fakeSetAppState() {
    type State = Pick<AppState, 'tasks'>
    // Holder object so tests read the CURRENT state after updaters replace it.
    const holder: {
      state: State
      setAppState: (updater: (prev: AppState) => AppState) => void
    } = { state: { tasks: {} }, setAppState: () => {} }
    holder.setAppState = (updater: (prev: AppState) => AppState): void => {
      holder.state = updater(holder.state as unknown as AppState) as unknown as State
    }
    return holder
  }

  test('grace: assigns evictAfter = now + TEAMMATE_PANEL_GRACE_MS', () => {
    const h = fakeSetAppState()
    h.state.tasks = { 'tm-1': fakeTeammate({ status: 'killed', notified: true }) }
    applyTeammatePanelTick(h.state.tasks, NOW, h.setAppState)
    const updated = (h.state.tasks as Record<string, InProcessTeammateTaskState>)[
      'tm-1'
    ]
    expect(updated?.evictAfter).toBe(NOW + TEAMMATE_PANEL_GRACE_MS)
  })

  test('evict: removes past-deadline terminal teammate', () => {
    const h = fakeSetAppState()
    h.state.tasks = {
      'tm-1': fakeTeammate({
        status: 'killed',
        notified: true,
        evictAfter: NOW - 1,
      }),
    }
    applyTeammatePanelTick(h.state.tasks, NOW, h.setAppState)
    expect(h.state.tasks['tm-1']).toBeUndefined()
  })

  test('running teammate is untouched', () => {
    const h = fakeSetAppState()
    const running = fakeTeammate()
    h.state.tasks = { 'tm-1': running }
    applyTeammatePanelTick(h.state.tasks, NOW, h.setAppState)
    expect(h.state.tasks['tm-1']).toBe(running)
  })

  test('non-teammate tasks are ignored', () => {
    const h = fakeSetAppState()
    const localAgent = {
      id: 'a-1',
      type: 'local_agent',
      status: 'completed',
      description: '',
      startTime: 0,
      notified: true,
      retain: false,
    }
    h.state.tasks = { 'a-1': localAgent as unknown as AppState['tasks'][string] }
    applyTeammatePanelTick(h.state.tasks, NOW, h.setAppState)
    // Still present — local_agent eviction is handled by the panel's own path.
    expect(h.state.tasks['a-1']).toBe(localAgent)
  })
})

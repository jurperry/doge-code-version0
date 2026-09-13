import { describe, expect, test } from 'bun:test'
import type { AppState } from './AppState.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { stopOrDismissAgentWithDeps } from './teammateViewHelpers.js'
import type { StopOrDismissDeps } from './teammateViewHelpers.js'

type State = Pick<AppState, 'tasks' | 'viewingAgentTaskId' | 'viewSelectionMode'>

function fakeState(tasks: State['tasks'], viewingAgentTaskId?: string): State {
  return {
    tasks,
    viewingAgentTaskId,
    viewSelectionMode: viewingAgentTaskId ? 'viewing-agent' : 'none',
  }
}

function runStopOrDismiss(
  start: State,
  taskId: string,
  deps: Partial<StopOrDismissDeps> = {},
): State {
  let state = start
  const setAppState = (updater: (prev: AppState) => AppState): void => {
    state = updater(state as unknown as AppState) as unknown as State
  }
  stopOrDismissAgentWithDeps(taskId, setAppState, {
    requestTeammateShutdown: () => {},
    killTeammate: () => {},
    ...deps,
  })
  return state
}

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

function fakeLocalAgent(
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id: 'a-1',
    type: 'local_agent',
    status: 'running',
    description: 'explore',
    startTime: 0,
    endTime: undefined,
    outputFile: '/tmp/out',
    outputOffset: 0,
    notified: false,
    retain: false,
    evictAfter: undefined,
    pendingMessages: [],
    progress: undefined,
    ...overrides,
  } as unknown as LocalAgentTaskState
}

const flushMicrotasks = (): Promise<void> => new Promise(r => setTimeout(r, 0))

describe('stopOrDismissAgentWithDeps — teammate branch', () => {
  test('running + not shutting down → graceful shutdown requested, no kill', async () => {
    let shutdownCalled = false
    let killCalled = false
    const state = runStopOrDismiss(
      fakeState({ 'tm-1': fakeTeammate() }),
      'tm-1',
      {
        requestTeammateShutdown: () => {
          shutdownCalled = true
        },
        killTeammate: () => {
          killCalled = true
        },
      },
    )
    await flushMicrotasks()
    expect(shutdownCalled).toBe(true)
    expect(killCalled).toBe(false)
    // Graceful path flips nothing synchronously (side effects are deferred).
    expect(
      (state.tasks['tm-1'] as InProcessTeammateTaskState).status,
    ).toBe('running')
  })

  test('running + shutdown already requested → hard kill', async () => {
    let shutdownCalled = false
    let killCalled = false
    runStopOrDismiss(
      fakeState({
        'tm-1': fakeTeammate({ shutdownRequested: true }),
      }),
      'tm-1',
      {
        requestTeammateShutdown: () => {
          shutdownCalled = true
        },
        killTeammate: () => {
          killCalled = true
        },
      },
    )
    await flushMicrotasks()
    expect(shutdownCalled).toBe(false)
    expect(killCalled).toBe(true)
  })

  test('graceful shutdown passes teammate identity for the mailbox write', async () => {
    let received: { taskId: string; name: string; team?: string } | undefined
    runStopOrDismiss(fakeState({ 'tm-1': fakeTeammate() }), 'tm-1', {
      requestTeammateShutdown: (taskId, _name, teamName) => {
        received = { taskId, name: 'alice', team: teamName }
      },
    })
    await flushMicrotasks()
    expect(received).toEqual({
      taskId: 'tm-1',
      name: 'alice',
      team: 'team',
    })
  })

  test('terminal teammate → dismissed immediately, view exits if viewing', () => {
    const state = runStopOrDismiss(
      fakeState(
        { 'tm-1': fakeTeammate({ status: 'killed', notified: true }) },
        'tm-1',
      ),
      'tm-1',
    )
    expect((state.tasks['tm-1'] as InProcessTeammateTaskState).evictAfter).toBe(0)
    expect(state.viewingAgentTaskId).toBeUndefined()
    expect(state.viewSelectionMode).toBe('none')
  })
})

describe('stopOrDismissAgentWithDeps — local_agent branch (unchanged)', () => {
  test('running local_agent → abort, no state change', () => {
    let aborted = false
    const task = fakeLocalAgent({
      abortController: { abort: () => (aborted = true) } as never,
    })
    const before = { ...task }
    const state = runStopOrDismiss(fakeState({ 'a-1': task }), 'a-1')
    expect(aborted).toBe(true)
    expect(state.tasks['a-1']).toEqual(before)
  })

  test('terminal local_agent → evictAfter 0', () => {
    const state = runStopOrDismiss(
      fakeState({ 'a-1': fakeLocalAgent({ status: 'completed' }) }),
      'a-1',
    )
    expect((state.tasks['a-1'] as LocalAgentTaskState).evictAfter).toBe(0)
  })

  test('teammate graceful call does not throw when deps reject', () => {
    expect(() =>
      runStopOrDismiss(fakeState({ 'tm-1': fakeTeammate() }), 'tm-1', {
        requestTeammateShutdown: () => {
          throw new Error('boom')
        },
      }),
    ).not.toThrow()
  })
})

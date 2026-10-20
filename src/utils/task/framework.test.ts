import { test, expect } from 'bun:test'
import { evictTerminalTask, PANEL_GRACE_MS, registerTask } from './framework.js'
import { setSdkEventTap } from '../sdkEventQueue.js'
import type { TaskState } from '../../tasks/types.js'
import type { AppState } from '../../state/AppState.js'

type AnyTask = Record<string, unknown>

function runEvict(task: AnyTask): boolean {
  let state = { tasks: { t1: task } } as unknown as AppState
  evictTerminalTask('t1', updater => {
    state = updater(state)
    return state
  })
  return state.tasks?.t1 !== undefined
}

const baseTeammate = {
  id: 't1',
  type: 'in_process_teammate',
  status: 'completed',
  notified: true,
  description: 'test teammate',
}

test('evictTerminalTask: teammate inside panel grace is kept (runner path)', () => {
  expect(runEvict({ ...baseTeammate, evictAfter: Date.now() + 5_000 })).toBe(true)
})

test('evictTerminalTask: teammate past its deadline is evicted', () => {
  expect(runEvict({ ...baseTeammate, evictAfter: Date.now() - 1 })).toBe(false)
})

test('evictTerminalTask: terminal teammate without a deadline is kept until the panel tick stamps one', () => {
  expect(runEvict({ ...baseTeammate })).toBe(true)
})

test('evictTerminalTask: dismissed teammate (evictAfter=0) is evicted immediately', () => {
  expect(runEvict({ ...baseTeammate, evictAfter: 0 })).toBe(false)
})

test('evictTerminalTask: terminal task without evictAfter semantics keeps evict-immediately behavior', () => {
  // e.g. bash background tasks: no 'retain', not a teammate → no grace.
  expect(
    runEvict({ id: 't1', type: 'bash', status: 'completed', notified: true }),
  ).toBe(false)
})

test('evictTerminalTask: unnotified terminal teammate is kept (consumption pending)', () => {
  expect(runEvict({ ...baseTeammate, notified: false })).toBe(true)
})

test('PANEL_GRACE_MS stays in sync with the teammate panel grace', async () => {
  const { TEAMMATE_PANEL_GRACE_MS } = await import(
    '../../components/tasks/teammatePanel.js'
  )
  expect(PANEL_GRACE_MS).toBe(TEAMMATE_PANEL_GRACE_MS)
})

test('registerTask emits a new lifecycle on resume but not running handover', () => {
  let state = { tasks: {} } as unknown as AppState
  const events: Array<{ subtype: string; tool_use_id?: string }> = []
  setSdkEventTap(event => { events.push(event) })
  const setState = (updater: (previous: AppState) => AppState) => { state = updater(state) }
  const task = { id: 'agent', type: 'local_agent', status: 'running', description: 'worker', toolUseId: 'spawn' } as TaskState
  try {
    registerTask(task, setState)
    registerTask({ ...task }, setState)
    expect(events).toHaveLength(1)
    state = { ...state, tasks: { agent: { ...task, status: 'completed' } } }
    registerTask({ ...task, toolUseId: 'resume' }, setState)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ subtype: 'task_started', tool_use_id: 'resume' })
  } finally {
    setSdkEventTap(undefined)
  }
})

test('an old completion cannot consume the resumed invocation notification', async () => {
  const { enqueueAgentNotification } = await import('../../tasks/LocalAgentTask/LocalAgentTask.js')
  let state = { tasks: { agent: { id: 'agent', type: 'local_agent', status: 'running', toolUseId: 'resume', notified: false } } } as unknown as AppState
  const events: unknown[] = []
  setSdkEventTap(event => { events.push(event) })
  const setAppState = (updater: (previous: AppState) => AppState) => { state = updater(state) }
  try {
    enqueueAgentNotification({ taskId: 'agent', description: 'old', status: 'completed', toolUseId: 'spawn', setAppState, notificationMode: 'sdk-only' })
    expect(state.tasks.agent.notified).toBe(false)
    expect(events).toHaveLength(0)
    enqueueAgentNotification({ taskId: 'agent', description: 'new', status: 'completed', toolUseId: 'resume', setAppState, notificationMode: 'sdk-only' })
    expect(state.tasks.agent.notified).toBe(true)
    expect(events).toHaveLength(1)
  } finally {
    setSdkEventTap(undefined)
  }
})

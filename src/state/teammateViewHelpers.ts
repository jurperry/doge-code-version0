import { logEvent } from '../services/analytics/index.js'
import { isTerminalTaskStatus } from '../Task.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'

// Inlined from framework.ts — importing creates a cycle through
// BackgroundTasksDialog. Keep in sync with PANEL_GRACE_MS there.
const PANEL_GRACE_MS = 30_000

import type { AppState } from './AppState.js'

// Inline type check instead of importing isLocalAgentTask — breaks the
// teammateViewHelpers → LocalAgentTask runtime edge that creates a cycle
// through BackgroundTasksDialog.
function isLocalAgent(task: unknown): task is LocalAgentTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_agent'
  )
}

// Same inline pattern for teammates: only a shallow check lives here; the
// heavier swarm machinery is pulled in lazily via the injectable deps below.
function isInProcessTeammate(task: unknown): task is { type: 'in_process_teammate'; identity: { agentName: string; teamName?: string }; shutdownRequested: boolean } {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_teammate'
  )
}

/**
 * Return the task released back to stub form: retain dropped, messages
 * cleared, evictAfter set if terminal. Shared by exitTeammateView and
 * the switch-away path in enterTeammateView.
 */
function release(task: LocalAgentTaskState): LocalAgentTaskState {
  return {
    ...task,
    retain: false,
    messages: undefined,
    diskLoaded: false,
    evictAfter: isTerminalTaskStatus(task.status)
      ? Date.now() + PANEL_GRACE_MS
      : undefined,
  }
}

/**
 * Transitions the UI to view a teammate's transcript.
 * Sets viewingAgentTaskId and, for local_agent, retain: true (blocks eviction,
 * enables stream-append, triggers disk bootstrap) and clears evictAfter.
 * If switching from another agent, releases the previous one back to stub.
 */
export function enterTeammateView(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_enter', {})
  setAppState(prev => {
    const task = prev.tasks[taskId]
    const prevId = prev.viewingAgentTaskId
    const prevTask = prevId !== undefined ? prev.tasks[prevId] : undefined
    const switching =
      prevId !== undefined &&
      prevId !== taskId &&
      isLocalAgent(prevTask) &&
      prevTask.retain
    const needsRetain =
      isLocalAgent(task) && (!task.retain || task.evictAfter !== undefined)
    const needsView =
      prev.viewingAgentTaskId !== taskId ||
      prev.viewSelectionMode !== 'viewing-agent'
    if (!needsRetain && !needsView && !switching) return prev
    let tasks = prev.tasks
    if (switching || needsRetain) {
      tasks = { ...prev.tasks }
      if (switching) tasks[prevId] = release(prevTask)
      if (needsRetain) {
        tasks[taskId] = { ...task, retain: true, evictAfter: undefined }
      }
    }
    return {
      ...prev,
      viewingAgentTaskId: taskId,
      viewSelectionMode: 'viewing-agent',
      tasks,
    }
  })
}

/**
 * Exit teammate transcript view and return to leader's view.
 * Drops retain and clears messages back to stub form; if terminal,
 * schedules eviction via evictAfter so the row lingers briefly.
 */
export function exitTeammateView(
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  logEvent('tengu_transcript_view_exit', {})
  setAppState(prev => {
    const id = prev.viewingAgentTaskId
    const cleared = {
      ...prev,
      viewingAgentTaskId: undefined,
      viewSelectionMode: 'none' as const,
    }
    if (id === undefined) {
      return prev.viewSelectionMode === 'none' ? prev : cleared
    }
    const task = prev.tasks[id]
    if (!isLocalAgent(task) || !task.retain) return cleared
    return {
      ...cleared,
      tasks: { ...prev.tasks, [id]: release(task) },
    }
  })
}

/**
 * Context-sensitive x: running → stop, terminal → dismiss.
 * Dismiss sets evictAfter=0 so the filter hides immediately.
 * If viewing the dismissed agent, also exits to leader.
 *
 * Per type:
 * - local_agent: running → abort; terminal → dismiss.
 * - in_process_teammate: running → graceful shutdown (mailbox
 *   shutdown_request + [stopping] flag); already shutting down → hard kill
 *   (the pane fake task's abortController is wired to killPane); terminal →
 *   dismiss.
 *
 * The side-effecting teammate actions are injectable for tests; defaults
 * lazy-import the swarm modules so this state helper stays out of the
 * swarm import graph (cycle safety, same reason as the inline type checks).
 */
export type StopOrDismissDeps = {
  requestTeammateShutdown: (
    taskId: string,
    teammateName: string,
    teamName: string | undefined,
    setAppState: (updater: (prev: AppState) => AppState) => void,
  ) => void | Promise<void>
  killTeammate: (
    taskId: string,
    setAppState: (updater: (prev: AppState) => AppState) => void,
  ) => void | Promise<void>
}

const defaultStopOrDismissDeps: StopOrDismissDeps = {
  async requestTeammateShutdown(taskId, teammateName, teamName, setAppState) {
    const [{ sendShutdownRequestToMailbox }, { requestTeammateShutdown }] =
      await Promise.all([
        import('../utils/teammateMailbox.js'),
        import('../tasks/InProcessTeammateTask/InProcessTeammateTask.js'),
      ])
    await sendShutdownRequestToMailbox(
      teammateName,
      teamName,
      'Stopped from the agent panel',
    ).catch(() => {})
    requestTeammateShutdown(taskId, setAppState)
  },
  async killTeammate(taskId, setAppState) {
    const { InProcessTeammateTask } = await import(
      '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
    )
    await InProcessTeammateTask.kill(taskId, setAppState)
  },
}

export function stopOrDismissAgentWithDeps(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  deps: StopOrDismissDeps,
): void {
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (isLocalAgent(task)) {
      if (task.status === 'running') {
        task.abortController?.abort()
        return prev
      }
      if (task.evictAfter === 0) return prev
      const viewingThis = prev.viewingAgentTaskId === taskId
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: { ...release(task), evictAfter: 0 },
        },
        ...(viewingThis && {
          viewingAgentTaskId: undefined,
          viewSelectionMode: 'none',
        }),
      }
    }
    if (!isInProcessTeammate(task)) return prev
    if (task.status === 'running') {
      if (!task.shutdownRequested) {
        // Graceful: mailbox shutdown_request first, then the [stopping] flag.
        // Side effects are deferred out of the state updater (a sync throw
        // in deps must not break the state update either).
        void Promise.resolve()
          .then(() =>
            deps.requestTeammateShutdown(
              taskId,
              task.identity.agentName,
              task.identity.teamName,
              setAppState,
            ),
          )
          .catch(() => {})
      } else {
        // Shutdown already requested — escalate to a hard kill.
        void Promise.resolve()
          .then(() => deps.killTeammate(taskId, setAppState))
          .catch(() => {})
      }
      return prev
    }
    // Terminal teammate → dismiss immediately.
    if (task.evictAfter === 0) return prev
    const viewingThis = prev.viewingAgentTaskId === taskId
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: { ...task, evictAfter: 0 },
      },
      ...(viewingThis && {
        viewingAgentTaskId: undefined,
        viewSelectionMode: 'none',
      }),
    }
  })
}

export function stopOrDismissAgent(
  taskId: string,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  stopOrDismissAgentWithDeps(taskId, setAppState, defaultStopOrDismissDeps)
}

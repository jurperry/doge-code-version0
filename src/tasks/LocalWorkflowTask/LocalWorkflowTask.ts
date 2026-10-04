/**
 * LocalWorkflowTask — the umbrella AppState task for a declarative workflow
 * run (CLI 2.1.282). One run registers one task of type 'local_workflow':
 *  - print.ts holds the turn result back while it is running (background
 *    task check at print.ts:2270), so headless consumers stream step events
 *    live and get the final result after the workflow settles;
 *  - each in-process step additionally registers its own local_agent task
 *    (registerAsyncAgent), which is what surfaces per-step rows (with the
 *    P2 model badge) in the desktop shell's agent panel;
 *  - subprocess (cross-API profile) steps emit raw headless task_* events
 *    with synthesized ids — see engine.ts.
 *
 * The engine in tools/WorkflowTool/engine.ts owns every state transition.
 */

import type { Task, TaskStateBase } from '../../Task.js'

export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface WorkflowStepRun {
  stepId: string
  title: string
  status: WorkflowStepStatus
  /** short human summary (first line of output / error message) */
  summary?: string
  startedAt?: number
  durationMs?: number
}

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  workflowName: string
  /** raw argument string the user typed after the command */
  args: string
  abortController: AbortController
  unregisterCleanup?: () => void
  steps: WorkflowStepRun[]
}

export function isLocalWorkflowTask(
  value: unknown,
): value is LocalWorkflowTaskState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'local_workflow'
  )
}

/**
 * Polymorphic kill handle for the background-tasks dialog / TaskStopTool.
 * Aborting the controller stops the in-flight step (in-process agents have
 * linked abort controllers; subprocess children listen on the signal) and the
 * engine loop settles the umbrella as 'killed' with a notification.
 */
export const LocalWorkflowTask: Task = {
  name: 'workflow',
  type: 'local_workflow',
  async kill(taskId, setAppState): Promise<void> {
    let controller: AbortController | undefined
    let cleanup: (() => void) | undefined
    setAppState(prev => {
      const task = prev.tasks[taskId]
      if (!isLocalWorkflowTask(task) || task.status !== 'running') return prev
      controller = task.abortController
      cleanup = task.unregisterCleanup
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: {
            ...task,
            status: 'killed' as const,
            endTime: Date.now(),
            abortController: undefined,
            unregisterCleanup: undefined,
          },
        },
      }
    })
    cleanup?.()
    controller?.abort()
  },
}

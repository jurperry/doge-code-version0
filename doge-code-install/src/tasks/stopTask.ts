// Shared logic for stopping a running task.
// Used by TaskStopTool (LLM-invoked) and SDK stop_task control request.

import type { AppState } from '../state/AppState.js'
import type { TaskStateBase } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'
import { pendingShellKill } from './LocalShellTask/killShellTasks.js'

export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'not_running' | 'unsupported_type',
  ) {
    super(message)
    this.name = 'StopTaskError'
  }
}

type StopTaskContext = {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

type StopTaskResult = {
  taskId: string
  taskType: string
  command: string | undefined
}

/**
 * Look up a task by ID, validate it is running, kill it, and mark it as notified.
 *
 * Throws {@link StopTaskError} when the task cannot be stopped (not found,
 * not running, or unsupported type). Callers can inspect `error.code` to
 * distinguish the failure reason.
 */
export async function stopTask(
  taskId: string,
  context: StopTaskContext,
): Promise<StopTaskResult> {
  const { getAppState, setAppState } = context
  const appState = getAppState()
  const task = appState.tasks?.[taskId] as TaskStateBase | undefined

  if (!task) {
    throw new StopTaskError(`No task found with ID: ${taskId}`, 'not_found')
  }

  // A model TaskStop and an SDK/user Stop can overlap. The shell is marked
  // killed while the OS is still working; join that operation before ACK.
  const pendingStop = isLocalShellTask(task) ? pendingShellKill(taskId) : undefined
  if (task.status !== 'running' && !pendingStop) {
    throw new StopTaskError(
      `Task ${taskId} is not running (status: ${task.status})`,
      'not_running',
    )
  }

  const taskImpl = getTaskByType(task.type)
  if (!taskImpl) {
    throw new StopTaskError(
      `Unsupported task type: ${task.type}`,
      'unsupported_type',
    )
  }

  // Each implementation owns its terminal bookend, including internal cleanup
  // paths that do not pass through this model/SDK entry point.
  await (pendingStop ?? taskImpl.kill(taskId, setAppState))

  const command = isLocalShellTask(task) ? task.command : task.description

  return { taskId, taskType: task.type, command }
}

// Shared logic for stopping a running task.
// Used by TaskStopTool (LLM-invoked) and SDK stop_task control request.

import type { AppState } from '../state/AppState.js'
import type { TaskStateBase } from '../Task.js'
import { getTaskByType } from '../tasks.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'
import { isLocalShellTask } from './LocalShellTask/guards.js'

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

  if (task.status !== 'running') {
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

  // notified 标志必须在 kill 之前读：LocalShellTask.kill → killTask 会先给
  // 状态盖上 notified:true，事后检查恒见"已通知"而静默跳过下面的直发 SDK
  // 终态——shell 任务的 stopped 事件从未到达过 SDK 消费方（潜伏 bug，由
  // print.ts 的工作流步骤子进程退出清扫暴露）。
  const notifiedBefore = (() => {
    const current = getAppState().tasks?.[taskId]
    return !current || current.notified === true
  })()

  await taskImpl.kill(taskId, setAppState)

  // Bash: suppress the "exit code 137" XML notification (noise) — the state
  // flag is already stamped by killTask, and the SDK bookend is emitted
  // directly so consumers (desktop shell panels) see the task close. Agent
  // tasks: don't suppress — the AbortError catch sends a notification
  // carrying extractPartialResult(agentMessages), which is the payload not
  // noise.
  if (isLocalShellTask(task) && !notifiedBefore) {
    emitTaskTerminatedSdk(taskId, 'stopped', {
      toolUseId: task.toolUseId,
      summary: task.description,
    })
  }

  const command = isLocalShellTask(task) ? task.command : task.description

  return { taskId, taskType: task.type, command }
}

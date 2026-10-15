// Pure (non-React) kill helpers for LocalShellTask.
// Extracted so runAgent.ts can kill agent-scoped bash tasks without pulling
// React/Ink into its module graph (same rationale as guards.ts).

import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { dequeueAllMatching, enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { isLocalShellTask, type LocalShellTaskState } from './guards.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

/** 在途 OS 级树杀（taskId → 完成承诺）。killTask 异步发射 treeKill；即将
 *  退出进程的调用方（工作流步骤子进程清扫）必须先等它们落地，否则
 *  taskkill 随父进程退出而死，被"杀"的命令沦为孤儿继续跑。 */
const pendingTreeKills = new Map<string, Promise<void>>()

export function pendingShellKill(taskId: string): Promise<void> | undefined {
  return pendingTreeKills.get(taskId)
}

/** 全部在途树杀落定后 resolve（调用方应与自己的超时 race；空表立即 resolve）。 */
export function pendingShellKills(): Promise<unknown> {
  return Promise.allSettled([...pendingTreeKills.values()])
}

export async function killTask(taskId: string, setAppState: SetAppStateFn): Promise<void> {
  const pending = pendingTreeKills.get(taskId)
  if (pending) return pending
  let killSettled: Promise<void> | null = null
  let stopped: LocalShellTaskState | undefined
  let failure: unknown
  updateTaskState(taskId, setAppState, task => {
    if (task.status !== 'running' || !isLocalShellTask(task)) {
      return task
    }
    try {
      logForDebugging(`LocalShellTask ${taskId} kill requested`)
      task.shellCommand?.kill()
      killSettled = task.shellCommand?.killSettled ?? null
    } catch (error) {
      failure = error
      return task
    }
    stopped = task

    return {
      ...task,
      status: 'killed',
      notified: true,
      terminationPending: true,
      endTime: Date.now(),
    }
  })
  if (failure) throw failure
  if (!stopped) return
  const terminal = stopped
  const completion = Promise.resolve(killSettled).then(() => {
    terminal.shellCommand?.cleanup()
    terminal.unregisterCleanup?.()
    if (terminal.cleanupTimeoutId) clearTimeout(terminal.cleanupTimeoutId)
    updateTaskState(taskId, setAppState, task => ({ ...task, terminationPending: undefined, shellCommand: null, unregisterCleanup: undefined, cleanupTimeoutId: undefined }))
    emitTaskTerminatedSdk(taskId, 'stopped', {
      toolUseId: terminal.toolUseId,
      summary: terminal.description,
      outputFile: terminal.outputFile,
    })
    void evictTaskOutput(taskId)
  }).catch(error => {
    updateTaskState(taskId, setAppState, task =>
      task.status === 'killed' ? { ...terminal, status: 'running' } : task)
    throw error
  }).finally(() => pendingTreeKills.delete(taskId))
  pendingTreeKills.set(taskId, completion)
  await completion
}

/** Transfer live commands and queued notifications to the next owner.
 * Future completion callbacks read the current owner. */
export function handoffShellTasksForAgent(agentId: AgentId, setAppState: SetAppStateFn, owner?: AgentId): void {
  setAppState(prev => {
    const tasks = { ...prev.tasks }
    for (const [id, task] of Object.entries(tasks)) {
      if (isLocalShellTask(task) && task.agentId === agentId && task.status === 'running' && task.isBackgrounded) {
        tasks[id] = { ...task, agentId: owner }
      }
    }
    return { ...prev, tasks }
  })
  for (const command of dequeueAllMatching(cmd => cmd.agentId === agentId && cmd.mode === 'task-notification')) {
    enqueuePendingNotification({ ...command, agentId: owner })
  }
}

/**
 * Kill all running bash tasks spawned by a given agent.
 * Called from runAgent.ts finally block so background processes don't outlive
 * the agent that started them (prevents 10-day fake-logs.sh zombies).
 */
export async function killShellTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): Promise<void> {
  const tasks = getAppState().tasks ?? {}
  const stopping: Promise<void>[] = []
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isLocalShellTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killShellTasksForAgent: killing orphaned shell task ${taskId} (agent ${agentId} exiting)`,
      )
      stopping.push(killTask(taskId, setAppState))
    }
  }
  // Purge any queued notifications addressed to this agent — its query loop
  // has exited and won't drain them. SDK terminal bookends are emitted by
  // killTask and do not need a model query to consume them.
  const results = await Promise.allSettled(stopping)
  // A command may have finished naturally while its owning workflow/agent
  // was busy. Its queued XML has not reached print.ts. Preserve that SDK
  // bookend before discarding messages addressed to the departed owner.
  const current = getAppState().tasks ?? {}
  for (const command of dequeueAllMatching(cmd => cmd.agentId === agentId)) {
    if (command.mode !== 'task-notification' || typeof command.value !== 'string') continue
    const id = command.value.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
    const task = id ? current[id] : undefined
    const tag = (name: string) => (command.value as string).match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1]
    const status = tag('status')
    if (id && (isLocalShellTask(task) || tag('task-type') === 'local_bash') && (status === 'completed' || status === 'failed')) {
      emitTaskTerminatedSdk(id, status, { toolUseId: tag('tool-use-id'), summary: tag('summary'), outputFile: tag('output-file') })
    }
  }
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Failed to stop agent background commands')
}

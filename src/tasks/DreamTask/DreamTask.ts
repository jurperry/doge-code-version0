// Background task entry for auto-dream (memory consolidation subagent).
// Makes the otherwise-invisible forked agent visible in the footer pill and
// Shift+Down dialog. The dream agent itself is unchanged — this is pure UI
// surfacing via the existing task registry.

import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

// Keep only the N most recent turns for live display.
const MAX_TURNS = 30

// A single assistant turn from the dream agent, tool uses collapsed to a count.
export type DreamTurn = {
  text: string
  toolUseCount: number
}

// No phase detection — the dream prompt has a 4-stage structure
// (orient/gather/consolidate/prune) but we don't parse it. Just flip from
// 'starting' to 'updating' when the first Edit/Write tool_use lands.
export type DreamPhase = 'starting' | 'updating'

export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase
  sessionsReviewing: number
  /**
   * Paths observed in Edit/Write tool_use blocks via onMessage. This is an
   * INCOMPLETE reflection of what the dream agent actually changed — it misses
   * any bash-mediated writes and only captures the tool calls we pattern-match.
   * Treat as "at least these were touched", not "only these were touched".
   */
  filesTouched: string[]
  /** Assistant text responses, tool uses collapsed. Prompt is NOT included. */
  turns: DreamTurn[]
  stop?: () => Promise<void>
}

export function isDreamTask(task: unknown): task is DreamTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'dream'
  )
}

export function registerDreamTask(
  setAppState: SetAppState,
  opts: {
    sessionsReviewing: number
    stop: () => Promise<void>
  },
): string {
  const id = generateTaskId('dream')
  const task: DreamTaskState = {
    ...createTaskStateBase(id, 'dream', 'dreaming'),
    type: 'dream',
    status: 'running',
    phase: 'starting',
    sessionsReviewing: opts.sessionsReviewing,
    filesTouched: [],
    turns: [],
    stop: opts.stop,
  }
  registerTask(task, setAppState)
  return id
}

export function addDreamTurn(
  taskId: string,
  turn: DreamTurn,
  touchedPaths: string[],
  setAppState: SetAppState,
): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => {
    const seen = new Set(task.filesTouched)
    const newTouched = touchedPaths.filter(p => !seen.has(p) && seen.add(p))
    // Skip the update entirely if the turn is empty AND nothing new was
    // touched. Avoids re-rendering on pure no-ops.
    if (
      turn.text === '' &&
      turn.toolUseCount === 0 &&
      newTouched.length === 0
    ) {
      return task
    }
    return {
      ...task,
      phase: newTouched.length > 0 ? 'updating' : task.phase,
      filesTouched:
        newTouched.length > 0
          ? [...task.filesTouched, ...newTouched]
          : task.filesTouched,
      turns: task.turns.slice(-(MAX_TURNS - 1)).concat(turn),
    }
  })
}

export function finishDreamTask(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  setAppState: SetAppState,
): void {
  // Dream completion is user-facing. It doesn't wake the main model.
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: status === 'stopped' ? 'killed' : status,
    endTime: Date.now(),
    notified: true,
    stop: undefined,
  }))
  emitTaskTerminatedSdk(taskId, status)
}

export const DreamTask: Task = {
  name: 'DreamTask',
  type: 'dream',

  async kill(taskId, setAppState) {
    let stop: DreamTaskState['stop']
    updateTaskState<DreamTaskState>(taskId, setAppState, task => {
      if (task.status === 'running') stop = task.stop
      return task
    })
    await stop?.()
  },
}

/**
 * Unified-panel plumbing for in-process teammates.
 *
 * CoordinatorTaskPanel lists teammates alongside local_agent tasks (the
 * main-/sub-agent- rows). Local agents get their panel-grace evictAfter at
 * their terminal transition; teammates transition in the swarm runtime
 * without a deadline, so the panel's 1s tick assigns the grace window on
 * first sight of a terminal teammate and evicts once it passes — same UX,
 * centralized here. Pure helpers so the tick math is unit-testable.
 */

import { evictTerminalTask } from '../../utils/task/framework.js'
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from '../../tasks/InProcessTeammateTask/types.js'
import { isTerminalStatus } from './taskStatusUtils.js'
import type { AppState } from '../../state/AppState.js'

// Keep in sync with PANEL_GRACE_MS (framework.ts / teammateViewHelpers.ts).
export const TEAMMATE_PANEL_GRACE_MS = 30_000

export type TeammatePanelTickAction = 'none' | 'grace' | 'evict'

/**
 * What the panel tick should do with a teammate right now:
 * - 'none': running, already dismissed (evictAfter 0), or inside grace
 * - 'grace': terminal without a deadline → assign one (first sighting)
 * - 'evict': terminal and past its deadline
 */
export function teammatePanelTickAction(
  t: InProcessTeammateTaskState,
  now: number,
): TeammatePanelTickAction {
  if (!isTerminalStatus(t.status)) return 'none'
  if (t.evictAfter === undefined) return 'grace'
  if (t.evictAfter === 0) return 'none'
  return t.evictAfter <= now ? 'evict' : 'none'
}

/**
 * Apply the tick to every teammate task: hand terminal teammates a grace
 * deadline the first time they're seen terminal, evict past-deadline ones.
 * Grace assignment goes through setAppState so the deadline survives into
 * the next tick's snapshot.
 */
export function applyTeammatePanelTick(
  tasks: AppState['tasks'],
  now: number,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  for (const t of Object.values(tasks)) {
    if (!isInProcessTeammateTask(t)) continue
    const action = teammatePanelTickAction(t, now)
    if (action === 'grace') {
      setAppState(prev => {
        const task = prev.tasks[t.id]
        if (
          !isInProcessTeammateTask(task) ||
          task.evictAfter !== undefined ||
          !isTerminalStatus(task.status)
        ) {
          return prev
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [t.id]: { ...task, evictAfter: now + TEAMMATE_PANEL_GRACE_MS },
          },
        }
      })
    } else if (action === 'evict') {
      evictTerminalTask(t.id, setAppState)
    }
  }
}

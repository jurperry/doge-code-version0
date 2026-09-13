import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- backward-compat bridge until REPL wires handleKeyDown to <Box onKeyDown>
import { useInput } from '../ink.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'

/**
 * Esc handling for teammate transcript viewing.
 *
 * The shift+↓ selection tree, 'k' kill, and 'f' view paths this hook used to
 * own were retired when teammates joined the CoordinatorTaskPanel roster —
 * the panel's ↑/↓ + Enter + x cover selection/view/stop in the main-/sub-agent-
 * form. What remains: Esc while viewing a teammate aborts the running
 * teammate's current turn (stays in view), otherwise exits back to the leader.
 *
 * `_options` is kept for call-site compatibility; onOpenBackgroundTasks
 * (previously shift+↓ with no teammates) is no longer consumed here.
 */
export function useBackgroundTaskNavigation(_options?: {
  onOpenBackgroundTasks?: () => void
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const tasks = useAppState(s => s.tasks)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const setAppState = useSetAppState()

  const handleKeyDown = (e: KeyboardEvent): void => {
    // Escape in viewing mode:
    // - If teammate is running: abort current work only (stops current turn, teammate stays alive)
    // - If teammate is not running (completed/killed/failed): exit the view back to leader
    if (e.key === 'escape' && viewSelectionMode === 'viewing-agent') {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      if (taskId) {
        const task = tasks[taskId]
        if (isInProcessTeammateTask(task) && task.status === 'running') {
          // Abort currentWorkAbortController (stops current turn) NOT abortController (kills teammate)
          task.currentWorkAbortController?.abort()
          return
        }
      }
      // Teammate is not running or task doesn't exist — exit the view
      exitTeammateView(setAppState)
      return
    }
  }

  // Backward-compat bridge: REPL.tsx doesn't yet wire handleKeyDown to
  // <Box onKeyDown>. Subscribe via useInput and adapt InputEvent →
  // KeyboardEvent until the consumer is migrated (separate PR).
  // TODO(onKeyDown-migration): remove once REPL passes handleKeyDown.
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })

  return { handleKeyDown }
}

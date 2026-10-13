import { buildAutoQuestionDecision } from './autoQuestion.js'
import type { PermissionDecision } from './PermissionResult.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'

type Scheduler = {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}
const scheduler: Scheduler = {
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/** Timer only: the interaction container owns the first-wins decision. */
export function createAutoQuestionWait(options: {
  deadlineMs: number
  signal: AbortSignal
  onTimeout(): void
  scheduler?: Scheduler
}): { dispose(): void } {
  const clock = options.scheduler ?? scheduler
  let active = !options.signal.aborted
  let timer: unknown
  const dispose = () => {
    active = false
    if (timer !== undefined) clock.clearTimeout(timer)
    options.signal.removeEventListener('abort', dispose)
  }
  if (active) {
    options.signal.addEventListener('abort', dispose, { once: true })
    timer = clock.setTimeout(() => {
      if (!active || options.signal.aborted) return
      dispose()
      options.onTimeout()
    }, Math.max(0, options.deadlineMs - clock.now()))
  }
  return { dispose }
}

/** Shared headless race. Claims the result before cancelling a losing channel. */
export async function waitForAutoQuestion(options: {
  input: Record<string, unknown>
  deadlineMs: number | undefined
  signal: AbortSignal
  decision?: Promise<PermissionDecision | undefined>
  onTimeout?(): void
  scheduler?: Scheduler
}): Promise<PermissionDecision> {
  let wait: { dispose(): void } | undefined
  let onAbort: () => void = () => {}
  try {
    return await new Promise<PermissionDecision>((resolve, reject) => {
      let settled = false
      const finish = (decision: PermissionDecision) => {
        if (settled) return false
        settled = true
        wait?.dispose()
        resolve(decision)
        return true
      }
      onAbort = () => finish({ behavior: 'deny', message: 'Question request was aborted.' })
      if (options.signal.aborted) { onAbort(); return }
      options.signal.addEventListener('abort', onAbort, { once: true })
      if (options.deadlineMs !== undefined) {
        wait = createAutoQuestionWait({
          deadlineMs: options.deadlineMs,
          signal: options.signal,
          scheduler: options.scheduler,
          onTimeout: () => {
            if (finish(buildAutoQuestionDecision(options.input))) options.onTimeout?.()
          },
        })
      }
      options.decision?.then(decision => {
        if (decision) finish(decision)
      }, error => {
        if (settled) return
        settled = true
        reject(error)
      })
    })
  } finally {
    wait?.dispose()
    options.signal.removeEventListener('abort', onAbort)
  }
}

/** Independent agent executors can share one host with a single Ask card. */
export function serializeQuestionPermissions(canUseTool: CanUseToolFn): CanUseToolFn {
  let tail: Promise<unknown> = Promise.resolve()
  return (...args) => {
    if (args[0].name !== ASK_USER_QUESTION_TOOL_NAME) return canUseTool(...args)
    const signal = args[2].abortController.signal
    const decision = tail.then(() => signal.aborted
      ? { behavior: 'deny' as const, message: 'Question request was aborted.' }
      : canUseTool(...args))
    tail = decision.catch(() => {})
    // A queued question can abort immediately; its queue slot is skipped when
    // the preceding interaction settles, without letting later slots overtake.
    return waitForAutoQuestion({ input: args[1], deadlineMs: undefined, signal, decision })
  }
}

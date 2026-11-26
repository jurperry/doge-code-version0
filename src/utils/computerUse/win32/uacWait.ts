import { setTimeout as delay } from 'node:timers/promises'

export const UAC_TIMEOUT_MESSAGE = '等待 Windows 用户账户控制（UAC）确认超过 30 秒，已停止当前回合。请在 Windows 提示中自行选择允许或拒绝，再发起新回合。'
export const UAC_WAIT_MESSAGE = '请在 Windows 用户账户控制（UAC）提示中选择允许或拒绝。等待 30 秒后将停止当前回合。'
export const UAC_DECISION_TIMEOUT_MS = 30_000

const DESKTOP_UNAVAILABLE = 'The Windows input desktop is unavailable. Unlock the desktop before continuing Computer Use.'
export const UAC_FRESH_SCREENSHOT = 'The Windows UAC secure-desktop interval has ended; who dismissed it is not observable. Take a fresh screenshot before performing another action.'

export class UacTimeoutError extends Error {
  constructor() { super(UAC_TIMEOUT_MESSAGE) }
}

export type DesktopState = 'ready' | 'uac' | 'unavailable'

interface UacGuardOptions {
  probe: () => DesktopState
  intervalMs?: number
  timeoutMs?: number
}

/** Keep watching while the main turn owns Computer Use, including between tool calls. */
export function createUacGuard(
  showWaiting: (waiting: boolean) => void,
  onFailure: (error: unknown) => void,
  { probe, intervalMs = 150, timeoutMs = UAC_DECISION_TIMEOUT_MS }: UacGuardOptions,
) {
  const lifetime = new AbortController()
  let monitor: ReturnType<typeof setInterval> | undefined
  let deadline: number | undefined
  let generation = 0

  const sample = () => {
    const state = probe()
    if (deadline !== undefined && performance.now() >= deadline) throw new UacTimeoutError()
    if (state === 'uac') {
      if (deadline === undefined) {
        deadline = performance.now() + timeoutMs
        generation++
        showWaiting(true)
      }
    } else if (state === 'ready' && deadline !== undefined) {
      deadline = undefined
      showWaiting(false)
    }
    return state
  }

  const waitForDesktop = async (signal: AbortSignal): Promise<DesktopState> => {
    const actionSignal = AbortSignal.any([signal, lifetime.signal])
    actionSignal.throwIfAborted()
    let state = readDesktop()
    while (deadline !== undefined) {
      await delay(intervalMs, undefined, { signal: actionSignal })
      state = readDesktop()
    }
    return state
  }

  const stop = () => {
    if (monitor) {
      clearInterval(monitor)
      monitor = undefined
    }
    lifetime.abort()
    if (deadline !== undefined) {
      deadline = undefined
      showWaiting(false)
    }
  }

  const readDesktop = () => {
    try {
      return sample()
    } catch (error) {
      onFailure(error)
      stop()
      throw error
    }
  }

  const check = () => {
    try { readDesktop() } catch { /* Already forwarded to the turn. */ }
  }

  return {
    stop,
    get generation() { return generation },
    async beforeAction(signal: AbortSignal) {
      signal.throwIfAborted()
      lifetime.signal.throwIfAborted()
      monitor ??= setInterval(check, intervalMs)
      if (await waitForDesktop(signal) === 'unavailable') throw new Error(DESKTOP_UNAVAILABLE)
    },
    async afterAction(signal: AbortSignal) {
      if (monitor && !signal.aborted && !lifetime.signal.aborted) await waitForDesktop(signal)
    },
  }
}

export type UacGuard = ReturnType<typeof createUacGuard>
const turnGuards = new WeakMap<AbortSignal, UacGuard>()

export function getTurnUacGuard(
  turn: AbortController,
  showWaiting: (waiting: boolean) => void,
  options: UacGuardOptions,
): UacGuard {
  let guard = turnGuards.get(turn.signal)
  if (!guard) {
    guard = createUacGuard(showWaiting, error => turn.abort(error), options)
    turnGuards.set(turn.signal, guard)
  }
  return guard
}

export function stopTurnUacGuard(signal: AbortSignal): void {
  turnGuards.get(signal)?.stop()
  turnGuards.delete(signal)
}

export async function waitForTurnUac(signal: AbortSignal): Promise<void> {
  await turnGuards.get(signal)?.afterAction(signal)
}

export async function runWithUacGuard<T>(
  signal: AbortSignal,
  showWaiting: (waiting: boolean) => void,
  operation: (beforeAction: () => Promise<void>, actionSignal: AbortSignal) => Promise<T>,
  options: UacGuardOptions,
): Promise<T> {
  const failure = new AbortController()
  const guard = createUacGuard(showWaiting, error => failure.abort(error), options)
  const actionSignal = AbortSignal.any([signal, failure.signal])
  const interrupted = Promise.withResolvers<never>()
  const abort = () => interrupted.reject(actionSignal.reason)
  actionSignal.addEventListener('abort', abort, { once: true })
  try {
    actionSignal.throwIfAborted()
    const action = async () => {
      try {
        return await operation(async () => {
          await guard.beforeAction(actionSignal)
          if (guard.generation > 0) throw new Error(UAC_FRESH_SCREENSHOT)
        }, actionSignal)
      }
      finally { await guard.afterAction(actionSignal) }
    }
    return await Promise.race([action(), interrupted.promise])
  } finally {
    actionSignal.removeEventListener('abort', abort)
    guard.stop()
  }
}

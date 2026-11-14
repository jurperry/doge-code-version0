import { expect, test } from 'bun:test'
import { getTurnUacGuard, runWithUacGuard, stopTurnUacGuard, UacTimeoutError } from '../src/utils/computerUse/win32/uacWait.js'
import { desktopState } from '../src/utils/computerUse/win32/uacProbe.js'

test('a normal desktop proceeds without a prompt or delay', async () => {
  const notices: boolean[] = []
  const result = await runWithUacGuard(new AbortController().signal, waiting => notices.push(waiting),
    async beforeAction => { await beforeAction(); return 'done' },
    { probe: () => 'ready' })
  expect(result).toBe('done')
  expect(notices).toEqual([])
})

test('waits for UAC before returning but discards the next action from the prior screen', async () => {
  let state: 'ready' | 'uac' = 'uac'
  const notices: boolean[] = []
  await expect(runWithUacGuard(new AbortController().signal, waiting => {
    notices.push(waiting)
    if (waiting) setTimeout(() => { state = 'ready' }, 5)
  }, async beforeAction => { await beforeAction(); throw new Error('stale action was dispatched') },
  { probe: () => state, intervalMs: 2, timeoutMs: 100 })).rejects.toThrow(/fresh screenshot/i)
  expect(notices).toEqual([true, false])
})

test('detects a prompt while an operation is pending and stops on the decision deadline', async () => {
  let state: 'ready' | 'uac' = 'ready'
  const notices: boolean[] = []
  await expect(runWithUacGuard(new AbortController().signal, waiting => notices.push(waiting),
    async beforeAction => { await beforeAction(); state = 'uac'; return new Promise(() => {}) },
    { probe: () => state, intervalMs: 2, timeoutMs: 16 })).rejects.toBeInstanceOf(UacTimeoutError)
  expect(notices).toEqual([true, false])
})

test('clearing UAC during a pending launch allows its result to return', async () => {
  let state: 'ready' | 'uac' = 'ready'
  const notices: boolean[] = []
  let finish!: () => void
  const operation = new Promise<void>(resolve => { finish = resolve })
  const result = await runWithUacGuard(new AbortController().signal, waiting => {
    notices.push(waiting)
    if (waiting) { state = 'ready'; finish() }
  }, async beforeAction => { await beforeAction(); state = 'uac'; await operation; return 'launched' },
  { probe: () => state, intervalMs: 2, timeoutMs: 100 })
  expect(result).toBe('launched')
  expect(notices).toEqual([true, false])
})

test('an inaccessible desktop without evidence of UAC fails without a UAC notice', async () => {
  const notices: boolean[] = []
  await expect(runWithUacGuard(new AbortController().signal, waiting => notices.push(waiting),
    async beforeAction => { await beforeAction() },
    { probe: () => 'unavailable' })).rejects.toThrow(/input desktop/i)
  expect(notices).toEqual([])
})

test('an inaccessible desktop after a UAC prompt has the same turn deadline', async () => {
  let state: 'uac' | 'unavailable' = 'uac'
  await expect(runWithUacGuard(new AbortController().signal, waiting => {
    if (waiting) state = 'unavailable'
  }, async beforeAction => { await beforeAction() },
  { probe: () => state, intervalMs: 2, timeoutMs: 12 })).rejects.toBeInstanceOf(UacTimeoutError)
})

test('user cancellation clears the active notice and wins over the decision timer', async () => {
  const controller = new AbortController()
  const notices: boolean[] = []
  const result = runWithUacGuard(controller.signal, waiting => {
    notices.push(waiting)
    if (waiting) controller.abort()
  }, async beforeAction => { await beforeAction() },
  { probe: () => 'uac', intervalMs: 2, timeoutMs: 100 })
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(notices).toEqual([true, false])
})

test.skipIf(process.platform !== 'win32')('reads the native state of the ordinary Windows desktop', () => {
  expect(desktopState()).toBe('ready')
})

test('a prompt appearing between tools still aborts the main turn', async () => {
  const turn = new AbortController()
  let state: 'ready' | 'uac' = 'ready'
  const notices: boolean[] = []
  const guard = getTurnUacGuard(turn, waiting => notices.push(waiting), {
    probe: () => state, intervalMs: 2, timeoutMs: 15,
  })
  try {
    await guard.beforeAction(turn.signal)
    await guard.afterAction(turn.signal)
    const aborted = new Promise(resolve => turn.signal.addEventListener('abort', resolve, { once: true }))
    state = 'uac'
    await Promise.race([aborted, Bun.sleep(150)])
    expect(turn.signal.reason).toBeInstanceOf(UacTimeoutError)
    expect(notices).toEqual([true, false])
  } finally {
    stopTurnUacGuard(turn.signal)
  }
})

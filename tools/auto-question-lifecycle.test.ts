import { expect, test } from 'bun:test'
import { createAutoQuestionWait, waitForAutoQuestion } from '../src/utils/permissions/autoQuestionWait.js'
import { AUTO_QUESTION_TIMEOUT_MS } from '../src/utils/permissions/autoQuestion.js'

function clock() {
  let now = 100
  let callback: (() => void) | undefined
  let due = Infinity
  let active = false
  const scheduler = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { callback = fn; due = now + ms; active = true; return 1 },
    clearTimeout: (_id: unknown) => { active = false },
  }
  return { scheduler, advance(ms: number) { now += ms; if (active && now >= due) { active = false; callback?.() } }, stale() { callback?.() }, active: () => active }
}
test('production five-minute deadline fires once, never at 299999ms', () => {
  const c = clock(); const signal = new AbortController().signal; let calls = 0
  createAutoQuestionWait({ deadlineMs: c.scheduler.now() + AUTO_QUESTION_TIMEOUT_MS, signal, scheduler: c.scheduler, onTimeout: () => calls++ })
  c.advance(299999); expect(calls).toBe(0)
  c.advance(1); expect(calls).toBe(1)
  c.stale(); expect(calls).toBe(1)
})
for (const reason of ['answer', 'reject', 'abort']) {
  test(`${reason} disposes the timer and ignores a stale callback`, () => {
    const c = clock(); const controller = new AbortController(); let calls = 0
    const wait = createAutoQuestionWait({ deadlineMs: 300100, signal: controller.signal, scheduler: c.scheduler, onTimeout: () => calls++ })
    c.advance(10)
    if (reason === 'abort') controller.abort(); else wait.dispose()
    expect(c.active()).toBe(false)
    c.advance(300000); c.stale(); expect(calls).toBe(0)
  })
}
test('already aborted signal never creates a timer', () => {
  const c = clock(); const controller = new AbortController(); controller.abort()
  createAutoQuestionWait({ deadlineMs: 300100, signal: controller.signal, scheduler: c.scheduler, onTimeout: () => { throw new Error('late timeout') } })
  expect(c.active()).toBe(false)
})
test('restored expired deadline schedules immediate expiry without a new window', () => {
  const c = clock(); let calls = 0
  createAutoQuestionWait({ deadlineMs: 90, signal: new AbortController().signal, scheduler: c.scheduler, onTimeout: () => calls++ })
  c.advance(0); expect(calls).toBe(1)
})

const input = { questions: [{ question: 'Choose?', options: [{ label: 'First' }, { label: 'Second (推荐)' }] }], answers: { 'Choose?': 'model draft' } }
test('timeout wins once and cancels only its interaction channel', async () => {
  const c = clock(); const controller = new AbortController(); let cancel = 0; let respond!: (answer: any) => void
  const result = waitForAutoQuestion({ input, deadlineMs: 300100, signal: controller.signal, scheduler: c.scheduler,
    decision: new Promise(resolve => { respond = resolve }), onTimeout: () => cancel++ })
  c.advance(300000)
  const winner = await result
  expect(winner.behavior).toBe('allow')
  expect((winner as any).updatedInput.answers).toEqual({ 'Choose?': 'Second (推荐)' })
  expect((winner as any).updatedInput._autoQuestionAnswerSource).toBe('auto_recommended')
  expect(controller.signal.aborted).toBe(false)
  respond({ behavior: 'deny', message: 'late' }); c.stale()
  expect(await result).toBe(winner); expect(cancel).toBe(1)
})
test('submitted human answer wins and clears its timeout', async () => {
  const c = clock(); let respond!: (answer: any) => void; let cancel = 0
  const result = waitForAutoQuestion({ input, deadlineMs: 300100, signal: new AbortController().signal, scheduler: c.scheduler,
    decision: new Promise(resolve => { respond = resolve }), onTimeout: () => cancel++ })
  const human = { behavior: 'allow', updatedInput: { ...input, answers: { 'Choose?': 'human' } } }
  respond(human)
  expect(await result).toBe(human); expect(c.active()).toBe(false)
  c.stale(); expect(cancel).toBe(0)
})
test('hook pass-through is not a submitted answer and abort still resolves', async () => {
  const c = clock(); const controller = new AbortController()
  const result = waitForAutoQuestion({ input, deadlineMs: 300100, signal: controller.signal, scheduler: c.scheduler, decision: Promise.resolve(undefined) })
  await Promise.resolve(); expect(c.active()).toBe(true)
  controller.abort(); expect((await result).behavior).toBe('deny'); expect(c.active()).toBe(false)
})

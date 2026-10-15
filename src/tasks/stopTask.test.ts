import { expect, mock, test } from 'bun:test'
import { killTask } from './LocalShellTask/killShellTasks.js'
import { applyTaskOffsetsAndEvictions, evictTerminalTask, generateTaskAttachments } from '../utils/task/framework.js'
mock.module('../tasks.js', () => ({ getTaskByType: () => ({ kill: killTask }) }))
const { stopTask } = await import('./stopTask.js')

test('SDK Stop joins a model TaskStop already waiting for OS confirmation', async () => {
  let complete!: () => void
  let state: any = { tasks: { b: { id: 'b', type: 'local_bash', status: 'running', description: 'temporary server', notified: false, outputFile: '', shellCommand: { kill() {}, cleanup() {}, killSettled: new Promise<void>(resolve => { complete = resolve }) } } } }
  const context = { getAppState: () => state, setAppState: (update: any) => { state = update(state) } }
  const modelStop = stopTask('b', context)
  let finished = false
  const sdkStop = stopTask('b', context).then(result => { finished = true; return result })
  await Promise.resolve()
  expect(finished).toBe(false)
  complete()
  await modelStop
  await expect(sdkStop).resolves.toMatchObject({ taskId: 'b', taskType: 'local_bash' })
})
test('both overlapping Stop callers receive OS failure and leave the task retryable', async () => {
  let fail!: (error: Error) => void
  let state: any = { tasks: { b: { id: 'b', type: 'local_bash', status: 'running', description: 'temporary server', notified: false, outputFile: '', shellCommand: { kill() {}, cleanup() {}, killSettled: new Promise<void>((_resolve, reject) => { fail = reject }) } } } }
  const context = { getAppState: () => state, setAppState: (update: any) => { state = update(state) } }
  const modelStop = stopTask('b', context)
  const sdkStop = stopTask('b', context)
  const modelFailure = modelStop.then(() => undefined, error => error)
  const sdkFailure = sdkStop.then(() => undefined, error => error)
  fail(new Error('OS denied stop'))
  const errors = await Promise.all([modelFailure, sdkFailure])
  expect(errors.map(error => error?.message)).toEqual(['OS denied stop', 'OS denied stop'])
  expect(state.tasks.b.status).toBe('running')
})

test('all GC paths retain an in-flight Stop so concurrent callers can observe OS failure and retry', async () => {
  let fail!: (error: Error) => void
  let state: any = { tasks: { b: { id: 'b', type: 'local_bash', status: 'running', description: 'temporary server', notified: false, outputFile: '', shellCommand: { kill() {}, cleanup() {}, killSettled: new Promise<void>((_resolve, reject) => { fail = reject }) } } } }
  const context = { getAppState: () => state, setAppState: (update: any) => { state = update(state) } }
  const modelStop = stopTask('b', context).then(() => undefined, error => error)
  try {
    const generated = await generateTaskAttachments(state)
    expect(generated.evictedTaskIds).toEqual([])
    evictTerminalTask('b', context.setAppState)
    expect(state.tasks.b).toBeDefined()
    // A stale sweep may already contain the ID; the fresh-state guard must protect it too.
    applyTaskOffsetsAndEvictions(context.setAppState, {}, ['b'])
    expect(state.tasks.b).toBeDefined()
    let finished = false
    const sdkStop = stopTask('b', context).then(() => { finished = true }, error => { finished = true; return error })
    await Promise.resolve()
    expect(finished).toBe(false)
    fail(new Error('OS denied stop after GC'))
    const errors = await Promise.all([modelStop, sdkStop])
    expect(errors.map(error => error?.message)).toEqual(['OS denied stop after GC', 'OS denied stop after GC'])
    expect(state.tasks.b.status).toBe('running')
    expect(state.tasks.b.terminationPending).toBeUndefined()
    state.tasks.b.shellCommand.killSettled = Promise.resolve()
    await stopTask('b', context)
    expect(state.tasks.b.status).toBe('killed')
    expect(state.tasks.b.terminationPending).toBeUndefined()
    evictTerminalTask('b', context.setAppState)
    expect(state.tasks.b).toBeUndefined()
  } finally {
    fail(new Error('test cleanup'))
    await modelStop
  }
})

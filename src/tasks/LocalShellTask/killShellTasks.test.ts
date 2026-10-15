import { afterEach, describe, expect, test } from 'bun:test'
import { killTask, handoffShellTasksForAgent, killShellTasksForAgent } from './killShellTasks.js'
import { setSdkEventTap } from '../../utils/sdkEventQueue.js'
import { enqueuePendingNotification, getCommandQueue, dequeueAllMatching } from '../../utils/messageQueueManager.js'

afterEach(() => { setSdkEventTap(undefined); dequeueAllMatching(() => true) })
const fixture = () => {
  let state: any = { tasks: {
    b1: { id: 'b1', type: 'local_bash', status: 'running', agentId: 'step', isBackgrounded: true, description: 'test server', toolUseId: 'tool1', outputFile: '', notified: false, shellCommand: { kill() {}, cleanup() {}, killSettled: Promise.resolve() } },
    b2: { id: 'b2', type: 'local_bash', status: 'running', agentId: 'other', isBackgrounded: true },
    done: { id: 'done', type: 'local_bash', status: 'completed', agentId: 'step', isBackgrounded: true },
  } }
  return { get: () => state, set: (f: any) => { state = f(state) } }
}
describe('shell lifecycle ownership', () => {
  test('successful workflow handoff keeps only live commands and reroutes queued notifications', () => {
    const f = fixture()
    enqueuePendingNotification({ value: 'ready', mode: 'task-notification', agentId: 'step' as any })
    enqueuePendingNotification({ value: 'other', mode: 'task-notification', agentId: 'other' as any })
    handoffShellTasksForAgent('step' as any, f.set)
    expect(f.get().tasks.b1.agentId).toBeUndefined()
    expect(f.get().tasks.b1.status).toBe('running')
    expect(f.get().tasks.b2.agentId).toBe('other')
    expect(f.get().tasks.done.agentId).toBe('step')
    expect(getCommandQueue().find(c => c.value === 'ready')?.agentId).toBeUndefined()
    expect(getCommandQueue().find(c => c.value === 'other')?.agentId).toBe('other')
  })
  test('every kill caller emits exactly one stopped bookend after OS tree kill settles', async () => {
    const f = fixture(), events: any[] = []
    let finish!: () => void
    f.get().tasks.b1.shellCommand.killSettled = new Promise<void>(r => { finish = r })
    setSdkEventTap(e => events.push(e))
    const stopping = killTask('b1', f.set)
    expect(events).toHaveLength(0)
    finish()
    await stopping
    await killTask('b1', f.set)
    expect(events.filter(e => e.subtype === 'task_notification')).toEqual([expect.objectContaining({ task_id: 'b1', status: 'stopped', tool_use_id: 'tool1' })])
    expect(f.get().tasks.b1.status).toBe('killed')
  })
  test('failed OS cleanup leaves a retryable task without a false stopped event', async () => {
    const f = fixture(), events: any[] = []
    f.get().tasks.b1.shellCommand.killSettled = Promise.reject(new Error('tree kill failed'))
    setSdkEventTap(e => events.push(e))
    await expect(killTask('b1', f.set)).rejects.toThrow('tree kill failed')
    expect(f.get().tasks.b1.status).toBe('running')
    expect(events).toHaveLength(0)
    f.get().tasks.b1.shellCommand.killSettled = Promise.resolve()
    await killTask('b1', f.set)
    expect(events).toHaveLength(1)
  })
  test('intermediate handoff belongs to its workflow until the whole run completes', () => {
    const f = fixture()
    handoffShellTasksForAgent('step' as any, f.set, 'workflow' as any)
    expect(f.get().tasks.b1.agentId).toBe('workflow')
    handoffShellTasksForAgent('workflow' as any, f.set)
    expect(f.get().tasks.b1.agentId).toBeUndefined()
  })
  test('owner cancellation preserves an unconsumed natural completion bookend', async () => {
    const f = fixture(), events: any[] = []
    f.get().tasks.b1.status = 'completed'
    f.get().tasks.b1.notified = true
    setSdkEventTap(e => events.push(e))
    enqueuePendingNotification({ value: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', mode: 'task-notification', agentId: 'step' as any })
    await killShellTasksForAgent('step' as any, f.get, f.set)
    await killShellTasksForAgent('step' as any, f.get, f.set)
    expect(events).toEqual([expect.objectContaining({ task_id: 'b1', status: 'completed' })])
    expect(getCommandQueue()).toHaveLength(0)
  })
  test('completion queued before task GC still emits its terminal bookend on owner exit', async () => {
    const f = fixture(), events: any[] = []
    delete f.get().tasks.b1
    setSdkEventTap(e => events.push(e))
    enqueuePendingNotification({ value: '<task-notification><task-id>b1</task-id><task-type>local_bash</task-type><status>completed</status><summary>finished</summary></task-notification>', mode: 'task-notification', agentId: 'step' as any })
    await killShellTasksForAgent('step' as any, f.get, f.set)
    expect(events).toEqual([expect.objectContaining({ task_id: 'b1', status: 'completed', summary: 'finished' })])
  })
})

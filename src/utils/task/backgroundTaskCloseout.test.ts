import { describe, expect, test } from 'bun:test'
import { BackgroundTaskCloseout } from './backgroundTaskCloseout.js'

const shell = (id: string, extra = {}) => ({ id, type: 'local_bash', status: 'running', isBackgrounded: true, description: 'preview server', command: 'node server.js', outputFile: '/tasks/' + id, ...extra })
const options = (tasks: unknown[], extra = {}) => ({ tasks: Object.fromEntries(tasks.map((t: any) => [t.id, t])), querySource: 'sdk', agentId: undefined, aborted: false, canStopTasks: true, ...extra })

describe('main-session background closeout', () => {
  test('gives the main model actual task IDs, commands and output paths', () => {
    const review = new BackgroundTaskCloseout().review(options([shell('b-live')]) as any)
    expect(review).toContain('b-live')
    expect(review).toContain('node server.js')
    expect(review).toContain('/tasks/b-live')
    expect(review).toContain('TaskOutput')
    expect(review).toContain('TaskStop')
  })
  test('does not repeat the same unresolved tasks, but includes new tasks', () => {
    const closeout = new BackgroundTaskCloseout()
    expect(closeout.review(options([shell('b1')]) as any)).toBeDefined()
    expect(closeout.review(options([shell('b1')]) as any)).toBeUndefined()
    const next = closeout.review(options([shell('b1'), shell('b2')]) as any)
    expect(next).toContain('b1')
    expect(next).toContain('b2')
  })
  test.each(['local_workflow', 'local_agent', 'remote_agent'])('defers while %s is executing', type => {
    const closeout = new BackgroundTaskCloseout()
    expect(closeout.review(options([shell('b1'), { id: 'owner', type, status: 'running' }]) as any)).toBeUndefined()
    expect(closeout.review(options([shell('b1')]) as any)).toBeDefined()
  })
  test('never transfers teammate-owned, foreground or terminal commands to the main model', () => {
    expect(new BackgroundTaskCloseout().review(options([shell('owned', { agentId: 'teammate' }), shell('fg', { isBackgrounded: false }), shell('done', { status: 'completed' })]) as any)).toBeUndefined()
  })
  test('busy teammates protect shared resources while idle teammates do not block closeout', () => {
    const closeout = new BackgroundTaskCloseout()
    expect(closeout.review(options([shell('b1'), { id: 'mate', type: 'in_process_teammate', status: 'running', isIdle: false }]) as any)).toBeUndefined()
    expect(closeout.review(options([shell('b1'), { id: 'mate', type: 'in_process_teammate', status: 'running', isIdle: true }]) as any)).toContain('b1')
  })
  test.each([{ aborted: true }, { agentId: 'child' }, { querySource: 'agent:custom' }, { canStopTasks: false }])('does not continue %j', extra => {
    expect(new BackgroundTaskCloseout().review(options([shell('b1')], extra) as any)).toBeUndefined()
  })
})

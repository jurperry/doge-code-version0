import { afterEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
let finishKill: (error?: Error) => void
let killCalls = 0
mock.module('tree-kill', () => ({ default: (_pid: number, _signal: string, done: typeof finishKill) => { killCalls++; finishKill = done } }))
const { wrapSpawn } = await import('./ShellCommand.js')
const fixture = (timeout = 60000) => {
  const child = Object.assign(new EventEmitter(), { pid: process.pid, stdout: null, stderr: null })
  const output = { stdoutToFile: false, getStdout: async () => '', getStderr: () => '', clear() {} }
  const controller = new AbortController()
  return { child, controller, shell: wrapSpawn(child as any, controller.signal, timeout, output as any) }
}
afterEach(() => { finishKill = undefined as any; killCalls = 0 })
describe('OS tree kill result ordering', () => {
  test('abort preserves interruption when exit arrives before treeKill acknowledgement', async () => {
    const f = fixture()
    f.controller.abort()
    f.child.emit('exit', null, 'SIGKILL')
    finishKill()
    const result = await f.shell.result
    expect(result.code).toBe(137)
    expect(result.interrupted).toBe(true)
    f.shell.cleanup()
  })
  test('timeout preserves timeout result when process exit arrives first', async () => {
    const f = fixture(5)
    await new Promise(r => setTimeout(r, 20))
    f.child.emit('exit', null, 'SIGKILL')
    finishKill()
    const result = await f.shell.result
    expect(result.code).toBe(143)
    expect(result.stderr).toContain('Command timed out')
    f.shell.cleanup()
  })
  test('ordinary process exit keeps its own exit code', async () => {
    const f = fixture()
    f.child.emit('exit', 0, null)
    expect((await f.shell.result).code).toBe(0)
    f.shell.cleanup()
  })
  test('a failed OS kill does not settle the result and can be retried', async () => {
    const f = fixture()
    f.shell.kill()
    const failed = f.shell.killSettled!
    finishKill(new Error('fixture kill failure'))
    await expect(failed).rejects.toThrow('fixture kill failure')
    let finished = false
    void f.shell.result.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    f.shell.kill()
    f.child.emit('exit', null, 'SIGKILL')
    finishKill()
    expect((await f.shell.result).interrupted).toBe(true)
    f.shell.cleanup()
  })
  test('a failed OS kill still allows a later natural process exit', async () => {
    const f = fixture()
    f.shell.kill()
    const failed = f.shell.killSettled!
    finishKill(new Error('fixture kill failure'))
    await expect(failed).rejects.toThrow('fixture kill failure')
    f.child.emit('exit', 0, null)
    expect((await f.shell.result).code).toBe(0)
    f.shell.cleanup()
  })
  test('concurrent abort and kill share one OS operation and settled kill is idempotent', async () => {
    const f = fixture()
    f.shell.kill()
    f.controller.abort()
    f.shell.kill()
    expect(killCalls).toBe(1)
    finishKill()
    await f.shell.result
    f.shell.cleanup()
    f.shell.kill()
    expect(killCalls).toBe(1)
  })
})

import { afterEach, expect, test, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { emitShellWorkspaceMarker } from './shellWorkspaceMarker'

const originalEnv = process.env.DOGE_APP_WORKSPACE_MARKER
const originalWrite = process.stderr.write
let fdWrite: ReturnType<typeof spyOn> | undefined
afterEach(() => {
  fdWrite?.mockRestore()
  process.stderr.write = originalWrite
  if (originalEnv === undefined) delete process.env.DOGE_APP_WORKSPACE_MARKER
  else process.env.DOGE_APP_WORKSPACE_MARKER = originalEnv
})

test('workspace marker is opt-in and preserves unicode paths and session identity', () => {
  const output: string[] = []
  fdWrite = spyOn(fs, 'writeSync').mockImplementation(((fd: number, chunk: string) => {
    expect(fd).toBe(process.stderr.fd)
    output.push(chunk)
    return Buffer.byteLength(chunk)
  }) as typeof fs.writeSync)
  // Ink 接管 stream.write 后可能吞掉不可见 OSC；通知必须绕过 TUI 渲染器。
  process.stderr.write = (() => { throw Error('Ink intercepted') }) as typeof process.stderr.write
  delete process.env.DOGE_APP_WORKSPACE_MARKER
  emitShellWorkspaceMarker('E:/工作 树', 'session-1')
  expect(output).toEqual([])
  process.env.DOGE_APP_WORKSPACE_MARKER = '1'
  emitShellWorkspaceMarker('E:/工作 树', 'session-1')
  expect(output[0].startsWith('\x1b]7771;workspace:')).toBe(true)
  expect(output[0].endsWith('\x07')).toBe(true)
  const payload = output[0].slice('\x1b]7771;workspace:'.length, -1)
  expect(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))).toEqual({ pid: process.pid, cwd: 'E:/工作 树', sessionId: 'session-1' })
})

test('a closed stderr never blocks session state changes', () => {
  process.env.DOGE_APP_WORKSPACE_MARKER = '1'
  fdWrite = spyOn(fs, 'writeSync').mockImplementation(() => { throw Error('closed') })
  expect(() => emitShellWorkspaceMarker('E:/tree', 'session')).not.toThrow()
})

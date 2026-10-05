import { describe, expect, test } from 'bun:test'
import { runMcpToolCall, mcpToolCallLimits, McpToolTimeoutError } from './toolCallLifecycle.js'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const limits = { idleMs: 60, totalMs: 250, waitIntervalMs: 15 }
const base = () => ({ signal: new AbortController().signal, serverName: 'fixture', toolName: 'hang', limits })

describe('MCP request boundaries', () => {
  test('silent tool fails and aborts only its request, even if dependency ignores abort', async () => {
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    await expect(runMcpToolCall({ ...base(), signal: parent.signal,
      invoke: signal => { requestSignal = signal; return new Promise(() => {}) }
    })).rejects.toBeInstanceOf(McpToolTimeoutError)
    expect(requestSignal?.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
  })
  test('real advancing progress renews idle budget and returns result', async () => {
    expect(await runMcpToolCall({ ...base(), invoke: async (_signal, progress) => {
      for (let i = 1; i <= 4; i++) { await pause(30); progress({ progress: i, message: `part ${i}` }) }
      return 'done'
    } })).toBe('done')
  })
  test('endless advancing progress cannot exceed hard limit', async () => {
    let ticker: ReturnType<typeof setInterval>
    let requestSignal: AbortSignal | undefined
    try {
      await expect(runMcpToolCall({ ...base(), limits: { ...limits, totalMs: 150 }, invoke: (signal, progress) => {
        requestSignal = signal
        let n = 0
        ticker = setInterval(() => progress({ progress: ++n }), 20)
        return new Promise(() => {})
      } })).rejects.toMatchObject({ name: 'McpToolTimeoutError', kind: 'total' })
      expect(requestSignal?.aborted).toBe(true)
    } finally { clearInterval(ticker!) }
  })
  test('repeated nonadvancing server progress cannot keep a hung request alive', async () => {
    let ticker: ReturnType<typeof setInterval>
    try {
      await expect(runMcpToolCall({ ...base(), invoke: (_signal, progress) => {
        progress({ progress: 1 })
        ticker = setInterval(() => progress({ progress: 1 }), 10)
        return new Promise(() => {})
      } })).rejects.toMatchObject({ kind: 'idle' })
    } finally { clearInterval(ticker!) }
  })
  test('waiting feedback is truthful and never resets idle deadline', async () => {
    const waits: number[] = []
    await expect(runMcpToolCall({ ...base(), onWait: update => waits.push(update.elapsedMs),
      invoke: () => new Promise(() => {})
    })).rejects.toMatchObject({ kind: 'idle' })
    expect(waits.length).toBeGreaterThan(0)
    expect(waits.every(ms => ms > 0 && ms < 200)).toBe(true)
  })
  test('pre-aborted request never invokes service', async () => {
    const parent = new AbortController(); parent.abort()
    let invoked = false
    await expect(runMcpToolCall({ ...base(), signal: parent.signal, invoke: async () => { invoked = true } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoked).toBe(false)
  })
  test('user stop settles even when service ignores AbortSignal', async () => {
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    const call = runMcpToolCall({ ...base(), signal: parent.signal, invoke: signal => { requestSignal = signal; return new Promise(() => {}) } })
    parent.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestSignal?.aborted).toBe(true)
  })
  test('one timeout does not cancel a concurrent healthy request', async () => {
    const parent = new AbortController()
    const stalled = runMcpToolCall({ ...base(), signal: parent.signal, invoke: () => new Promise(() => {}) }).catch(error => error)
    const healthy = runMcpToolCall({ ...base(), signal: parent.signal, invoke: async (_signal, progress) => {
      for (let i = 1; i <= 4; i++) { await pause(30); progress({ progress: i }) }
      return 'healthy'
    } })
    expect(await stalled).toBeInstanceOf(McpToolTimeoutError)
    expect(await healthy).toBe('healthy')
  })
  test('success disposes waits and ignores late progress without aborting healthy result', async () => {
    let progress: (p: { progress: number }) => void = () => {}
    let notifications = 0, signal: AbortSignal | undefined
    expect(await runMcpToolCall({ ...base(), onProgress: () => notifications++, onWait: () => notifications++,
      invoke: async (s, cb) => { signal = s; progress = cb; return 'ok' }
    })).toBe('ok')
    progress({ progress: 1 }); await pause(80)
    expect(notifications).toBe(0)
    expect(signal?.aborted).toBe(false)
  })
  test('service errors propagate immediately and dispose timer', async () => {
    let waits = 0
    await expect(runMcpToolCall({ ...base(), onWait: () => waits++, invoke: async () => { throw new Error('service failed') } })).rejects.toThrow('service failed')
    await pause(80); expect(waits).toBe(0)
  })
  test('late result cannot turn timeout into success', async () => {
    let finish: (value: string) => void = () => {}
    const result = await runMcpToolCall({ ...base(), invoke: () => new Promise<string>(resolve => { finish = resolve }) }).catch(error => error)
    finish('late')
    expect(result).toBeInstanceOf(McpToolTimeoutError)
  })
  test('configuration rejects invalid limits and honors explicit long-call budgets', () => {
    for (const value of ['-1', '0', 'abc', 'Infinity', '60000junk', '999999999999']) {
      expect(mcpToolCallLimits({ MCP_TOOL_TIMEOUT: value, MCP_TOOL_IDLE_TIMEOUT: value })).toMatchObject({ idleMs: 120000, totalMs: 600000 })
    }
    expect(mcpToolCallLimits({ MCP_TOOL_TIMEOUT: '2000000', MCP_TOOL_IDLE_TIMEOUT: '300000' })).toMatchObject({ idleMs: 300000, totalMs: 2000000 })
    expect(mcpToolCallLimits({ MCP_TOOL_TIMEOUT: '2000' })).toMatchObject({ idleMs: 2000, totalMs: 2000 })
  })
})

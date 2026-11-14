import { describe, expect, test } from 'bun:test'

import { McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, McpToolTimeoutError } from '../../services/mcp/toolCallLifecycle.js'
import type { ToolUseContext } from '../../Tool.js'
import { _test } from './wrapper.js'
import { UacTimeoutError } from './win32/uacWait.js'

const limits = { idleMs: 30, totalMs: 150, waitIntervalMs: 10 }

function contextFor(
  abortController = new AbortController(),
  setToolJSX?: (value: unknown) => void,
): ToolUseContext {
  return {
    abortController,
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    setAppState: () => {},
    setToolJSX,
  } as unknown as ToolUseContext
}

const parentMessage = {
  message: { content: [{ type: 'tool_use', id: 'cu-call-1' }] },
} as any

describe('Computer Use production tool wrapper', () => {
  test('a UAC deadline aborts the turn and its native operation, clearing UI status', async () => {
    const context = contextFor()
    const statuses: unknown[] = []
    context.setSDKStatus = status => statuses.push(status)
    let nativeSignal: AbortSignal | undefined
    let entered = false
    const result = await _test.callComputerUseTool({
      dispatch: async (_name, _args, signal, _progress, beforeAction) => {
        nativeSignal = signal
        await beforeAction!()
        entered = true
        return new Promise(() => {})
      },
      toolName: 'open_application',
      args: {},
      context,
      limits: { idleMs: 500, totalMs: 500, waitIntervalMs: 200 },
      uacGuard: { probe: () => entered ? 'uac' : 'ready', timeoutMs: 12, intervalMs: 2 },
    })
    expect(result).toEqual({ data: undefined })
    expect(context.abortController.signal.reason).toBeInstanceOf(UacTimeoutError)
    expect(nativeSignal?.aborted).toBe(true)
    expect(statuses).toEqual(['computer_use_uac', 'computer_use_uac_done'])
  })

  test('turns MCP isError into the shared tool-call failure', async () => {
    await expect(_test.callComputerUseTool({
      dispatch: async () => ({
        content: [
          { type: 'text', text: 'Window disappeared. Call open_application.' },
          { type: 'image', data: 'c2hvdA==', mimeType: 'image/jpeg' },
        ],
        isError: true,
      }),
      toolName: 'type',
      args: {},
      context: contextFor(),
      limits,
    })).rejects.toEqual(expect.objectContaining({
      name: 'McpToolCallError',
      message: 'Window disappeared. Call open_application.',
      errorContent: [
        { type: 'text', text: 'Window disappeared. Call open_application.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'c2hvdA==' } },
      ],
    }))
  })

  test('preserves text and pre-sized image blocks on success', async () => {
    const result = await _test.callComputerUseTool({
      dispatch: async () => ({
        content: [
          { type: 'text', text: 'Screenshot saved to: E:/tmp/shot.jpg' },
          { type: 'image', data: 'anBlaW1hZ2U=', mimeType: 'image/jpeg' },
        ],
      }),
      toolName: 'screenshot',
      args: {},
      context: contextFor(),
      limits,
    })
    expect(result.data).toEqual([
      { type: 'text', text: 'Screenshot saved to: E:/tmp/shot.jpg' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'anBlaW1hZ2U=' },
      },
    ])
  })

  test('silent dispatch hits the idle deadline and aborts only its request', async () => {
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    await expect(_test.callComputerUseTool({
      dispatch: (_name, _args, signal) => {
        requestSignal = signal
        return new Promise(() => {})
      },
      toolName: 'computer_batch',
      args: {},
      context: contextFor(parent),
      limits,
    })).rejects.toBeInstanceOf(McpToolTimeoutError)
    expect(requestSignal?.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
  })

  test('user cancellation settles quietly and propagates the derived signal', async () => {
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    const pending = _test.callComputerUseTool({
      dispatch: (_name, _args, signal) => {
        requestSignal = signal
        return new Promise(() => {})
      },
      toolName: 'computer_batch',
      args: {},
      context: contextFor(parent),
      limits,
    })
    parent.abort()
    expect(await pending).toEqual({ data: undefined })
    expect(requestSignal?.aborted).toBe(true)
  })

  test('does not swallow an internal AbortError when the parent was not cancelled', async () => {
    await expect(_test.callComputerUseTool({
      dispatch: async () => { throw new DOMException('native failure', 'AbortError') },
      toolName: 'key',
      args: {},
      context: contextFor(),
      limits,
    })).rejects.toMatchObject({ name: 'AbortError', message: 'native failure' })
  })

  test('forwards real action progress and renews the idle budget', async () => {
    const events: any[] = []
    const result = await _test.callComputerUseTool({
      dispatch: async (_name, _args, _signal, reportProgress) => {
        reportProgress?.({ progress: 1, total: 2, message: 'left_click' })
        await new Promise(resolve => setTimeout(resolve, 45))
        reportProgress?.({ progress: 2, total: 2, message: 'type' })
        return { content: [{ type: 'text', text: 'done' }] }
      },
      toolName: 'computer_batch',
      args: {},
      context: contextFor(),
      parentMessage,
      onProgress: event => events.push(event),
      limits: { idleMs: 60, totalMs: 200, waitIntervalMs: 10 },
    })
    expect(result.data).toEqual([{ type: 'text', text: 'done' }])
    expect(events.filter(event => event.data.progress !== undefined).map(event => ({
      id: event.toolUseID,
      progress: event.data.progress,
      total: event.data.total,
    }))).toEqual([
      { id: 'cu-call-1', progress: 1, total: 2 },
      { id: 'cu-call-1', progress: 2, total: 2 },
    ])
  })

  test('request timeout dismisses a pending permission dialog', async () => {
    const jsx: unknown[] = []
    const request = {
      requestId: 'req-1',
      reason: 'test',
      apps: [],
      requestedFlags: {},
      screenshotFiltering: 'none',
    } as any
    await expect(_test.callComputerUseTool({
      dispatch: (_name, _args, signal) => _test.runPermissionDialog(request, signal!),
      toolName: 'request_access',
      args: {},
      context: contextFor(new AbortController(), value => jsx.push(value)),
      limits: { idleMs: 25, totalMs: 100, waitIntervalMs: 5 },
    })).rejects.toBeInstanceOf(McpToolTimeoutError)
    expect(jsx).toHaveLength(2)
    expect(jsx[1]).toBeNull()
  })

  test('shared MCP error type remains identifiable to existing callers', () => {
    expect(new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS('x', 'y').name).toBe('McpToolCallError')
  })
})

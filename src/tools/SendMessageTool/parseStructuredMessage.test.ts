import { describe, expect, test } from 'bun:test'
import {
  parseStructuredMessageFromString,
  SendMessageTool,
} from './SendMessageTool.js'

// Dialects below are copied from a real stuck session (2026-09-13): the lead
// and the teammates both serialized protocol payloads as JSON strings, the
// structured handlers never ran, and a teammate stayed "running" forever
// after approving its own shutdown three times into the void.
describe('parseStructuredMessageFromString', () => {
  test('promotes the lead dialect shutdown_request (string form)', () => {
    expect(
      parseStructuredMessageFromString(
        '{"reason": "分析任务已完成，报告已收到并汇总", "type": "shutdown_request"}',
      ),
    ).toEqual({
      type: 'shutdown_request',
      reason: '分析任务已完成，报告已收到并汇总',
    })
  })

  test('promotes the teammate dialect shutdown_response with empty request_id', () => {
    expect(
      parseStructuredMessageFromString(
        '{"type": "shutdown_response", "request_id": "", "approve": true, "reason": "任务已完成"}',
      ),
    ).toEqual({
      type: 'shutdown_response',
      request_id: '',
      approve: true,
      reason: '任务已完成',
    })
  })

  test('promotes rejection responses', () => {
    expect(
      parseStructuredMessageFromString(
        '{"approve": false, "reason": "still working", "request_id": "sd-1", "type": "shutdown_response"}',
      ),
    ).toEqual({
      type: 'shutdown_response',
      request_id: 'sd-1',
      approve: false,
      reason: 'still working',
    })
  })

  test('promotes plan_approval_response', () => {
    expect(
      parseStructuredMessageFromString(
        '{"type": "plan_approval_response", "request_id": "pa-1", "approve": true}',
      ),
    ).toEqual({
      type: 'plan_approval_response',
      request_id: 'pa-1',
      approve: true,
    })
  })

  test.each([
    'plain text report',
    'contains {"type":"shutdown_request"} embedded in prose',
    '{"type":"status_report","status":"done"}',
    '{"summary":"not a protocol type"}',
    '[1, 2, 3]',
    '',
    '  {"reason":"no type field"}  ',
  ])('does NOT promote %s', text => {
    expect(parseStructuredMessageFromString(text)).toBeNull()
  })
})

describe('validateInput — promotion runs before the string checks', () => {
  // A stringified shutdown_request WITHOUT a summary used to be rejected by
  // "summary is required when message is a string" before call() could
  // promote it — the exact trap the stuck session hit.
  test('stringified protocol payload without summary validates and gets promoted', async () => {
    const tool = SendMessageTool as unknown as {
      validateInput: (
        input: { to: string; message: unknown; summary?: string },
        context: unknown,
      ) => Promise<{ result: boolean; message?: string }>
    }
    const input = {
      to: 'tools-researcher',
      message: '{"reason": "done", "type": "shutdown_request"}',
    }
    const verdict = await tool.validateInput(input, {})
    expect(verdict.result).toBe(true)
    expect(input.message).toEqual({
      type: 'shutdown_request',
      reason: 'done',
    })
  })

  test('plain string without summary is still rejected', async () => {
    const tool = SendMessageTool as unknown as {
      validateInput: (
        input: { to: string; message: unknown; summary?: string },
        context: unknown,
      ) => Promise<{ result: boolean; message?: string }>
    }
    const input = { to: 'tools-researcher', message: 'plain text, no summary' }
    const verdict = await tool.validateInput(input, {})
    expect(verdict.result).toBe(false)
    expect(verdict.message).toContain('summary is required')
  })
})

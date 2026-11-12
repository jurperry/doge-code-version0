import { expect, test } from 'bun:test'

import { McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../mcp/toolCallLifecycle.js'
import { _test } from './toolExecution.js'
import { createUserMessage, normalizeMessagesForAPI } from '../../utils/messages.js'

test('partial-failure images survive error construction and API normalization', () => {
  const error = new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    'batch failed',
    'MCP tool returned error',
    undefined,
    [
      { type: 'text', text: '{"completed":[],"failed":{"ok":false},"remaining":1}' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'c2hvdA==' } },
    ],
  )
  const { content, imageCount } = _test.buildMcpErrorContent(error, 'tool-1', 'batch failed')
  expect(imageCount).toBe(1)
  const normalized = normalizeMessagesForAPI([createUserMessage({ content })], [])
  const blocks = normalized[0]!.message.content
  expect(Array.isArray(blocks)).toBe(true)
  if (!Array.isArray(blocks)) return
  const toolResult = blocks.find(block => block.type === 'tool_result')
  expect(toolResult).toMatchObject({ is_error: true, tool_use_id: 'tool-1' })
  expect(toolResult?.content).toEqual([
    { type: 'text', text: '{"completed":[],"failed":{"ok":false},"remaining":1}' },
  ])
  expect(blocks.some(block => block.type === 'image')).toBe(true)
})

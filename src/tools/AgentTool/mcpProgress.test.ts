import { expect, test } from 'bun:test'
import { mcpProgressParentToolUseId, mcpProgressSummary } from './mcpProgress.js'
test('MCP wait feedback survives local and cross-provider message boundaries', () => {
  expect(mcpProgressSummary({ type: 'progress', data: { type: 'mcp_progress', status: 'progress', serverName: 'cloud', toolName: 'read', progressMessage: '等待结果 30s' } })).toEqual({ toolName: 'mcp__cloud__read', summary: '等待结果 30s' })
  expect(mcpProgressSummary({ type: 'tool_progress', tool_name: 'mcp__cloud__read', progress_message: '处理 5/10' })).toEqual({ toolName: 'mcp__cloud__read', summary: '处理 5/10' })
  expect(mcpProgressSummary({ type: 'progress', data: { type: 'bash_progress' } })).toBeUndefined()
  expect(mcpProgressSummary({ type: 'progress', data: { type: 'mcp_progress', status: 'completed', serverName: 'cloud', toolName: 'read' } })).toBeUndefined()
})

test('forwarded MCP progress preserves its caller rather than becoming ancestor activity', () => {
  expect(mcpProgressParentToolUseId({ type: 'progress', toolUseID: 'mcp-call', parentToolUseID: 'mcp-call' })).toBeNull()
  expect(mcpProgressParentToolUseId({ type: 'progress', toolUseID: 'mcp-call', parentToolUseID: 'child-agent-call' })).toBe('child-agent-call')
  expect(mcpProgressParentToolUseId({ type: 'progress', toolUseID: 'mcp-call', parentToolUseID: 'parent-agent-call' })).toBe('parent-agent-call')
  expect(mcpProgressParentToolUseId({ type: 'tool_progress', parent_tool_use_id: 'parent-agent-call' })).toBe('parent-agent-call')
})

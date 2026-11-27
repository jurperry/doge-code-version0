/** A forwarded tool keeps its MCP id but acquires the receiving Agent call id. */
export function mcpProgressParentToolUseId(message: Record<string, any>): string | null {
  if (message.type === 'tool_progress') return message.parent_tool_use_id ?? null
  return message.toolUseID !== message.parentToolUseID ? message.parentToolUseID ?? null : null
}

/** Activity only: never changes task identity, token usage or tool count. */
export function mcpProgressSummary(message: Record<string, any>): { toolName: string; summary: string } | undefined {
  if (message.type === 'tool_progress' && typeof message.progress_message === 'string' &&
    typeof message.tool_name === 'string' && message.tool_name.startsWith('mcp__')) {
    return { toolName: message.tool_name, summary: message.progress_message }
  }
  const data = message.type === 'progress' ? message.data : undefined
  if (data?.type !== 'mcp_progress' || !['started', 'progress'].includes(data.status) ||
    typeof data.serverName !== 'string' || typeof data.toolName !== 'string') return undefined
  const toolName = `mcp__${data.serverName}__${data.toolName}`
  return { toolName, summary: data.progressMessage || `等待 MCP ${data.serverName} · ${data.toolName} 返回结果` }
}

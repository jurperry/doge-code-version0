import type { AssistantMessage, UserMessage } from '../types/message.js'

/**
 * Server-side tool blocks enter transcripts when a provider gateway runs
 * its own tools mid-response: GLM's built-in webReader emits a
 * `server_tool_use` block in the assistant turn and inlines the paired
 * `tool_result` in the SAME assistant message; Anthropic-native server
 * web search emits `server_tool_use` + `web_search_tool_result`. Those
 * blocks are provider-private and must not be replayed verbatim:
 *
 * - Kimi's anthropic-compat backend converts `server_tool_use` into its
 *   own tool_calls and 400s with "tool_call_ids did not have response
 *   messages: webReader:0" because the inlined tool_result cannot map to
 *   a role=tool message (every subsequent turn replays the same history,
 *   so the session is stuck until compaction).
 * - The openai converter drops the blocks entirely, silently losing the
 *   tool result content.
 *
 * flattenServerToolBlocksForAPI rewrites the whole class into plain text
 * at the API-prep boundary (normalizeMessagesForAPI), so every provider
 * sees a portable transcript with the same information. The stored
 * transcript is never mutated — only the API-bound copy.
 */

const SERVER_TOOL_USE_TYPES = new Set(['server_tool_use', 'mcp_tool_use'])

type ApiMessage = UserMessage | AssistantMessage
type AnyBlock = { type: string; [key: string]: unknown }

function isServerToolUseBlock(block: AnyBlock): boolean {
  return SERVER_TOOL_USE_TYPES.has(block.type)
}

function isServerToolResultBlock(block: AnyBlock): boolean {
  // Plain `tool_result` does not match: the suffix needs a provider
  // prefix (web_search_ / web_fetch_ / mcp_ / code_execution_ / …).
  return block.type.endsWith('_tool_result')
}

// A `tool_result` inside an assistant message can only be a gateway-inlined
// server-tool result — client tool results always live in user messages.
function isInlinedToolResult(block: AnyBlock, role: string): boolean {
  return block.type === 'tool_result' && role === 'assistant'
}

function isFlattenable(block: AnyBlock, role: string): boolean {
  return (
    isServerToolUseBlock(block) ||
    isServerToolResultBlock(block) ||
    isInlinedToolResult(block, role)
  )
}

function contentBlocks(message: ApiMessage): AnyBlock[] {
  const content = message.message?.content
  return Array.isArray(content) ? (content as AnyBlock[]) : []
}

function messageHasFlattenableBlock(message: ApiMessage): boolean {
  const role = message.type
  return contentBlocks(message).some(block =>
    isFlattenable(block as AnyBlock, role),
  )
}

function serverToolNameById(messages: ApiMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (
        isServerToolUseBlock(block) &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        names.set(block.id, block.name)
      }
    }
  }
  return names
}

function textBlock(text: string): { type: 'text'; text: string; citations: unknown[] } {
  return { type: 'text', text, citations: [] }
}

function describeServerToolUse(block: AnyBlock) {
  const name = typeof block.name === 'string' ? block.name : 'unknown'
  let input = ''
  if (typeof block.input === 'string' && block.input.length > 0) {
    input = block.input
  } else if (
    typeof block.input === 'object' &&
    block.input !== null &&
    Object.keys(block.input).length > 0
  ) {
    input = JSON.stringify(block.input)
  }
  // Leading \n keeps labels readable when the openai converter joins
  // adjacent text blocks with '' (anthropic branch keeps blocks apart).
  return textBlock(
    `\n[Server tool call: ${name}]${input.length > 0 ? '\n' + input : ''}`,
  )
}

function resultContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (part && typeof part === 'object') {
          if (part.type === 'text' && typeof part.text === 'string') {
            return part.text
          }
          if (part.type === 'image') return '[image]'
          return JSON.stringify(part)
        }
        return String(part)
      })
      .filter(text => text.length > 0)
      .join('\n')
  }
  if (content && typeof content === 'object') return JSON.stringify(content)
  return ''
}

function describeServerToolResult(block: AnyBlock, names: Map<string, string>) {
  const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
  const name = names.get(id) ?? 'unknown'
  const body = resultContentToText(block.content)
  return textBlock(
    `\n[Server tool result: ${name}]\n${body.length > 0 ? body : '(empty result)'}`,
  )
}

function flattenBlock(
  block: AnyBlock,
  role: string,
  names: Map<string, string>,
): AnyBlock {
  if (isServerToolUseBlock(block)) return describeServerToolUse(block)
  if (isServerToolResultBlock(block) || isInlinedToolResult(block, role)) {
    return describeServerToolResult(block, names)
  }
  return block
}

/**
 * Rewrite server-side tool use/result blocks (and assistant-embedded
 * tool_result blocks) into labeled text blocks. Messages without any
 * flattenable block are returned by reference; never returns an empty
 * content array because every replacement carries a label line.
 * Idempotent: text replacements contain no flattenable blocks.
 */
export function flattenServerToolBlocksForAPI<T extends ApiMessage>(
  messages: T[],
): T[] {
  if (!messages.some(messageHasFlattenableBlock)) return messages
  const names = serverToolNameById(messages)
  return messages.map(message => {
    if (!messageHasFlattenableBlock(message)) return message
    const role = message.type
    const content = contentBlocks(message).map(block =>
      flattenBlock(block as AnyBlock, role, names),
    )
    return { ...message, message: { ...message.message, content } }
  })
}

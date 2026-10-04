/** A query can yield an API error and return normally without throwing. */
import type { Message } from '../../types/message.js'
import { extractTextContent } from '../../utils/messages.js'

export function agentRequestError(messages: readonly Message[]): Error | undefined {
  const last = messages.findLast(message => message.type === 'assistant')
  if (last?.type === 'assistant' && last.isApiErrorMessage) {
    return new Error(extractTextContent(last.message.content, '\n') || '代理请求失败')
  }
  return undefined
}

export function agentCompletionStatus(
  messages: readonly Message[], error?: Error, aborted = false,
): 'completed' | 'failed' | 'stopped' {
  if (aborted) return 'stopped'
  return error || agentRequestError(messages) ? 'failed' : 'completed'
}

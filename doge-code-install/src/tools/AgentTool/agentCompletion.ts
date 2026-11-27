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

/** 末条 API 错误的传输类（claude.ts 在错误 assistant 消息上标注
 *  apiErrorTransport）：network=连接级断连/超时——已跑满 10 轮网络预算，
 *  续跑只会整额重付，不再续跑；api=其余（429/5xx 等），允许有界续跑。
 *  旧消息未标注时视为 api（保守续跑）。 */
export function agentRequestErrorClass(
  messages: readonly Message[],
): 'network' | 'api' | undefined {
  const last = messages.findLast(message => message.type === 'assistant')
  if (!last || last.type !== 'assistant' || !last.isApiErrorMessage) return undefined
  return (last as { apiErrorTransport?: 'network' | 'api' }).apiErrorTransport ?? 'api'
}

export function agentCompletionStatus(
  messages: readonly Message[], error?: Error, aborted = false,
): 'completed' | 'failed' | 'stopped' {
  if (aborted) return 'stopped'
  return error || agentRequestError(messages) ? 'failed' : 'completed'
}

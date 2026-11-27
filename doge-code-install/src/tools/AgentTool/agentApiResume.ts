import type { Message } from '../../types/message.js'

/** API 错误续跑上限与退避（毫秒）——单次请求失败不整损小时级工作流步骤。
 *  异步（runAsyncAgentLifecycle）、同步（AgentTool 收尾点）与 in-process
 *  队友三路共用。放在独立模块：swarm 侧直接 import agentToolUtils 会成环
 *  （AgentTool → spawnMultiAgent → inProcessRunner）。 */
export const AGENT_API_ERROR_RESUME_MAX = 2
export const AGENT_API_ERROR_RESUME_BACKOFF_MS = [1500, 4000]

/**
 * Drop trailing API-error assistant records and non-conversational records
 * (stream_event/attachment/progress) so the remainder can be fed back as
 * promptMessages to continue the SAME agent conversation. Mirrors the shape
 * resumeAgent reconstructs from the sidechain transcript (assistant/user
 * records only) — query() treats that as a resumable conversation.
 */
export function stripTrailingApiErrorMessages(
  messages: readonly Message[],
): Message[] {
  const copy = messages.filter(
    m => m.type === 'assistant' || m.type === 'user',
  )
  while (copy.length > 0) {
    const last = copy[copy.length - 1]!
    if (last.type === 'assistant' && last.isApiErrorMessage) {
      copy.pop()
      continue
    }
    break
  }
  return copy
}

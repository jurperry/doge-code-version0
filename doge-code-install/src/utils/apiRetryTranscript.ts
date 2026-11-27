import type { UUID } from 'crypto'
import type { TranscriptMessage } from '../types/logs.js'

/** Retry status is live UI state; the final assistant API error is history. */
export function isApiRetryStatus(message: { type: string; subtype?: string }): boolean {
  return message.type === 'system' && message.subtype === 'api_error'
}

/**
 * Older headless engines wrote retry batches on the NEXT user turn. The first
 * retry then chained to its original request, bypassing replies already saved
 * between that request and the next turn. Reconnect only this recognizable
 * late batch, in memory. Intentional forks and other agent/session scopes stay
 * intact; parents of ordinary messages are never inferred from file order.
 */
export function relinkDeferredApiRetries(messages: Map<UUID, TranscriptMessage>): void {
  const previous = new Map<string, TranscriptMessage>()
  const priorChildren = new Map<UUID, Set<UUID>>()
  const scope = (m: TranscriptMessage): string =>
    JSON.stringify([m.sessionId, m.isSidechain === true, m.agentId ?? null])

  const descendsFrom = (tip: TranscriptMessage, ancestor: UUID, key: string, forbidden: UUID): boolean => {
    const seen = new Set<UUID>()
    let current: TranscriptMessage | undefined = tip
    while (current && !seen.has(current.uuid)) {
      if (current.uuid === forbidden || scope(current) !== key) return false
      // More than one already saved child means an intentional/ambiguous fork.
      // File order cannot decide which branch a late retry belongs to.
      if ((priorChildren.get(current.uuid)?.size ?? 0) > 1) return false
      if (current.uuid === ancestor) return true
      if (current.type === 'system' && current.subtype === 'compact_boundary') return false
      // Compaction and explicit roots end the chain naturally.
      seen.add(current.uuid)
      current = current.parentUuid ? messages.get(current.parentUuid) : undefined
    }
    return false
  }

  for (const [uuid, message] of messages) {
    const key = scope(message)
    if (isApiRetryStatus(message)) {
      const prior = previous.get(key)
      const parent = message.parentUuid ? messages.get(message.parentUuid) : undefined
      if (prior && parent && !isApiRetryStatus(parent) && scope(parent) === key &&
          Date.parse(message.timestamp) < Date.parse(prior.timestamp) &&
          descendsFrom(prior, parent.uuid, key, uuid)) {
        messages.set(uuid, { ...message, parentUuid: prior.uuid })
      }
    } else {
      previous.set(key, message)
      const parent = message.parentUuid ? messages.get(message.parentUuid) : undefined
      const content = 'message' in message ? message.message.content : undefined
      // Parallel tool results intentionally share sourceToolAssistantUUID.
      // They are protocol siblings, not alternative user-intent branches.
      const toolResultOnly = message.type === 'user' && Array.isArray(content) &&
        content.length > 0 && content.every(block => block.type === 'tool_result')
      if (parent && scope(parent) === key && message.type !== 'progress' && !toolResultOnly) {
        const children = priorChildren.get(parent.uuid) ?? new Set<UUID>()
        children.add(uuid)
        priorChildren.set(parent.uuid, children)
      }
    }
  }
}

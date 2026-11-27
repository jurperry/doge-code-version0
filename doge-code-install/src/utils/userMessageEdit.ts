import { randomUUID } from 'crypto'
import type { Message } from '../types/message.js'

function blocks(message: any): any[] {
  const content = message.message?.content
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
}

function isInterruption(message: any): boolean {
  return message.type === 'user' && message.isUserInterruption === true
}

export function latestEditableUser(messages: readonly Message[]): Message | undefined {
  return messages.findLast(message => message.type === 'user' && !message.isMeta && !message.isCompactSummary && !message.toolUseResult && !isInterruption(message) && !blocks(message).some(block => block.type === 'tool_result'))
}

function hasActivity(message: any): boolean {
  if (message.isResumeSentinel === true) return false
  if (message.type === 'assistant') {
    return !!message.isApiErrorMessage || blocks(message).some(block => !['thinking', 'redacted_thinking'].includes(block.type) && (block.type !== 'text' || !!block.text?.length))
  }
  if (message.type === 'stream_event') {
    const event = message.event
    if (event?.type === 'content_block_start') {
      const block = event.content_block
      return block && !['thinking', 'redacted_thinking'].includes(block.type) && (block.type !== 'text' || !!block.text?.length)
    }
    if (event?.type === 'content_block_delta') {
      return event.delta?.type === 'input_json_delta' || (event.delta?.type === 'text_delta' && !!event.delta.text?.length)
    }
  }
  if (message.type === 'control_request') return ['can_use_tool', 'elicitation'].includes(message.request?.subtype)
  if (message.type === 'system') return ['task_started', 'task_progress', 'task_notification', 'task_tool_call', 'tool_use_summary'].includes(message.subtype)
  return message.type === 'tool_use_summary' || message.type === 'tool_progress' || (message.type === 'user' && blocks(message).some(block => block.type === 'tool_result'))
}

function assertSafeTail(messages: readonly Message[], target: string): number {
  const index = messages.findIndex(message => message.uuid === target && message.type === 'user')
  if (index < 0 || latestEditableUser(messages)?.uuid !== target) throw new Error('User message edit target is stale')
  if (messages.slice(index + 1).some(hasActivity)) throw new Error('User message already produced output or tool activity')
  return index
}

/** Facts survive API retries and UI preview resets. Unknown historic attempts are closed. */
export class UserMessageEditTracker {
  private id: string | undefined
  private active = false
  private interrupted = false
  private activity = false
  private completed = false

  constructor(messages: readonly Message[]) {
    const latest = latestEditableUser(messages)
    this.id = latest?.uuid
    if (latest?.userMessageEditState === 'interrupted-thinking' && this.id) {
      try { assertSafeTail(messages, this.id); this.interrupted = true } catch { this.activity = true }
    }
  }

  receive(id: string | undefined): void {
    this.id = id
    this.active = true
    this.interrupted = false
    this.activity = false
    this.completed = false
  }

  markActivity(): void { this.activity = true }
  observe(message: any): void {
    if (hasActivity(message)) this.activity = true
    if (message.type === 'result') {
      // Keep thinking-only stops editable. Older engine paths may still report
      // error_during_execution; real API errors also carry an error assistant.
      const terminalError = message.is_error && message.subtype !== 'error_interrupted' && message.subtype !== 'error_during_execution'
      if (!this.interrupted || terminalError) this.completed = true
    }
  }
  interrupt(): void { if (this.active && !this.completed) this.interrupted = true }
  settle(): void { this.active = false }
  snapshot(): { user_message_id?: string; can_replace: boolean } {
    return { ...(this.id ? { user_message_id: this.id } : {}), can_replace: !!this.id && !this.active && this.interrupted && !this.activity && !this.completed }
  }
}

/** The durable write is the commit point. A rejection leaves the live context intact. */
export async function commitUserMessageReplacement(
  messages: Message[], target: string, replacement: Message[], persist: () => Promise<void>,
): Promise<void> {
  const index = assertSafeTail(messages, target)
  await persist()
  messages.splice(index, messages.length - index, ...replacement)
}

/** Keep all non-conversation facts; remove only the canceled attempt's message suffix. */
export function rewriteUserMessageTranscript(content: string, target: string, replacement?: Message[]): string {
  // Raw lines (including CRLF, whitespace and blank lines) retain all old
  // history byte offsets. Only the edited record/removed attempt may move.
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const parsed = lines.map(raw => ({ raw, record: raw.trim() ? JSON.parse(raw) : undefined }))
  const records = parsed.flatMap(line => line.record ? [line.record] : [])
  const conversation = records.filter(record => !record.isSidechain && ['user', 'assistant', 'system', 'attachment', 'progress'].includes(record.type))
  const index = assertSafeTail(conversation, target)
  const original = conversation[index] as any
  if (!replacement) {
    original.userMessageEditState = 'interrupted-thinking'
    return parsed.map(({ raw, record }) => record === original ? JSON.stringify(record) + (raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '') : raw).join('')
  }
  if (original.userMessageEditState !== 'interrupted-thinking') throw new Error('User message is not replaceable')
  if (!replacement.length || replacement.some(message => !message.uuid) || latestEditableUser(replacement)?.uuid === target) throw new Error('Invalid replacement messages')
  const removed = new Set(conversation.slice(index).map(message => message.uuid).filter(Boolean))
  let parentUuid = original.parentUuid ?? null
  const inserted = replacement.map(message => {
    const record = { ...original, ...message, parentUuid, userMessageEditState: undefined }
    parentUuid = message.uuid
    return record
  })
  const result: string[] = []
  for (const { raw, record } of parsed) {
    if (!record) { result.push(raw); continue }
    if (record.uuid === target) result.push(...inserted.map(record => JSON.stringify(record) + '\n'))
    if (!record.isSidechain && removed.has(record.uuid)) {
      if (record.type === 'assistant' && record.message?.usage) {
        result.push(JSON.stringify({ type: 'network-retry-usage', uuid: randomUUID(), sessionId: record.sessionId, timestamp: record.timestamp ?? new Date().toISOString(), sourceUuid: record.uuid,
          message: { id: record.message.id, model: record.message.model, usage: record.message.usage } }) + '\n')
      }
      continue
    }
    result.push(raw)
  }
  return result.join('')
}

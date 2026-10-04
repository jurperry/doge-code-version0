/** Convert child SDK records into the same sidechain format as local agents. */
import type { Message } from '../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import type { SdkEvent } from '../../utils/sdkEventQueue.js'

export function stepTranscriptMessage(wire: Record<string, any>): Message | undefined {
  if (wire.isReplay) return undefined
  const content = wire.message?.content
  if (wire.type === 'assistant' && Array.isArray(content)) {
    const base = createAssistantMessage({ content, usage: wire.message.usage })
    return { ...base, uuid: wire.uuid ?? base.uuid, message: { ...base.message, ...wire.message } }
  }
  if (wire.type === 'user' && (Array.isArray(content) || typeof content === 'string')) {
    return createUserMessage({ content, uuid: wire.uuid, toolUseResult: wire.tool_use_result })
  }
  return undefined
}

/** Retain only surviving messages when choosing the next sidechain parent. */
export class StepTranscriptChain {
  private readonly messages = new Map<string, Message['uuid'][]>()

  parent(agentId: string): Message['uuid'] | undefined {
    return this.messages.get(agentId)?.at(-1)
  }

  append(agentId: string, uuid: Message['uuid']): void {
    this.messages.set(agentId, [...this.messages.get(agentId) ?? [], uuid])
  }

  discard(agentId: string, uuid: Message['uuid']): void {
    this.messages.set(agentId, (this.messages.get(agentId) ?? []).filter(id => id !== uuid))
  }
}

/** Namespace child identities so concurrent subprocesses cannot share rows or files. */
export class StepTranscriptRelay {
  private readonly tools = new Map<string, string>()
  private readonly tasks = new Map<string, { agentId: string; terminal: boolean }>()
  private readonly seen = new Set<string>()
  private readonly messageIds = new Map<string, { agentId: string; uuid: Message['uuid'] }[]>()

  constructor(private readonly rootAgentId: string, private readonly workflowName: string) {}

  private identity(id: string): string {
    return `${this.rootAgentId}-${id.replace(/[^\w-]/g, '_')}`
  }

  consume(wire: Record<string, any>): { record?: { agentId: string; message: Message }; event?: SdkEvent; discard?: { agentId: string; uuid: Message['uuid'] }[] } {
    if (wire.type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(wire.subtype) && typeof wire.task_id === 'string') {
      const previous = this.tasks.get(wire.task_id)
      const agentId = previous?.agentId ?? this.identity(wire.agent_id ?? wire.task_id)
      const terminal = previous?.terminal || wire.subtype === 'task_notification'
      this.tasks.set(wire.task_id, { agentId, terminal })
      if (wire.tool_use_id) this.tools.set(wire.tool_use_id, agentId)
      if (previous?.terminal && wire.subtype !== 'task_notification') return {}
      return { event: { ...wire, task_id: this.identity(wire.task_id), agent_id: agentId,
        tool_use_id: wire.tool_use_id ? this.identity(wire.tool_use_id) : undefined,
        workflow_name: this.workflowName } as SdkEvent }
    }
    const internal = wire.type === 'system' && wire.subtype === 'agent_transcript'
    const discardedIds: string[] = wire.subtype === 'api_retry' ? wire.discard_message_ids ?? []
      : internal && wire.message?.subtype === 'api_error' ? wire.message.discardMessageIds ?? [] : []
    if (discardedIds.length) return { discard: discardedIds.flatMap(id => this.messageIds.get(id) ?? []) }
    if (internal && wire.message?.type === 'tombstone') {
      return { discard: [{ agentId: this.identity(wire.agent_id), uuid: wire.message.message.uuid }] }
    }
    const message = internal ? wire.message as Message : stepTranscriptMessage(wire)
    if (!message || (message.type !== 'assistant' && message.type !== 'user')) return {}
    const agentId = internal ? this.identity(wire.agent_id)
      : wire.parent_tool_use_id ? this.tools.get(wire.parent_tool_use_id) ?? this.identity(wire.parent_tool_use_id) : this.rootAgentId
    const key = `${agentId}:${message.uuid}`
    if (this.seen.has(key)) return {}
    this.seen.add(key)
    if (message.type === 'assistant') {
      for (const id of [message.uuid, message.message.id]) {
        this.messageIds.set(id, [...this.messageIds.get(id) ?? [], { agentId, uuid: message.uuid }])
      }
    }
    return { record: { agentId, message } }
  }

  /** A killed/failed child may never emit nested task notifications. */
  finish(status: 'completed' | 'failed' | 'stopped'): SdkEvent[] {
    return [...this.tasks].filter(([, task]) => !task.terminal).map(([id]) => ({
      type: 'system', subtype: 'task_notification', task_id: this.identity(id),
      status, output_file: '', summary: '子进程步骤已结束',
    }))
  }
}

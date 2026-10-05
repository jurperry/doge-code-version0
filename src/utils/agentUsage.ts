/** Progress tokens are latest context input + distinct response outputs.
 * Billing totals intentionally belong to the session usage ledger instead. */
interface UsageFields {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

interface UsageMessage {
  id?: string
  model?: string
  usage?: UsageFields
}

export interface AgentUsageRecord {
  type: string
  uuid?: string
  parent_tool_use_id?: string | null
  message?: UsageMessage
  event?: { type: string; message?: UsageMessage; usage?: UsageFields }
}

const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'] as const
const positive = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

function merge(previous: UsageFields, next?: UsageFields): UsageFields {
  const result = { ...previous }
  for (const field of fields) if (positive(next?.[field])) result[field] = next![field]
  return result
}

export class AgentUsageTracker {
  private responses = new Map<string, { usage: UsageFields; finalUsage: UsageFields; message?: UsageMessage }>()
  private currentId?: string

  observe(record: AgentUsageRecord): void {
    if (record.parent_tool_use_id) return
    if (record.type === 'stream_event') {
      const event = record.event
      if (event?.type === 'message_start') {
        this.currentId = event.message?.id
        if (this.currentId) this.save(this.currentId, event.message?.usage)
      } else if (event?.type === 'message_delta' && this.currentId) {
        this.save(this.currentId, event.usage, undefined, true)
      }
      return
    }
    if (record.type !== 'assistant' || record.message?.model === '<synthetic>') return
    const id = record.message?.id ?? record.uuid
    if (!id) return
    this.currentId = id
    this.save(id, record.message?.usage, record.message)
  }

  private save(id: string, usage?: UsageFields, message?: UsageMessage, final = false): void {
    const previous = this.responses.get(id)
    this.responses.set(id, {
      usage: merge(previous?.usage ?? {}, usage),
      finalUsage: final ? merge(previous?.finalUsage ?? {}, usage) : previous?.finalUsage ?? {},
      message: message ?? previous?.message,
    })
  }

  totalTokens(): number {
    let latestInput = 0
    let outputs = 0
    for (const sample of this.responses.values()) {
      // GLM's message_delta replaces usage on the already yielded message.
      // Keep that message reference and read it when reporting progress/finish.
      // Serialized assistant snapshots cannot override a later final SSE delta.
      const usage = merge(merge(sample.usage, sample.message?.usage), sample.finalUsage)
      const input = positive(usage.input_tokens) + positive(usage.cache_creation_input_tokens) + positive(usage.cache_read_input_tokens)
      if (input > 0) latestInput = input
      outputs += positive(usage.output_tokens)
    }
    return latestInput + outputs
  }
}

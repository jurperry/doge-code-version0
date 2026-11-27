/** Streaming liveness, without storing reasoning text or claiming estimated tokens. */
export class StepActivity {
  private phase = '等待模型响应'
  private requestAt: number
  private lastActivityAt: number
  private characters = 0
  private sawContent = false
  constructor(now = Date.now()) { this.requestAt = now; this.lastActivityAt = now }
  observe(wire: { type: string; event?: any }, now = Date.now()): boolean {
    if (wire.type !== 'stream_event' || !wire.event) return false
    const event = wire.event
    if (event.type === 'message_start') {
      this.requestAt = now; this.lastActivityAt = now; this.characters = 0; this.sawContent = false; this.phase = '等待模型响应'
      return false
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block?.type === 'thinking') this.phase = '模型正在思考'
      else if (block?.type === 'text') this.phase = '正在生成回复'
      else if (block?.type === 'tool_use') this.phase = `正在生成工具参数 ${block.name ?? ''}`.trim()
      else return false
      this.characters = 0
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta
      const text = delta?.thinking ?? delta?.text ?? delta?.partial_json
      if (typeof text !== 'string' || !text) return false
      this.characters += text.length
    } else return false
    this.sawContent = true; this.lastActivityAt = now
    return true
  }
  summary(now = Date.now()): string {
    if (!this.sawContent) return `等待模型响应 ${Math.round((now - this.requestAt) / 1000)}s`
    const gap = Math.round((now - this.lastActivityAt) / 1000)
    return `${this.phase}${this.characters ? ` · 已收到 ${this.characters} 字符` : ''}${gap >= 10 ? ` · 最近活动 ${gap}s 前` : ''}`
  }
}

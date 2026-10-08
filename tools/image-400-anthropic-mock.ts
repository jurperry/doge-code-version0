/**
 * 图片 400 场景的 Anthropic 格式 SSE mock（0.2.126 三分支覆盖验证——
 * 用户实际配置路径）。端点：POST /v1/messages?beta=true。
 * 剧本：seq1 tool_use Read → seq2 请求含 image 块时按 IMG_MODE 回 400
 *（reject=GLM [1210] 中文报文；reject-unknown=不可识别文本，判别 APIError
 * 兜底路径）→ seq3 文本回复（剥图重试到达）。
 * env：MOCK_PORT / IMG_FILE / IMG_MODE=reject|reject-unknown|corrupt
 */
const PORT = Number(process.env.MOCK_PORT ?? 8941)
const IMG_FILE = process.env.IMG_FILE ?? ''
const MODE = process.env.IMG_MODE ?? 'reject'
let seq = 0
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o))

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== 'POST' || !url.pathname.includes('/v1/messages')) {
      return new Response(JSON.stringify({ error: { code: '404', message: 'not found' } }), { status: 404 })
    }
    const raw = await req.text()
    seq += 1
    const hasImage = raw.includes('"type":"image"')
    const mid = `msg_anthropic_${seq}`
    const frames: string[] = []
    const ev = (o: object) => frames.push(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)

    if (seq === 1) {
      log({ seq, kind: 'ask-read' })
      const args = JSON.stringify({ file_path: IMG_FILE })
      ev({ type: 'message_start', message: { id: mid, model: 'glm-5.3-flash', role: 'assistant', content: [], usage: { input_tokens: 900, output_tokens: 0 } } })
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_an_read', name: 'Read', input: {} } })
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } })
      ev({ type: 'content_block_stop', index: 0 })
      ev({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 900, output_tokens: 20 } })
      ev({ type: 'message_stop' })
    } else {
      const reply = seq === 2 && hasImage ? '（图片被剥离后）收到，我看到了文件。' : '收到，处理完成。'
      log({ seq, kind: hasImage ? 'with-image' : 'text' })
      ev({ type: 'message_start', message: { id: mid, model: 'glm-5.3-flash', role: 'assistant', content: [], usage: { input_tokens: 1000, output_tokens: 0 } } })
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      for (const piece of reply.match(/[\s\S]{1,24}/g) ?? []) {
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
      }
      ev({ type: 'content_block_stop', index: 0 })
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1000, output_tokens: 12 } })
      ev({ type: 'message_stop' })
    }
    frames.push('data: [DONE]\n\n')

    if (MODE === 'ptl' && seq >= 2) {
      // 中文长度类溢出（GLM anthropic 端点形态）——验证共享 PTL 归一命中
      log({ seq, kind: 'ptl-400' })
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Prompt长度超过模型上限（1313714 > 1000000）' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    if (hasImage && (MODE === 'reject' || MODE === 'reject-unknown')) {
      // 到达这里的只可能是 seq>=2 且带图（seq1 无图）——拦截在帧组装后只为
      // 记日志顺序一致，实际不输出流
      log({ seq, kind: 'image-400' })
      const body = MODE === 'reject'
        ? { type: 'error', error: { type: 'invalid_request_error', message: '[1210][图片输入格式/解析错误]' } }
        : { type: 'error', error: { type: 'invalid_request_error', message: 'totally unrecognized failure' } }
      return new Response(JSON.stringify(body), { status: 400, headers: { 'content-type': 'application/json' } })
    }

    return new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  },
})
console.log(JSON.stringify({ mockReady: true, port: PORT, mode: MODE, api: 'anthropic' }))

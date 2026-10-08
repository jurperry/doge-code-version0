/**
 * 图片 400 场景的 Responses 格式 SSE mock（0.2.126 三分支覆盖验证）。
 * 端点：POST /v1/responses（responsesCompat 分支）。
 * 剧本：seq1 返回 function_call（Read IMG_FILE）→ seq2 若请求含 input_image
 * 且 IMG_MODE=reject 则回 400 {"error":{"code":"1210","message":"图片输入格式/
 * 解析错误"}}（GLM 报文形态）→ seq3+ 文本回复（剥图重试到达）。
 * env：MOCK_PORT / IMG_FILE / IMG_MODE=reject|corrupt
 */
const PORT = Number(process.env.MOCK_PORT ?? 8931)
const IMG_FILE = process.env.IMG_FILE ?? ''
const MODE = process.env.IMG_MODE ?? 'reject'
let seq = 0
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o))

const sse = (obj: object) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== 'POST' || !url.pathname.endsWith('/v1/responses')) {
      return new Response(JSON.stringify({ error: { code: '404', message: 'not found' } }), { status: 404 })
    }
    const raw = await req.text()
    seq += 1
    const hasImage = raw.includes('"input_image"')
    const rid = `resp_${seq}`

    if (seq === 1) {
      log({ seq, kind: 'ask-read' })
      const args = JSON.stringify({ file_path: IMG_FILE })
      return new Response(
        sse({ type: 'response.created', response: { id: rid } }) +
        sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_read_1', name: 'Read', arguments: '' } }) +
        sse({ type: 'response.function_call_arguments.delta', item_id: 'fc_read_1', delta: args }) +
        sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_read_1', name: 'Read', arguments: args } }) +
        sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 900, output_tokens: 20 } } }) +
        'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }

    if (hasImage && (MODE === 'reject' || MODE === 'reject-unknown')) {
      log({ seq, kind: 'image-400' })
      // reject-unknown：报文不含任何已知图片错误模式——区分新旧代码的判别
      // 场景（旧代码 plain Error 逃逸分类→回合死；APIError 化后 isClientError
      // 兜底触发剥图重试）
      const body = MODE === 'reject'
        ? { error: { code: '1210', message: '图片输入格式/解析错误' } }
        : { error: { code: '499', message: 'totally unrecognized failure' } }
      return new Response(JSON.stringify(body), { status: 400, headers: { 'content-type': 'application/json' } })
    }

    const reply = seq === 2 && hasImage ? '（图片被剥离后）收到，我看到了文件。' : '收到，处理完成。'
    log({ seq, kind: hasImage ? 'with-image' : 'text' })
    return new Response(
      sse({ type: 'response.created', response: { id: rid } }) +
      sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `msg_${seq}`, role: 'assistant' } }) +
      sse({ type: 'response.output_text.delta', item_id: `msg_${seq}`, delta: reply }) +
      sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `msg_${seq}`, role: 'assistant', content: [{ type: 'output_text', text: reply }] } }) +
      sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 1000, output_tokens: 12 } } }) +
      'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
console.log(JSON.stringify({ mockReady: true, port: PORT, mode: MODE, api: 'responses' }))

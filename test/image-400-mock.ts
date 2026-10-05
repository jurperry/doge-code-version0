/**
 * 图片链路 400 场景的 OpenAI 兼容 SSE mock（0.2.125 工作流容错验证）。
 *
 * 端点：POST /v1/chat/completions。三段剧本：
 *   seq1：返回 Read 工具调用（读 IMG_FILE 指定文件）
 *   seq2：若请求含 image_url（图片已进上下文）→ 按 IMG_MODE：
 *         - reject：返回 400 {"error":{"code":"1210","message":"图片输入格式/解析错误"}}
 *           （GLM 实测报文形态）——用于验证剥图重试
 *         - corrupt：不会发生（Read 解码门先拒），正常回复
 *   seq3+：正常文本回复（剥图后的重试到达）
 * env：MOCK_PORT / IMG_FILE（绝对路径）/ IMG_MODE=reject|corrupt
 */
const PORT = Number(process.env.MOCK_PORT ?? 8911)
const IMG_FILE = process.env.IMG_FILE ?? ''
const MODE = process.env.IMG_MODE ?? 'reject'
let seq = 0
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o))

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ error: { code: '404', message: 'not found' } }), { status: 404 })
    }
    const raw = await req.text()
    seq += 1
    const hasImage = raw.includes('"image_url"')
    const base = { id: `chatcmpl-img-${seq}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'glm-5.3-flash' }

    if (seq === 1) {
      log({ seq, kind: 'ask-read' })
      const toolCall = {
        index: 0, id: 'call_read_1', type: 'function',
        function: { name: 'Read', arguments: JSON.stringify({ file_path: IMG_FILE }) },
      }
      return new Response(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
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
    log({ seq, kind: hasImage ? 'with-image' : 'text', rejected: false })
    const usage = { prompt_tokens: 1000, completion_tokens: 12, total_tokens: 1012 }
    return new Response(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n` +
      'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
console.log(JSON.stringify({ mockReady: true, port: PORT, mode: MODE }))

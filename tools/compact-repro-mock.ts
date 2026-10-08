/**
 * 压缩链路复现/回归用的 OpenAI 兼容 SSE mock（0.2.125 压缩修复验证）。
 *
 * 端点：POST /v1/chat/completions（openaiCompat 分支的形状）。
 * 行为由 env 控制：
 *   MOCK_PORT            监听端口（默认 8901）
 *   MOCK_ARTIFACT=1      第 N 次普通请求的 usage 报 4x（模拟 GLM 虚报）；
 *                         N 由 MOCK_ARTIFACT_AT 指定（默认 2，从 1 计）
 *   MOCK_SUMMARY_FAIL=1  压缩摘要请求返回空内容（模拟「无摘要」失败路径）
 * 每个 JSON 行写 stdout 供断言：{seq, kind, promptTokens, summary}
 */
const PORT = Number(process.env.MOCK_PORT ?? 8901)
const ARTIFACT = process.env.MOCK_ARTIFACT === '1'
const ARTIFACT_AT = Number(process.env.MOCK_ARTIFACT_AT ?? 2)
const SUMMARY_FAIL = process.env.MOCK_SUMMARY_FAIL === '1'

let seq = 0
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o))

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ error: { code: '404', message: 'not found' } }), { status: 404 })
    }
    const body = (await req.json()) as {
      messages?: Array<{ role: string; content: unknown }>
      stream?: boolean
    }
    seq += 1
    const textOf = (c: unknown): string =>
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text ?? '') : '')).join('')
          : ''
    const flat = (body.messages ?? []).map((m) => `${m.role}: ${textOf(m.content)}`).join('\n')
    const promptTokens = Math.max(1, Math.ceil(flat.length / 4))
    const isCompact =
      flat.includes('summarizing conversations') || flat.includes('detailed summary of the conversation')

    let reply: string
    if (isCompact) {
      reply = SUMMARY_FAIL
        ? ''
        : 'Summary:\n1. Primary Request and Intent:\n   - The user asked to verify the compact pipeline.\n2. Key Technical Concepts:\n   - stream-json protocol, compact_boundary event.\n3. Done.'
      log({ seq, kind: 'compact', promptTokens, summary: !SUMMARY_FAIL })
    } else {
      reply = '好的，这是普通回复：1 2 3。'
      const report = ARTIFACT && seq === ARTIFACT_AT ? promptTokens * 4 : promptTokens
      log({ seq, kind: 'normal', promptTokens, report })
    }

    const chunks: string[] = []
    const id = `chatcmpl-mock-${seq}`
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'glm-5.3-flash' }
    if (reply) {
      for (const piece of reply.match(/[\s\S]{1,40}/g) ?? []) {
        chunks.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }] })}\n\n`)
      }
    }
    const usage = isCompact
      ? { prompt_tokens: promptTokens, completion_tokens: Math.ceil(reply.length / 4), total_tokens: promptTokens + Math.ceil(reply.length / 4) }
      : { prompt_tokens: ARTIFACT && seq === ARTIFACT_AT ? promptTokens * 4 : promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 }
    chunks.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`)
    chunks.push('data: [DONE]\n\n')
    return new Response(chunks.join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  },
})
console.log(JSON.stringify({ mockReady: true, port: PORT, artifact: ARTIFACT, artifactAt: ARTIFACT_AT, summaryFail: SUMMARY_FAIL }))

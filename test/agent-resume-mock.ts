/**
 * 代理 API 错误续跑场景的 OpenAI 兼容 SSE mock（0.2.125）。
 * 剧本（按 seq）：
 *   1 主对话：tool_calls 派 Task 子代理（name=test-agent）
 *   2 子代理首请求：400 非瞬态错误（普通 Error 路径——旧代码里这条直接
 *     判死代理；新代码应触发 agentToolUtils 有界续跑）
 *   3 子代理续跑请求：正常文本回复（证明以既有对话续跑成功）
 *   4 主对话：收尾文本
 * env：MOCK_PORT
 */
const PORT = Number(process.env.MOCK_PORT ?? 8921)
let seq = 0
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o))
const sse = (id: string, payload: object) => `data: ${JSON.stringify(payload)}\n\n`

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ error: { code: '404', message: 'not found' } }), { status: 404 })
    }
    const raw = await req.text()
    seq += 1
    // 子代理请求 = 含代理任务 prompt 且无 tool_result 历史（主线 post-tool
    // 请求的历史里也带着 Task 参数，不能按参数文本判）
    const isSubagent = raw.includes('数到三并直接给答案') && !raw.includes('"tool_result"') && !raw.includes('tool_result')
    const base = { id: `chatcmpl-ar-${seq}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'glm-5.3-flash' }
    const usage = { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910 }

    if (seq === 1) {
      log({ seq, kind: 'main-dispatch' })
      const toolCall = {
        index: 0, id: 'call_task_1', type: 'function',
        function: {
          name: 'Task',
          arguments: JSON.stringify({ subagent_type: 'general-purpose', description: '计数任务', prompt: '请数到三并直接给答案' }),
        },
      }
      return new Response(
        sse(base, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: null }] }) +
        sse(base, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
        'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }

    if (isSubagent && seq === 2) {
      // RETRY=1：瞬时 500（TRANSIENT_UPSTREAM_PATTERN 命中→503 可重试），
      // 用于验证 system/api_error 重试事件经 runAgent 透传（0.2.26 前被丢弃）
      if (process.env.RETRY === '1') {
        log({ seq, kind: 'subagent-500' })
        return new Response(
          JSON.stringify({ error: { code: '500', message: 'upstream request failed (transient)' } }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }
      log({ seq, kind: 'subagent-400' })
      return new Response(
        JSON.stringify({ error: { code: '400', message: 'invalid_request: boom (simulated terminal failure)' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }

    const reply = isSubagent ? '代理完成：1、2、3。' : '主对话收尾：子代理已返回。'
    log({ seq, kind: isSubagent ? 'subagent-ok' : 'main-final' })
    return new Response(
      sse(base, { choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] }) +
      sse(base, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }) +
      'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
console.log(JSON.stringify({ mockReady: true, port: PORT }))

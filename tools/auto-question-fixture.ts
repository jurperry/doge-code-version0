import { createServer } from 'node:http'

export const fixtureQuestions = {
  questions: [
    { question: 'Implementation choice?', header: 'Design', multiSelect: false, options: [{ label: 'First', description: 'First option' }, { label: 'Second (Recommended)', description: 'Recommended option' }] },
    { question: 'Verification choices?', header: 'Checks', multiSelect: true, options: [{ label: 'First check', description: 'First' }, { label: 'Second check （推荐）', description: 'Second' }, { label: 'Third check (推荐)', description: 'Third' }] },
  ],
  answers: { 'Implementation choice?': 'model draft' },
}

export async function createQuestionServer(provider: string, question = fixtureQuestions, automaticPlan = false) {
  const requests: any[] = []
  let sequence = 0
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    if (request.url?.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":100}'); return }
    const body = JSON.parse(raw || '{}')
    if (!/\/messages|\/chat\/completions|\/responses/.test(request.url ?? '')) { response.end('{}'); return }
    // Startup title/summary requests have no Ask tool. They must not consume
    // the question scripted for the user's first real model turn.
    const main = (body.tools ?? []).some((entry: any) => entry.name === 'AskUserQuestion' || entry.function?.name === 'AskUserQuestion')
    if (main) requests.push(body)
    const phase = main ? sequence++ : -1
    const enteringPlan = automaticPlan && phase === 0
    const tool = main && phase <= (automaticPlan ? 1 : 0)
    const toolName = enteringPlan ? 'EnterPlanMode' : 'AskUserQuestion'
    const toolInput = enteringPlan ? {} : question
    const id = `message_${sequence}`
    const callId = `question_${sequence}`
    const text = main ? 'AUTO_QUESTION_DONE' : 'AUTO_QUESTION_AUXILIARY'
    if (!body.stream) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(provider === 'anthropic'
        ? { id, type: 'message', role: 'assistant', model: 'auto-question-test', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
        : provider === 'openai' ? { id, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
          : { id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1 } }))
      return
    }
    response.setHeader('content-type', 'text/event-stream')
    const sse = (type: string, data: any) => response.write(`${provider === 'anthropic' ? `event: ${type}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
    if (provider === 'anthropic') {
      const usage = { input_tokens: 100, output_tokens: 10 }
      sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'auto-question-test', content: [], stop_reason: null, usage } })
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: callId, name: toolName, input: {} } : { type: 'text', text: '' } })
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } : { type: 'text_delta', text } })
      sse('content_block_stop', { type: 'content_block_stop', index: 0 })
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage })
      sse('message_stop', { type: 'message_stop' })
    } else if (provider === 'openai') {
      const base = { id, object: 'chat.completion.chunk', model: 'auto-question-test', created: Math.floor(Date.now() / 1000) }
      sse('', { ...base, choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolName, arguments: JSON.stringify(toolInput) } }] } : { role: 'assistant', content: text }, finish_reason: null }] })
      sse('', { ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })
      response.write('data: [DONE]\n\n')
    } else {
      const item = tool ? { type: 'function_call', id: `fc_${sequence}`, call_id: callId, name: toolName, arguments: JSON.stringify(toolInput) }
        : { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] }
      sse('', { type: 'response.created', response: { id, status: 'in_progress' } })
      sse('', { type: 'response.output_item.added', output_index: 0, item: tool ? { ...item, arguments: '' } : { ...item, content: [] } })
      sse('', tool ? { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: JSON.stringify(toolInput) }
        : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text })
      sse('', { type: 'response.output_item.done', output_index: 0, item })
      sse('', { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10 } } })
      response.write('data: [DONE]\n\n')
    }
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseURL = `http://127.0.0.1:${(server.address() as any).port}`
  return { server, baseURL, requests }
}

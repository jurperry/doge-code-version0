import { describe, expect, test } from 'bun:test'
import type { AssistantMessage, UserMessage } from '../types/message.js'
import { flattenServerToolBlocksForAPI } from './serverToolReplay.js'

const asst = (content: unknown[]): AssistantMessage =>
  ({
    type: 'assistant',
    uuid: 'a1',
    message: { id: 'msg_1', role: 'assistant', content },
  }) as unknown as AssistantMessage

const user = (content: unknown): UserMessage =>
  ({
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content },
  }) as unknown as UserMessage

const typesOf = (message: AssistantMessage | UserMessage): string[] =>
  (message.message.content as Array<{ type: string }>).map(b => b.type)

// GLM 兼容网关形态（83734af8 会话实测）：server_tool_use 与配对 tool_result
// 都内嵌在同一条 assistant 消息里。原样重放时 Kimi 把 server_tool_use 转成
// tool_calls 却配不上 tool_result → 400 invalid_request_error (webReader:0)。
describe('flattenServerToolBlocksForAPI — GLM inline shape', () => {
  test('flattens server_tool_use and inlined tool_result into labeled text', () => {
    const messages = [
      user('帮我查资料'),
      asst([
        { type: 'thinking', thinking: 'plan', signature: 'sig' },
        {
          type: 'server_tool_use',
          id: 'call_159236068e6f4caeb6fee206',
          name: 'webReader',
          input: { url: 'https://example.com' },
        },
        { type: 'text', text: '**🌐 Z.ai Built-in Tool: webReader**' },
        {
          type: 'tool_result',
          tool_use_id: 'call_159236068e6f4caeb6fee206',
          content: '网页正文内容',
        },
      ]),
    ]
    const flattened = flattenServerToolBlocksForAPI(messages)
    expect(typesOf(flattened[1]!)).toEqual([
      'thinking',
      'text',
      'text',
      'text',
    ])
    const content = flattened[1]!.message.content as Array<{
      type: string
      text?: string
    }>
    expect(content[1]!.text).toBe(
      '\n[Server tool call: webReader]\n{"url":"https://example.com"}',
    )
    expect(content[3]!.text).toBe(
      '\n[Server tool result: webReader]\n网页正文内容',
    )
  })

  test('omits the input line when the gateway sent empty input', () => {
    const flattened = flattenServerToolBlocksForAPI([
      asst([
        { type: 'server_tool_use', id: 'call_x', name: 'webReader', input: {} },
      ]),
    ])
    const text = (flattened[0]!.message.content as Array<{ text: string }>)[0]!
      .text
    expect(text).toBe('\n[Server tool call: webReader]')
  })

  test('falls back to unknown when the paired use was never recorded', () => {
    // 结果块的 tool_use_id 找不到对应 server_tool_use（如压缩裁掉了调用块）
    const flattened = flattenServerToolBlocksForAPI([
      asst([{ type: 'tool_result', tool_use_id: 'call_gone', content: 'body' }]),
    ])
    const text = (flattened[0]!.message.content as Array<{ text: string }>)[0]!
      .text
    expect(text).toBe('\n[Server tool result: unknown]\nbody')
  })
})

// Anthropic 原生服务端搜索形态：server_tool_use 在 assistant，
// web_search_tool_result 在 user 消息。user 里的普通文本必须原样保留。
describe('flattenServerToolBlocksForAPI — anthropic native shape', () => {
  test('flattens the pair across roles and keeps sibling user text', () => {
    const messages = [
      asst([
        {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'ripgrep' },
        },
      ]),
      user([
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [{ title: 'GitHub - ripgrep', url: 'https://github.com' }],
        },
        { type: 'text', text: '继续' },
      ]),
    ]
    const flattened = flattenServerToolBlocksForAPI(messages)
    expect(typesOf(flattened[0]!)).toEqual(['text'])
    expect(typesOf(flattened[1]!)).toEqual(['text', 'text'])
    const asstText = (flattened[0]!.message.content as Array<{ text: string }>)[0]!
      .text
    expect(asstText).toContain('web_search')
    expect(asstText).toContain('ripgrep')
    const userContent = flattened[1]!.message.content as Array<{
      type: string
      text?: string
    }>
    // 名字按 id 跨消息回查：结果块标签解析出 web_search 而非 unknown
    expect(userContent[0]!.text).toContain('\n[Server tool result: web_search]')
    expect(userContent[0]!.text).toContain('GitHub - ripgrep')
    expect(userContent[1]!.text).toBe('继续')
  })
})

describe('flattenServerToolBlocksForAPI — scope discipline', () => {
  test('leaves the client tool_use/tool_result protocol untouched', () => {
    const toolUse = {
      type: 'tool_use',
      id: 'call_09400cb5f61e483498dbd559',
      name: 'PowerShell',
      input: { command: 'dir' },
    }
    const toolResult = {
      type: 'tool_result',
      tool_use_id: 'call_09400cb5f61e483498dbd559',
      content: 'file list',
    }
    const messages = [asst([toolUse]), user([toolResult])]
    const flattened = flattenServerToolBlocksForAPI(messages)
    expect(flattened[0]!.message.content).toEqual([toolUse])
    expect(flattened[1]!.message.content).toEqual([toolResult])
  })

  test('returns the same array reference when nothing is flattenable', () => {
    const messages = [user('hi'), asst([{ type: 'text', text: 'ok' }])]
    expect(flattenServerToolBlocksForAPI(messages)).toBe(messages)
  })

  test('flattens mcp_tool_use and mcp_tool_result', () => {
    const flattened = flattenServerToolBlocksForAPI([
      asst([
        {
          type: 'mcp_tool_use',
          id: 'mcp_1',
          name: 'search',
          input: { q: 'x' },
        },
      ]),
      user([
        { type: 'mcp_tool_result', tool_use_id: 'mcp_1', content: 'hits' },
      ]),
    ])
    expect(typesOf(flattened[0]!)).toEqual(['text'])
    expect(typesOf(flattened[1]!)).toEqual(['text'])
  })

  test('extracts array result content: text kept, image summarized', () => {
    const flattened = flattenServerToolBlocksForAPI([
      asst([
        { type: 'server_tool_use', id: 's1', name: 'webReader', input: {} },
        {
          type: 'tool_result',
          tool_use_id: 's1',
          content: [
            { type: 'text', text: 'part1' },
            { type: 'image', source: { type: 'base64' } },
          ],
        },
      ]),
    ])
    const resultText = (flattened[0]!.message.content as Array<{ text: string }>)[1]!
      .text
    expect(resultText).toContain('part1')
    expect(resultText).toContain('[image]')
  })

  test('assistant message is never emptied by flattening', () => {
    const flattened = flattenServerToolBlocksForAPI([
      asst([
        { type: 'server_tool_use', id: 's1', name: 'webReader', input: {} },
      ]),
    ])
    expect(typesOf(flattened[0]!)).toEqual(['text'])
    expect(
      (flattened[0]!.message.content as Array<{ text: string }>)[0]!.text.length,
    ).toBeGreaterThan(0)
  })

  test('is idempotent', () => {
    const messages = [
      asst([
        {
          type: 'server_tool_use',
          id: 'call_1',
          name: 'webReader',
          input: { url: 'https://example.com' },
        },
        { type: 'tool_result', tool_use_id: 'call_1', content: 'body' },
      ]),
    ]
    const once = flattenServerToolBlocksForAPI(messages)
    const twice = flattenServerToolBlocksForAPI(once)
    expect(twice).toEqual(once)
  })
})

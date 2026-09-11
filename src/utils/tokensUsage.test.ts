import { test, expect } from 'bun:test'
import type { Message } from '../types/message.js'
import { getCurrentUsage, getTokenUsage } from './tokens.js'

const assistant = (usage: Record<string, number> | undefined): Message =>
  ({
    type: 'assistant',
    uuid: 'test-uuid',
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'glm-5.3',
      content: [{ type: 'text', text: 'hi' }],
      ...(usage !== undefined ? { usage } : {}),
    },
  }) as unknown as Message

test('getTokenUsage returns real usage unchanged', () => {
  const msg = assistant({ input_tokens: 100, output_tokens: 5 })
  expect(getTokenUsage(msg)?.input_tokens).toBe(100)
})

test('getTokenUsage skips all-zero placeholder usage (GLM message_start shape)', () => {
  // GLM 的 anthropic 兼容端点：message_start 占位 {input:0, output:0}，真实
  // 用量只在回合末 message_delta。全零记录必须当作“无数据”跳过。
  expect(getTokenUsage(assistant({ input_tokens: 0, output_tokens: 0 }))).toBeUndefined()
})

test('getTokenUsage skips zero usage with absent cache fields', () => {
  expect(getTokenUsage(assistant({ input_tokens: 0, output_tokens: 0 }))).toBeUndefined()
})

test('getTokenUsage keeps usage when input is 0 but cache_read carries context', () => {
  const msg = assistant({ input_tokens: 0, cache_read_input_tokens: 21120, output_tokens: 3 })
  expect(getTokenUsage(msg)?.cache_read_input_tokens).toBe(21120)
})

test('getCurrentUsage walks back past zero placeholders to the last real usage', () => {
  const messages = [
    assistant({ input_tokens: 21302, output_tokens: 2 }),
    assistant({ input_tokens: 0, output_tokens: 0 }),
  ]
  // 修复前：返回末条全零 → TUI 余量 100% left；修复后向前找到真实值
  expect(getCurrentUsage(messages)?.input_tokens).toBe(21302)
})

test('getCurrentUsage returns null when only placeholders exist', () => {
  expect(getCurrentUsage([assistant({ input_tokens: 0, output_tokens: 0 })])).toBeNull()
})

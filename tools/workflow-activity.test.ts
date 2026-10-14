import { test, expect } from 'bun:test'
import { StepActivity } from '../src/tools/WorkflowTool/stepActivity.js'

test('partial reasoning is visible before a complete assistant block exists', () => {
  const activity = new StepActivity(0)
  activity.observe({ type: 'stream_event', event: { type: 'message_start' } }, 100)
  activity.observe({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } }, 200)
  activity.observe({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '正在分析' } } }, 300)
  expect(activity.summary(800)).toContain('模型正在思考')
  expect(activity.summary(800)).toContain('4 字符')
  expect(activity.summary(12000)).toContain('最近活动 12s 前')
  activity.observe({ type: 'stream_event', event: { type: 'message_start' } }, 13000)
  expect(activity.summary(14000)).toBe('等待模型响应 1s')
})

test('tool argument streaming and text streaming have distinct activity', () => {
  const activity = new StepActivity(0)
  activity.observe({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write' } } }, 100)
  expect(activity.summary(100)).toContain('生成工具参数 Write')
  activity.observe({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }, 200)
  expect(activity.summary(200)).toContain('生成回复')
})

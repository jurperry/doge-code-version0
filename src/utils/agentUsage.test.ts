import { expect, test } from 'bun:test'
import { AgentUsageTracker } from './agentUsage.js'

const assistant = (id: string, usage: Record<string, number>, extra = {}) => ({ type: 'assistant', message: { id, model: 'glm', usage }, ...extra })

test('progress uses latest context input plus one output snapshot per response', () => {
  const tracker = new AgentUsageTracker()
  tracker.observe(assistant('a', { input_tokens: 10000, cache_read_input_tokens: 20000, output_tokens: 5 }))
  tracker.observe(assistant('a', { input_tokens: 10000, cache_read_input_tokens: 20000, output_tokens: 15 }))
  tracker.observe(assistant('b', { input_tokens: 11000, cache_read_input_tokens: 20000, output_tokens: 25 }))
  expect(tracker.totalTokens()).toBe(31040)
})

test('GLM final usage mutation after yielding is read at terminal notification', () => {
  const tracker = new AgentUsageTracker()
  const message = assistant('a', { input_tokens: 0, output_tokens: 0 })
  tracker.observe(message)
  expect(tracker.totalTokens()).toBe(0)
  message.message.usage = { input_tokens: 11000, cache_read_input_tokens: 20000, output_tokens: 25 }
  expect(tracker.totalTokens()).toBe(31025)
})

test('zero placeholders and synthetic assistant messages do not erase known input', () => {
  const tracker = new AgentUsageTracker()
  tracker.observe(assistant('a', { input_tokens: 100, output_tokens: 15 }))
  tracker.observe(assistant('b', { input_tokens: 0, output_tokens: 0 }))
  tracker.observe({ type: 'assistant', message: { id: 'c', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } })
  expect(tracker.totalTokens()).toBe(115)
})

test('stream start, final delta and assistant snapshots are one API response', () => {
  const tracker = new AgentUsageTracker()
  tracker.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'a', usage: { input_tokens: 0, output_tokens: 0 } } } })
  tracker.observe(assistant('a', { input_tokens: 0, output_tokens: 0 }))
  tracker.observe({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 15 } } })
  expect(tracker.totalTokens()).toBe(215)
})

test('serialized nonzero assistant snapshots cannot overwrite a newer final SSE delta', () => {
  const tracker = new AgentUsageTracker()
  tracker.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'a', usage: { input_tokens: 100, output_tokens: 1 } } } })
  tracker.observe(assistant('a', { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 1 }))
  tracker.observe({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 200, cache_read_input_tokens: 30, output_tokens: 25 } } })
  expect(tracker.totalTokens()).toBe(255)
})

test('nested child responses cannot change parent progress', () => {
  const tracker = new AgentUsageTracker()
  tracker.observe(assistant('a', { input_tokens: 100, output_tokens: 15 }))
  tracker.observe(assistant('nested', { input_tokens: 900000, output_tokens: 999 }, { parent_tool_use_id: 'child' }))
  expect(tracker.totalTokens()).toBe(115)
})

test('late snapshots of earlier calls do not replace newest context', () => {
  const tracker = new AgentUsageTracker()
  tracker.observe(assistant('a', { input_tokens: 100, output_tokens: 10 }))
  tracker.observe(assistant('b', { input_tokens: 200, output_tokens: 20 }))
  tracker.observe(assistant('a', { input_tokens: 100, output_tokens: 15 }))
  expect(tracker.totalTokens()).toBe(235)
})

test('invalid or absent fields cannot produce negative or NaN totals', () => {
  const tracker = new AgentUsageTracker()
  tracker.observe(assistant('a', { input_tokens: -1, output_tokens: NaN, cache_read_input_tokens: Infinity }))
  expect(tracker.totalTokens()).toBe(0)
  tracker.observe({ type: 'assistant', message: { id: 'b' } })
  expect(tracker.totalTokens()).toBe(0)
})

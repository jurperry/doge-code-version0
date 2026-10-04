import { expect, test } from 'bun:test'
import { StepTranscriptRelay, StepTranscriptChain } from './stepTranscript.js'
import { createUserMessage } from '../../utils/messages.js'

test('nested task IDs and transcripts stay isolated from the root and other runs', () => {
  const relay = new StepTranscriptRelay('root1', 'wf')
  const start = { type: 'system', subtype: 'task_started', task_id: 'child', agent_id: 'actual', tool_use_id: 'tool', task_type: 'local_agent', description: 'nested' }
  expect(relay.consume(start).event).toMatchObject({ task_id: 'root1-child', agent_id: 'root1-actual', workflow_name: 'wf' })
  expect(new StepTranscriptRelay('root2', 'wf').consume(start).event).toMatchObject({ task_id: 'root2-child' })
  const wire = { type: 'user', parent_tool_use_id: 'tool', message: { content: 'nested result' } }
  expect(relay.consume(wire).record?.agentId).toBe('root1-actual')
  const message = createUserMessage({ content: 'async tool result' })
  const event = { type: 'system', subtype: 'agent_transcript', agent_id: 'actual', message }
  expect(relay.consume(event).record?.message).toEqual(message)
  expect(relay.consume(event)).toEqual({})
  expect(relay.consume({ type: 'user', message: { content: 'root' } }).record?.agentId).toBe('root1')
})
test('unfinished child rows close on process termination and late progress cannot reopen them', () => {
  const relay = new StepTranscriptRelay('root', 'wf')
  relay.consume({ type: 'system', subtype: 'task_started', task_id: 'child' })
  expect(relay.finish('stopped')).toMatchObject([{ task_id: 'root-child', status: 'stopped' }])
  relay.consume({ type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed' })
  expect(relay.consume({ type: 'system', subtype: 'task_progress', task_id: 'child' })).toEqual({})
  expect(relay.finish('completed')).toEqual([])
})
test('retry discards accept wire UUIDs and legacy API IDs', () => {
  const relay = new StepTranscriptRelay('root', 'wf')
  relay.consume({ type: 'assistant', uuid: 'failed-uuid', message: { id: 'api-message', content: [{ type: 'text', text: 'partial' }] } })
  for (const id of ['failed-uuid', 'api-message']) {
    expect(relay.consume({ type: 'system', subtype: 'api_retry', discard_message_ids: [id] }).discard).toEqual([{ agentId: 'root', uuid: 'failed-uuid' }])
  }
  expect(relay.consume({ type: 'system', subtype: 'agent_transcript', agent_id: 'child', message: { type: 'tombstone', uuid: 'marker-uuid', message: { uuid: 'victim-uuid' } } }).discard).toEqual([{ agentId: 'root-child', uuid: 'victim-uuid' }])
})

test('discarded attempts cannot remain the parent of an accepted reply', () => {
  const chain = new StepTranscriptChain()
  const initial = createUserMessage({ content: 'initial' })
  const partial = createUserMessage({ content: 'partial' })
  const accepted = createUserMessage({ content: 'accepted' })
  chain.append('root', initial.uuid)
  chain.append('root', partial.uuid)
  chain.append('child', partial.uuid)
  chain.discard('root', partial.uuid)
  expect(chain.parent('root')).toBe(initial.uuid)
  expect(chain.parent('child')).toBe(partial.uuid)
  chain.append('root', accepted.uuid)
  chain.discard('root', initial.uuid)
  expect(chain.parent('root')).toBe(accepted.uuid)
})

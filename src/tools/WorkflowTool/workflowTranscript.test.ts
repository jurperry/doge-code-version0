import { expect, mock, test } from 'bun:test'
import type { Message } from '../../types/message.js'

const writes: Message[][] = []
mock.module('../../utils/sessionStorage.js', () => ({
  recordTranscript: async (messages: Message[]) => { writes.push(messages) },
}))
const { appendWorkflowTranscript } = await import('./workflowTranscript.js')
const user = (uuid: string) => ({ type: 'user', uuid, message: { role: 'user', content: uuid } }) as Message

test('workflow feedback uses current shared history, including intervening conversations', async () => {
  writes.length = 0
  let current = [user('workflow-request')]
  const context = { setMessages: (update: (previous: Message[]) => Message[]) => { current = update(current) } }
  // A detached workflow must not use its original captured context.messages.
  current = [...current, user('ordinary-user'), user('ordinary-reply')]
  await appendWorkflowTranscript(context, user('feedback'))
  expect(writes[0]?.map(message => message.uuid)).toEqual(['workflow-request', 'ordinary-user', 'ordinary-reply', 'feedback'])
  expect(current).toEqual(writes[0])
})

test('two workflows append to one current transcript without separate parent chains', async () => {
  writes.length = 0
  let current = [user('first-request'), user('second-request')]
  const context = { setMessages: (update: (previous: Message[]) => Message[]) => { current = update(current) } }
  await appendWorkflowTranscript(context, user('second-feedback'))
  await appendWorkflowTranscript(context, user('first-feedback'))
  expect(writes[1]?.map(message => message.uuid)).toEqual(['first-request', 'second-request', 'second-feedback', 'first-feedback'])
})

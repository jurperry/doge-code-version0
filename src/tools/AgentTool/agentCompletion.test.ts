import { expect, test } from 'bun:test'
import { agentCompletionStatus, agentRequestError } from './agentCompletion.js'
import { createAssistantMessage } from '../../utils/messages.js'

test('API errors fail both synchronous and asynchronous agents', () => {
  const failed = { ...createAssistantMessage({ content: '401 authentication failed' }), isApiErrorMessage: true }
  expect(agentRequestError([failed])?.message).toContain('401')
  expect(agentCompletionStatus([failed])).toBe('failed')
  expect(agentCompletionStatus([], new Error('tool failed'))).toBe('failed')
  expect(agentCompletionStatus([], undefined, true)).toBe('stopped')
})

test('recovered errors do not override the final successful reply', () => {
  const failed = { ...createAssistantMessage({ content: 'partial error' }), isApiErrorMessage: true }
  const accepted = createAssistantMessage({ content: 'done' })
  expect(agentRequestError([failed, accepted])).toBeUndefined()
  expect(agentCompletionStatus([failed, accepted])).toBe('completed')
})

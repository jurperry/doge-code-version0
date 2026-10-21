import { test, expect, mock } from 'bun:test'

const events: any[] = []
mock.module('../src/utils/sdkEventQueue.js', () => ({ enqueueSdkEvent: (event: unknown) => events.push(event) }))
mock.module('../src/services/api/withRetry.js', () => ({ retryErrorClass: () => 'network', retryErrorKind: () => 'connection' }))
const { emitTaskProgress } = await import('../src/utils/task/sdkProgress.js')

test('teammate progress identifies the actual transcript on each iteration', () => {
  for (const agentId of ['round-one', 'round-two']) {
    emitTaskProgress({ taskId: 'same-teammate', agentId, toolUseId: undefined, description: 'reader', startTime: Date.now(), totalTokens: 0, toolUses: 0, isIdle: false })
  }
  expect(events.map(event => event.agent_id)).toEqual(['round-one', 'round-two'])
  expect(events.map(event => event.task_id)).toEqual(['same-teammate', 'same-teammate'])
})

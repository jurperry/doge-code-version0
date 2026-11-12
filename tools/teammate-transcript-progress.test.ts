import { test, expect } from 'bun:test'

const { setSdkEventTap } = await import('../src/utils/sdkEventQueue.js')
const { getIsInteractive, setIsInteractive } = await import('../src/bootstrap/state.js')
const { emitTaskProgress } = await import('../src/utils/task/sdkProgress.js')

test('teammate progress identifies the actual transcript on each iteration', () => {
  const events: any[] = []
  const wasInteractive = getIsInteractive()
  setIsInteractive(true)
  setSdkEventTap(event => events.push(event))
  try {
    for (const agentId of ['round-one', 'round-two']) {
      emitTaskProgress({ taskId: 'same-teammate', agentId, toolUseId: undefined, description: 'reader', startTime: Date.now(), totalTokens: 0, toolUses: 0, isIdle: false })
    }
    expect(events.map(event => event.agent_id)).toEqual(['round-one', 'round-two'])
    expect(events.map(event => event.task_id)).toEqual(['same-teammate', 'same-teammate'])
  } finally {
    setSdkEventTap(undefined)
    setIsInteractive(wasInteractive)
  }
})

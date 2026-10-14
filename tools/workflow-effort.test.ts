import { test, expect } from 'bun:test'
import { resolveAppliedEffort } from '../src/utils/effort.js'
import { withScopedEffort } from '../src/utils/effortContext.js'

test('workflow effort does not leak session env or app state across interleaved requests', async () => {
  const previous = process.env.CLAUDE_CODE_EFFORT_LEVEL
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
  async function* step() {
    await Bun.sleep(5)
    yield resolveAppliedEffort('custom-model', 'high')
    yield resolveAppliedEffort('custom-model', 'high')
  }
  try {
    const workflow = withScopedEffort(step(), undefined)
    const first = workflow.next()
    expect(resolveAppliedEffort('custom-model', undefined)).toBe('high')
    expect((await first).value).toBeUndefined()
    expect((await workflow.next()).value).toBeUndefined()
    expect(resolveAppliedEffort('custom-model', undefined)).toBe('high')
    await workflow.return()
    const explicit = withScopedEffort(step(), 'low')
    expect((await explicit.next()).value).toBe('low')
    await explicit.return()
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = previous
  }
})

import { expect, test } from 'bun:test'

import { cleanupComputerUseAfterTurn } from './cleanup.js'

function contextWithStash(value: string) {
  let state: any = { computerUseMcpState: { clipboardStash: value } }
  return {
    ctx: {
      getAppState: () => state,
      setAppState: (update: (prev: any) => any) => { state = update(state) },
    },
    state: () => state,
  }
}

test('turn cleanup restores the clipboard and clears stash only after success', async () => {
  const { ctx, state } = contextWithStash('original')
  let restored = ''
  await cleanupComputerUseAfterTurn(ctx as any, async text => { restored = text })
  expect(restored).toBe('original')
  expect(state().computerUseMcpState.clipboardStash).toBeUndefined()
})

test('failed clipboard restoration preserves stash for the next turn', async () => {
  const { ctx, state } = contextWithStash('keep-me')
  await cleanupComputerUseAfterTurn(ctx as any, async () => { throw new Error('write failed') })
  expect(state().computerUseMcpState.clipboardStash).toBe('keep-me')
})

test('restore timeout is not treated as a successful restore', async () => {
  const { ctx, state } = contextWithStash('still-needed')
  await cleanupComputerUseAfterTurn(ctx as any, () => new Promise(() => {}), 5)
  expect(state().computerUseMcpState.clipboardStash).toBe('still-needed')
})

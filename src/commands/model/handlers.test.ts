import { test, expect, mock } from 'bun:test'
import { decideAndSwitch, type DecideContext, type ModelInput } from './handlers.js'
import type { ModelProfile } from '../../utils/customApiStorage.js'

function makeCtx(profile?: ModelProfile): DecideContext {
  return {
    findProfile: (model: ModelInput) => (profile && model === profile.model ? profile : null),
    switchModelProfileAtomicBound: mock(async () => {}),
    switchTierBound: mock(() => {}),
    syncModelConfigToDisk: mock(() => {}),
    setAppState: mock(() => {}),
  }
}

test('input = matching profile name → switchModelProfileAtomicBound called with right deps', async () => {
  const profile: ModelProfile = { model: 'deepseek-chat' }
  const ctx = makeCtx(profile)
  await decideAndSwitch('deepseek-chat', ctx)
  expect(ctx.switchModelProfileAtomicBound).toHaveBeenCalledTimes(1)
  // Called with (profile, deps object containing syncToDisk + setAppState)
  expect(ctx.switchModelProfileAtomicBound).toHaveBeenCalledWith(profile, expect.objectContaining({
    syncToDisk: ctx.syncModelConfigToDisk,
    setAppState: ctx.setAppState,
  }))
  expect(ctx.switchTierBound).not.toHaveBeenCalled()
})

test('input = "haiku" alias → switchTierBound("haiku", deps) called', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('haiku', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledTimes(1)
  expect(ctx.switchTierBound).toHaveBeenCalledWith('haiku', expect.objectContaining({
    syncToDisk: ctx.syncModelConfigToDisk,
    setAppState: ctx.setAppState,
  }))
  expect(ctx.switchModelProfileAtomicBound).not.toHaveBeenCalled()
})

test('input = "opus" alias → switchTierBound("opus")', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('opus', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith('opus', expect.anything())
})

test('input = "sonnet" alias → switchTierBound("sonnet")', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('sonnet', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith('sonnet', expect.anything())
})

test('input = "default" → switchTierBound(null)', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('default', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith(null, expect.anything())
})

test('input = null → switchTierBound(null)', async () => {
  const ctx = makeCtx()
  await decideAndSwitch(null, ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith(null, expect.anything())
})

test('input = bare unknown model (no matching profile, not an alias) → setAppState + syncToDisk only', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('gpt-4o', ctx)
  expect(ctx.switchModelProfileAtomicBound).not.toHaveBeenCalled()
  expect(ctx.switchTierBound).not.toHaveBeenCalled()
  expect(ctx.setAppState).toHaveBeenCalledTimes(1)
  expect(ctx.syncModelConfigToDisk).toHaveBeenCalledWith('gpt-4o', false)
})

test('bare unknown model setAppState callback builds correct next state', async () => {
  const ctx = makeCtx()
  let captured: any = null
  ctx.setAppState = (updater) => { captured = updater({ mainLoopModel: 'old', mainLoopModelForSession: 'x' }) }
  await decideAndSwitch('gpt-4o', ctx)
  expect(captured.mainLoopModel).toBe('gpt-4o')
  expect(captured.mainLoopModelForSession).toBeNull()
})
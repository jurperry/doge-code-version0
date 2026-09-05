import { test, expect, mock } from 'bun:test'
import { decideAndSwitch, type DecideContext, type ModelInput } from './handlers.js'
import type { ModelProfile } from '../../utils/customApiStorage.js'

function makeCtx(profile?: ModelProfile, scope?: DecideContext['scope']): DecideContext {
  return {
    findProfile: (model: ModelInput) => (profile && model === profile.model ? profile : null),
    switchModelProfileAtomicBound: mock(async () => {}),
    switchTierBound: mock(() => {}),
    syncModelConfigToDisk: mock(() => {}),
    setAppState: mock(() => {}),
    scope,
  }
}

// ── Global scope (legacy persist-to-disk behavior, /model --save) ──

test('global scope: input = matching profile name → switchModelProfileAtomicBound called with right deps', async () => {
  const profile: ModelProfile = { model: 'deepseek-chat' }
  const ctx = makeCtx(profile, 'global')
  await decideAndSwitch('deepseek-chat', ctx)
  expect(ctx.switchModelProfileAtomicBound).toHaveBeenCalledTimes(1)
  // Called with (profile, deps object containing syncToDisk + setAppState)
  expect(ctx.switchModelProfileAtomicBound).toHaveBeenCalledWith(profile, expect.objectContaining({
    syncToDisk: ctx.syncModelConfigToDisk,
    setAppState: ctx.setAppState,
    sessionScoped: false,
  }))
  expect(ctx.switchTierBound).not.toHaveBeenCalled()
})

test('global scope: input = "haiku" alias → switchTierBound("haiku", deps) called', async () => {
  const ctx = makeCtx(undefined, 'global')
  await decideAndSwitch('haiku', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledTimes(1)
  expect(ctx.switchTierBound).toHaveBeenCalledWith('haiku', expect.objectContaining({
    syncToDisk: ctx.syncModelConfigToDisk,
    setAppState: ctx.setAppState,
    sessionScoped: false,
  }))
  expect(ctx.switchModelProfileAtomicBound).not.toHaveBeenCalled()
})

test('global scope: input = "opus" alias → switchTierBound("opus")', async () => {
  const ctx = makeCtx(undefined, 'global')
  await decideAndSwitch('opus', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith('opus', expect.anything())
})

test('global scope: input = "sonnet" alias → switchTierBound("sonnet")', async () => {
  const ctx = makeCtx(undefined, 'global')
  await decideAndSwitch('sonnet', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith('sonnet', expect.anything())
})

test('global scope: input = "default" → switchTierBound(null)', async () => {
  const ctx = makeCtx(undefined, 'global')
  await decideAndSwitch('default', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith(null, expect.anything())
})

test('global scope: input = null → switchTierBound(null)', async () => {
  const ctx = makeCtx(undefined, 'global')
  await decideAndSwitch(null, ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith(null, expect.anything())
})

test('global scope: input = bare unknown model (no matching profile, not an alias) → setAppState + syncToDisk only', async () => {
  const ctx = makeCtx(undefined, 'global')
  await decideAndSwitch('gpt-4o', ctx)
  expect(ctx.switchModelProfileAtomicBound).not.toHaveBeenCalled()
  expect(ctx.switchTierBound).not.toHaveBeenCalled()
  expect(ctx.setAppState).toHaveBeenCalledTimes(1)
  expect(ctx.syncModelConfigToDisk).toHaveBeenCalledWith('gpt-4o', false)
})

test('global scope: bare unknown model setAppState callback builds correct next state', async () => {
  const ctx = makeCtx(undefined, 'global')
  let captured: any = null
  ctx.setAppState = (updater) => { captured = updater({ mainLoopModel: 'old', mainLoopModelForSession: 'x' }) }
  await decideAndSwitch('gpt-4o', ctx)
  expect(captured.mainLoopModel).toBe('gpt-4o')
  expect(captured.mainLoopModelForSession).toBeNull()
})

// ── Session scope (default; multi-terminal isolation, no disk writes) ──

test('session scope (default): profile switch gets no-op syncToDisk + sessionScoped flag', async () => {
  const profile: ModelProfile = { model: 'kimi-k3' }
  const ctx = makeCtx(profile)
  await decideAndSwitch('kimi-k3', ctx)
  expect(ctx.switchModelProfileAtomicBound).toHaveBeenCalledTimes(1)
  expect(ctx.switchModelProfileAtomicBound).toHaveBeenCalledWith(profile, expect.objectContaining({
    sessionScoped: true,
    setAppState: ctx.setAppState,
  }))
  const deps = (ctx.switchModelProfileAtomicBound as any).mock.calls[0][1]
  expect(deps.syncToDisk).not.toBe(ctx.syncModelConfigToDisk)
  expect(ctx.syncModelConfigToDisk).not.toHaveBeenCalled()
})

test('session scope (default): explicit scope="session" behaves identically', async () => {
  const profile: ModelProfile = { model: 'kimi-k3' }
  const ctx = makeCtx(profile, 'session')
  await decideAndSwitch('kimi-k3', ctx)
  expect(ctx.switchModelProfileAtomicBound).toHaveBeenCalledWith(profile, expect.objectContaining({
    sessionScoped: true,
  }))
})

test('session scope (default): tier alias never touches syncToDisk', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('haiku', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledTimes(1)
  const deps = (ctx.switchTierBound as any).mock.calls[0][1]
  expect(deps.sessionScoped).toBe(true)
  expect(deps.syncToDisk).not.toBe(ctx.syncModelConfigToDisk)
  expect(ctx.syncModelConfigToDisk).not.toHaveBeenCalled()
})

test('session scope (default): bare unknown model → session override only, no disk write', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('gpt-4o', ctx)
  expect(ctx.syncModelConfigToDisk).not.toHaveBeenCalled()
  expect(ctx.setAppState).toHaveBeenCalledTimes(1)
})

test('session scope (default): bare unknown model setAppState writes mainLoopModelForSession only', async () => {
  const ctx = makeCtx()
  let captured: any = null
  ctx.setAppState = (updater) => { captured = updater({ mainLoopModel: 'baseline', mainLoopModelForSession: null }) }
  await decideAndSwitch('gpt-4o', ctx)
  expect(captured.mainLoopModel).toBe('baseline')
  expect(captured.mainLoopModelForSession).toBe('gpt-4o')
})

test('session scope (default): "default" → switchTierBound(null) with sessionScoped', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('default', ctx)
  const deps = (ctx.switchTierBound as any).mock.calls[0][1]
  expect(deps.sessionScoped).toBe(true)
})

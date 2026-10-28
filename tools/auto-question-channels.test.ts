import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sandbox = join(import.meta.dir, '..', 'test', 'auto-question-channels')
mkdirSync(sandbox, { recursive: true })
const originalConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = sandbox
writeFileSync(join(sandbox, 'settings.json'), '{}')
const { resetSettingsCache } = await import('../src/utils/settings/settingsCache.js')
resetSettingsCache()
const { StructuredIO } = await import('../src/cli/structuredIO.js')
const { getCanUseToolFn, createCanUseToolWithPermissionPrompt } = await import('../src/cli/print.js')
const { AskUserQuestionTool } = await import('../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')
const { SDKControlPermissionRequestSchema } = await import('../src/entrypoints/sdk/controlSchemas.js')
const { handleInteractivePermission } = await import('../src/hooks/toolPermission/handlers/interactiveHandler.js')
const { createInProcessCanUseTool } = await import('../src/utils/swarm/inProcessRunner.js')
const leaderBridge = await import('../src/utils/swarm/leaderPermissionBridge.js')
const { setCurrentPermissionMode } = await import('../src/utils/permissions/currentPermissionMode.js')
const input = { questions: [{ question: 'Choice?', header: 'Choice', multiSelect: false, options: [{ label: 'First', description: 'A' }, { label: 'Second (推荐)', description: 'B' }] }], answers: { 'Choice?': 'model draft' } }
const context = (mode = 'plan'): any => ({ abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: { mode, ...(mode === 'plan' ? { prePlanMode: 'bypassPermissions', autoPlan: true } : {}), alwaysDenyRules: {}, alwaysAllowRules: {}, alwaysAskRules: {} } }), options: {} })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const io = () => new StructuredIO((async function* () {})())
afterAll(() => {
  setCurrentPermissionMode('default')
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  resetSettingsCache(); rmSync(sandbox, { recursive: true, force: true })
})

test('real stdio request exposes deadline snapshot and human answer wins', async () => {
  const stream = io(); const ctx = context(); const start = Date.now()
  const pending = stream.createCanUseTool()(AskUserQuestionTool, input, ctx, {} as any, 'question')
  for (let i = 0; i < 100 && !stream.getPendingPermissionRequests().length; i++) await sleep(5)
  const request = stream.getPendingPermissionRequests()[0]!
  const parsed = SDKControlPermissionRequestSchema().parse(request.request)
  expect(parsed.auto_question!.deadline_ms - start).toBeGreaterThanOrEqual(300000)
  expect(parsed.auto_question!.deadline_ms - Date.now()).toBeLessThanOrEqual(300000)
  expect((parsed.input as any).answers).toBeUndefined()
  const answer = { ...parsed.input, answers: { 'Choice?': 'First' } }
  stream.injectControlResponse({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { behavior: 'allow', updatedInput: answer } } } as any)
  expect((await pending as any).updatedInput.answers).toEqual(answer.answers)
  expect(ctx.abortController.signal.aborted).toBe(false)
  expect(stream.getPendingPermissionRequests()).toHaveLength(0)
})
test('non-Auto stdio question has no deadline and abort clears request', async () => {
  const stream = io(); const ctx = context('default')
  const result = stream.createCanUseTool()(AskUserQuestionTool, input, ctx, {} as any, 'question')
  for (let i = 0; i < 100 && !stream.getPendingPermissionRequests().length; i++) await sleep(5)
  expect((stream.getPendingPermissionRequests()[0]!.request as any).auto_question).toBeUndefined()
  ctx.abortController.abort()
  expect((await result).behavior).toBe('deny')
  expect(stream.getPendingPermissionRequests()).toHaveLength(0)
})
test('no-host automatic Plan waits rather than immediately adopting a model draft', async () => {
  const ctx = context(); let finished = false
  const result = getCanUseToolFn(undefined, io(), () => [])(AskUserQuestionTool, input, ctx, {} as any, 'question').then(r => { finished = true; return r })
  await sleep(30); expect(finished).toBe(false)
  ctx.abortController.abort(); expect((await result).behavior).toBe('deny')
})
test('MCP permission prompt gets deadline and abort affects only the child request', async () => {
  const ctx = context(); let args: any; let requestContext: any
  const prompt = { name: 'mcp__test__prompt', call(data: any, request: any) { args = data; requestContext = request; return new Promise(() => {}) } } as any
  const result = createCanUseToolWithPermissionPrompt(prompt)(AskUserQuestionTool, input, ctx, {} as any, 'question')
  for (let i = 0; i < 100 && !args; i++) await sleep(5)
  expect(args.auto_question.deadline_ms - Date.now()).toBeGreaterThan(299000)
  expect(args.input.answers).toBeUndefined()
  expect(requestContext.abortController).not.toBe(ctx.abortController)
  ctx.abortController.abort()
  expect((await result).behavior).toBe('deny')
  expect(requestContext.abortController.signal.aborted).toBe(true)
})
test('queued TUI question receives the full deadline only when it becomes interactive', async () => {
  let item: any
  const ctx: any = {
    tool: AskUserQuestionTool, input, toolUseID: 'queued', assistantMessage: {}, toolUseContext: context(),
    pushToQueue(value: any) { item = value }, updateQueueItem(patch: any) { Object.assign(item, patch) }, removeFromQueue() {},
    logCancelled() {}, logDecision() {}, cancelAndAbort() { return { behavior: 'deny', message: 'cancelled' } }, runHooks: async () => null,
  }
  handleInteractivePermission({ ctx, description: 'Questions', result: { behavior: 'ask', updatedInput: input }, awaitAutomatedChecksBeforeDialog: true }, () => {})
  try {
    expect(item.autoQuestionDeadlineMs).toBeUndefined()
    const before = Date.now(); item.onBecomeActive()
    const deadline = item.autoQuestionDeadlineMs
    expect(deadline - before).toBeGreaterThanOrEqual(300000)
    await sleep(20); item.onBecomeActive()
    expect(item.autoQuestionDeadlineMs).toBe(deadline)
  } finally { item.onReject() }
})
test('independent stdio Ask calls serialize their interaction windows', async () => {
  const stream = io(); const canUse = stream.createCanUseTool(); const first = context(); const second = context()
  const one = canUse(AskUserQuestionTool, input, first, {} as any, 'one')
  const two = canUse(AskUserQuestionTool, input, second, {} as any, 'two')
  try {
    await sleep(25)
    expect(stream.getPendingPermissionRequests()).toHaveLength(1)
    const request = stream.getPendingPermissionRequests()[0]!
    expect(request.request.tool_use_id).toBe('one')
    stream.injectControlResponse({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Choice?': 'First' } } } } } as any)
    await one; await sleep(15)
    expect(stream.getPendingPermissionRequests()).toHaveLength(1)
    const next = stream.getPendingPermissionRequests()[0]!
    expect(next.request.tool_use_id).toBe('two')
    expect((next.request as any).auto_question.deadline_ms - Date.now()).toBeGreaterThan(299000)
  } finally { first.abortController.abort(); second.abortController.abort(); await Promise.all([one, two]) }
})

test('parent abort settles active and queued TUI questions and rejects late racers', async () => {
  const parent = context(); const queue: any[] = []; const results: any[] = []; const cancelled: string[] = []
  const responses: ((response: any) => void)[] = []; let persistence = 0; let hookClaim: (() => boolean) | undefined
  const relay: any = {
    sendRequest() {}, cancelRequest(id: string) { cancelled.push(id) },
    onResponse(_id: string, callback: any) { responses.push(callback); return () => {} },
  }
  for (const id of ['active', 'queued']) {
    const ctx: any = {
      tool: AskUserQuestionTool, input, toolUseID: id, assistantMessage: {}, toolUseContext: parent,
      pushToQueue(value: any) { queue.push(value) }, updateQueueItem(patch: any) { Object.assign(queue.find(q => q.toolUseID === id), patch) },
      removeFromQueue() { const index = queue.findIndex(q => q.toolUseID === id); if (index >= 0) queue.splice(index, 1) },
      logCancelled() {}, logDecision() {}, cancelAndAbort() { parent.abortController.abort(); return { behavior: 'deny', message: 'cancelled' } },
      persistPermissions() { persistence++ }, buildAllow(value: any) { return { behavior: 'allow', updatedInput: value } },
      runHooks(_mode: any, _suggestions: any, _input: any, _start: any, claim: () => boolean) { hookClaim = claim; return new Promise(() => {}) },
    }
    handleInteractivePermission({ ctx, description: id, result: { behavior: 'ask', updatedInput: input }, awaitAutomatedChecksBeforeDialog: false, imRemoteCallbacks: relay }, result => results.push(result))
  }
  queue[0].onBecomeActive()
  parent.abortController.abort()
  expect(results).toHaveLength(2)
  expect(results.every(result => result.behavior === 'deny')).toBe(true)
  expect(queue).toHaveLength(0)
  expect(cancelled).toHaveLength(2)
  expect(hookClaim!()).toBe(false)
  for (const callback of responses) callback({ behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'addRules' }] })
  expect(results).toHaveLength(2)
  expect(persistence).toBe(0)
})

test('in-process teammate automatic Plan Ask shares the headless leader interaction channel', async () => {
  const stream = io(); const host = stream.createCanUseTool(); const ctx = context()
  ctx.options = { tools: [], isNonInteractiveSession: true }
  const worker = createInProcessCanUseTool({ agentId: 'worker-id', agentName: 'worker', teamName: 'test-team' } as any, ctx.abortController)
  const register = (leaderBridge as any).registerLeaderQuestionHost
  if (register) register(host)
  const result = worker(AskUserQuestionTool, input, ctx, {} as any, 'worker-question')
  try {
    await sleep(40)
    expect(stream.getPendingPermissionRequests()).toHaveLength(1)
    const request = stream.getPendingPermissionRequests()[0]!
    expect((request.request as any).auto_question.deadline_ms - Date.now()).toBeGreaterThan(299000)
    expect((request.request.input as any).answers).toBeUndefined()
    stream.injectControlResponse({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { behavior: 'allow', updatedInput: { ...request.request.input, answers: { 'Choice?': 'First' } } } } } as any)
    expect((await result as any).updatedInput.answers).toEqual({ 'Choice?': 'First' })
  } finally { ctx.abortController.abort(); await result; (leaderBridge as any).unregisterLeaderQuestionHost?.() }
})

test('in-process TUI teammate uses the real permission context and cannot bypass explicit deny', async () => {
  const ctx = context(); ctx.options = { tools: [] }
  let queue: any[] = []
  leaderBridge.registerLeaderToolUseConfirmQueue(update => { queue = update(queue) })
  const worker = createInProcessCanUseTool({ agentId: 'worker-id', agentName: 'worker', teamName: 'test-team', color: 'blue' } as any, ctx.abortController)
  const result = worker(AskUserQuestionTool, input, ctx, { message: { id: 'message' } } as any, 'worker-tui')
  try {
    await sleep(30)
    expect(queue).toHaveLength(1)
    expect(queue[0].input.answers).toBeUndefined()
    expect(queue[0].autoQuestionDeadlineMs).toBeUndefined()
    queue[0].onBecomeActive()
    expect(queue[0].autoQuestionDeadlineMs - Date.now()).toBeGreaterThan(299000)
    expect(queue[0].workerBadge).toEqual({ name: 'worker', color: 'blue' })
    ctx.abortController.abort()
    expect((await result).behavior).not.toBe('allow')
    expect(queue).toHaveLength(0)
    const denied = context(); denied.getAppState = () => ({ toolPermissionContext: { mode: 'plan', prePlanMode: 'bypassPermissions', autoPlan: true, alwaysDenyRules: { userSettings: ['AskUserQuestion'] }, alwaysAllowRules: {}, alwaysAskRules: {} } })
    const denyWorker = createInProcessCanUseTool({ agentId: 'worker-id', agentName: 'worker', teamName: 'test-team' } as any, denied.abortController)
    expect((await denyWorker(AskUserQuestionTool, input, denied, {} as any, 'denied')).behavior).toBe('deny')
    expect(queue).toHaveLength(0)
  } finally { ctx.abortController.abort(); await result; leaderBridge.unregisterLeaderToolUseConfirmQueue() }
})

test('Auto execution cannot reach stdio, no-host, MCP or teammate question hosts', async () => {
  const stream = io()
  let prompted = 0
  const prompt = { name: 'mcp__test__prompt', call() { prompted++; throw new Error('Auto must not prompt') } } as any
  const ctx = context('bypassPermissions')
  ctx.options = { tools: [], isNonInteractiveSession: true }
  leaderBridge.registerLeaderQuestionHost(async () => { prompted++; throw new Error('Auto must not ask its leader') })
  const worker = createInProcessCanUseTool({ agentId: 'worker-id', agentName: 'worker', teamName: 'test-team' } as any, ctx.abortController)
  try {
    for (const channel of [stream.createCanUseTool(), getCanUseToolFn(undefined, io(), () => []), createCanUseToolWithPermissionPrompt(prompt), worker]) {
      const result = await channel(AskUserQuestionTool, input, ctx, {} as any, 'auto-execution')
      expect(result.behavior).toBe('deny')
    }
    expect(prompted).toBe(0)
    expect(stream.getPendingPermissionRequests()).toHaveLength(0)
  } finally { leaderBridge.unregisterLeaderQuestionHost() }
})

test('queued teammate question rechecks Plan to Auto before reaching the stdio host', async () => {
  let mode = 'plan'
  const ctx = context()
  ctx.options = { tools: [], isNonInteractiveSession: true }
  ctx.getAppState = () => ({ toolPermissionContext: { mode, ...(mode === 'plan' ? { prePlanMode: 'bypassPermissions', autoPlan: true } : {}), alwaysDenyRules: {}, alwaysAllowRules: {}, alwaysAskRules: {} } })
  const stream = io(), host = stream.createCanUseTool()
  leaderBridge.registerLeaderQuestionHost(host)
  const worker = createInProcessCanUseTool({ agentId: 'worker', agentName: 'worker', teamName: 'test' } as any, ctx.abortController)
  const one = host(AskUserQuestionTool, input, ctx, {} as any, 'first')
  await sleep(25)
  const two = worker(AskUserQuestionTool, input, ctx, {} as any, 'queued-worker')
  try {
    await sleep(25)
    expect(stream.getPendingPermissionRequests()).toHaveLength(1)
    mode = 'bypassPermissions'
    const first = stream.getPendingPermissionRequests()[0]!
    stream.injectControlResponse({ type: 'control_response', response: { subtype: 'success', request_id: first.request_id, response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Choice?': 'First' } } } } } as any)
    await one; await sleep(25)
    expect(stream.getPendingPermissionRequests()).toHaveLength(0)
    expect((await two).behavior).toBe('deny')
  } finally { ctx.abortController.abort(); await Promise.all([one, two]); leaderBridge.unregisterLeaderQuestionHost() }
})

test('queued TUI question is refused on activation or mode recheck after switching to Auto', async () => {
  for (const activate of [true, false]) {
    const parent = context()
    let item: any, mode = 'plan', decision: any, removed = false
    parent.getAppState = () => ({ toolPermissionContext: { mode, prePlanMode: 'bypassPermissions', autoPlan: true, alwaysDenyRules: {}, alwaysAllowRules: {}, alwaysAskRules: {} } })
    const ctx: any = { tool: AskUserQuestionTool, input, toolUseID: 'queued', assistantMessage: {}, toolUseContext: parent,
      pushToQueue(value: any) { item = value }, updateQueueItem(patch: any) { Object.assign(item, patch) }, removeFromQueue() { removed = true },
      logCancelled() {}, logDecision() {}, cancelAndAbort() { return { behavior: 'deny', message: 'aborted' } }, runHooks: async () => null }
    handleInteractivePermission({ ctx, description: 'Question', result: { behavior: 'ask', updatedInput: input }, awaitAutomatedChecksBeforeDialog: true }, value => { decision = value })
    mode = 'bypassPermissions'
    try {
      if (activate) item.onBecomeActive()
      else await item.recheckPermission()
      expect(decision?.behavior).toBe('deny')
      expect(removed).toBe(true)
      expect(parent.abortController.signal.aborted).toBe(false)
    } finally { parent.abortController.abort() }
  }
})

test('switching active Plan to Auto dismisses stdio and MCP questions without aborting the model turn', async () => {
  for (const channel of ['stdio', 'mcp']) {
    let mode = 'plan', requestContext: any
    const ctx = context()
    ctx.getAppState = () => ({ toolPermissionContext: { mode, prePlanMode: 'bypassPermissions', autoPlan: true, alwaysDenyRules: {}, alwaysAllowRules: {}, alwaysAskRules: {} } })
    const stream = io()
    const prompt = { name: 'mcp__test__prompt', call(_input: any, request: any) { requestContext = request; return new Promise(() => {}) } } as any
    const canUse = channel === 'stdio' ? stream.createCanUseTool() : createCanUseToolWithPermissionPrompt(prompt)
    setCurrentPermissionMode('plan', true)
    const result = canUse(AskUserQuestionTool, input, ctx, {} as any, 'active')
    try {
      await sleep(25)
      expect(channel === 'stdio' ? stream.getPendingPermissionRequests().length : Number(!!requestContext)).toBe(1)
      mode = 'bypassPermissions'; setCurrentPermissionMode('bypassPermissions')
      await sleep(25)
      expect(stream.getPendingPermissionRequests()).toHaveLength(0)
      if (channel === 'mcp') expect(requestContext.abortController.signal.aborted).toBe(true)
      expect((await result).behavior).toBe('deny')
      expect(ctx.abortController.signal.aborted).toBe(false)
    } finally { ctx.abortController.abort(); await result; setCurrentPermissionMode('default') }
  }
})

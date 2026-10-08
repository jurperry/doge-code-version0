import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sandbox = join(import.meta.dir, 'auto-plan-sandbox')
mkdirSync(sandbox, { recursive: true })
const originalConfig = process.env.CLAUDE_CONFIG_DIR
const originalApiKey = process.env.DOGE_API_KEY
process.env.CLAUDE_CONFIG_DIR = sandbox
process.env.DOGE_API_KEY = 'sk-local-unit-test'

const { resetSettingsCache } = await import('../src/utils/settings/settingsCache.js')
const { isAutoBypassActive, isZeroAskPlanInterlude } = await import('../src/utils/permissions/autoBypass.js')
const { prepareContextForPlanMode, transitionPermissionMode } = await import('../src/utils/permissions/permissionSetup.js')
const { applyPermissionUpdate } = await import('../src/utils/permissions/PermissionUpdate.js')
const { AskUserQuestionTool } = await import('../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')
const { resolveHookPermissionDecision } = await import('../src/services/tools/toolHooks.js')
const { hasPermissionsToUseTool } = await import('../src/utils/permissions/permissions.js')
const { remoteAutoTargetMode } = await import('../src/utils/imRemote/autoMode.js')
const { z } = await import('zod/v4')
const { FileWriteTool } = await import('../src/tools/FileWriteTool/FileWriteTool.js')
const { getPlanFilePath } = await import('../src/utils/plans.js')
const { normalizeAttachmentForAPI } = await import('../src/utils/messages.js')
const { setCurrentPermissionMode } = await import('../src/utils/permissions/currentPermissionMode.js')

const automaticPlan = { mode: 'plan', prePlanMode: 'bypassPermissions', autoPlan: true, isBypassPermissionsModeAvailable: true }
const questions = { questions: [{ question: 'Choose an approach?', header: 'Design', options: [{ label: 'Recommended', description: 'A' }, { label: 'Alternative', description: 'B' }], multiSelect: false }] }
const ctx = (permission: any): any => ({
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: { alwaysDenyRules: {}, alwaysAskRules: {}, alwaysAllowRules: {}, ...permission } }),
})

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = sandbox
  writeFileSync(join(sandbox, 'settings.json'), '{}')
  resetSettingsCache()
})
afterAll(() => {
  setCurrentPermissionMode('default')
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  if (originalApiKey === undefined) delete process.env.DOGE_API_KEY
  else process.env.DOGE_API_KEY = originalApiKey
  resetSettingsCache()
  rmSync(sandbox, { recursive: true, force: true })
})

test('automatic plan reminders retain their origin after returning to Auto', () => {
  const attachment = { type: 'plan_mode', reminderType: 'full', planFilePath: 'test/plan.md', planExists: true } as const
  setCurrentPermissionMode('bypassPermissions')
  const automatic = JSON.stringify(normalizeAttachmentForAPI({ ...attachment, autoPlan: true } as any))
  expect(automatic).toContain('Auto planning is active')
  expect(automatic).not.toContain('feel free to ask the user questions')
  setCurrentPermissionMode('plan', true)
  expect(JSON.stringify(normalizeAttachmentForAPI(attachment))).toContain('feel free to ask the user questions')
  setCurrentPermissionMode('default')
})

test('model-initiated Auto planning is bounded even in flag-launched sessions', () => {
  expect(isZeroAskPlanInterlude(automaticPlan as any)).toBe(true)
  expect(isAutoBypassActive(automaticPlan as any)).toBe(false)
})
test('manual Plan retains interaction after Auto and in flag-launched sessions', () => {
  expect(isZeroAskPlanInterlude({ ...automaticPlan, autoPlan: undefined } as any)).toBe(false)
  expect(isAutoBypassActive({ ...automaticPlan, autoPlan: undefined } as any)).toBe(false)
})
test('plan entry distinguishes the model from a manual mode change', () => {
  const auto = { mode: 'bypassPermissions' } as any
  expect((prepareContextForPlanMode(auto, true) as any).autoPlan).toBe(true)
  expect((prepareContextForPlanMode(auto) as any).autoPlan).toBeUndefined()
})
test('leaving automatic planning clears its marker on every permission update', () => {
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
    expect((transitionPermissionMode('plan', mode, automaticPlan as any) as any).autoPlan).toBeUndefined()
    expect((applyPermissionUpdate(automaticPlan as any, { type: 'setMode', mode, destination: 'session' } as any) as any).autoPlan).toBeUndefined()
  }
})
test('automatic planning answers questions without an interactive request', async () => {
  const result = await AskUserQuestionTool.checkPermissions(questions, ctx(automaticPlan))
  expect(result.behavior).toBe('allow')
  expect((result as any).updatedInput.answers).toEqual({ 'Choose an approach?': 'Recommended' })
})
test('remote prompts preserve an automatic plan but can switch manual Plan to Auto', () => {
  expect(remoteAutoTargetMode(true, 'plan', false, true)).toBeNull()
  expect(remoteAutoTargetMode(true, 'plan', false, false)).toBe('bypassPermissions')
})
test('an ask hook cannot force a dialog in Auto', async () => {
  const tool = { name: 'Custom', inputSchema: z.object({}), async checkPermissions(input: any) { return { behavior: 'ask', updatedInput: input } } } as any
  const context = ctx({ mode: 'bypassPermissions' })
  const calls: any[] = []
  const result = await resolveHookPermissionDecision({ behavior: 'ask', message: 'hook asks' }, tool, {}, context,
    async (...args: any[]) => { calls.push(args[5]); return args[5] ?? hasPermissionsToUseTool(...args.slice(0, 5) as any) }, {} as any, 'hook-test')
  expect(result.decision.behavior).toBe('allow')
  expect(calls).toEqual([undefined])
})
test('a hook allow cannot bypass the automatic plan write boundary', async () => {
  const tool = { name: 'Write', inputSchema: z.object({}), async checkPermissions() { return { behavior: 'ask', message: 'write outside plan' } } } as any
  const result = await resolveHookPermissionDecision({ behavior: 'allow', updatedInput: {} }, tool, {}, ctx(automaticPlan), hasPermissionsToUseTool, {} as any, 'hook-plan')
  expect(result.decision.behavior).toBe('deny')
})

test('path allow rules cannot permit implementation writes during automatic Plan', async () => {
  const context = ctx({ ...automaticPlan, additionalWorkingDirectories: new Map(), alwaysAllowRules: { userSettings: ['Edit(./tools/auto-implementation/**)'] } })
  const input = { file_path: join(import.meta.dir, 'auto-implementation', 'implementation.ts'), content: 'changed' }
  expect((await FileWriteTool.checkPermissions(input, context)).behavior).toBe('allow')
  const result = await hasPermissionsToUseTool(FileWriteTool, input, context, {} as any, 'write-allow')
  expect(result.behavior).toBe('deny')
  const plan = await hasPermissionsToUseTool(FileWriteTool, { file_path: getPlanFilePath(), content: '# Plan' }, context, {} as any, 'write-plan')
  expect(plan.behavior).toBe('allow')
})

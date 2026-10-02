import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Sandbox the config dir BEFORE importing the permissions chain: the
// zero-ask killswitch (isBypassPermissionsModeDisabled) reads
// <CLAUDE_CONFIG_DIR>/settings.json — tests must never touch the real
// ~/.doge. Re-pinned in beforeEach since bun test shares one process across
// files.
const TMP_CONFIG_DIR = join(tmpdir(), 'doge-permissions-auto-bypass-test')
rmSync(TMP_CONFIG_DIR, { recursive: true, force: true })
mkdirSync(TMP_CONFIG_DIR, { recursive: true })
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR

const { hasPermissionsToUseTool } = await import('./permissions.js')
const { resetSettingsCache } = await import('../settings/settingsCache.js')

import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'

// Integration coverage for the doge-fork Auto zero-ask semantics in the
// central permission pipeline: bypassPermissions never prompts (1b/1e/1f/1g
// asks release to the 2a bypass allow), explicit deny rules still win, and
// a plan mode entered FROM Auto is a real planning phase — writes are denied
// with keep-planning guidance while ExitPlanMode is auto-approved.

function makeContext(
  toolPermissionContext: ToolPermissionContext,
): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      // Empty rule collections — the pipeline dereferences these per source
      // before reaching the mode check under test.
      alwaysDenyRules: {},
      alwaysAskRules: {},
      alwaysAllowRules: {},
      ...toolPermissionContext,
    },
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

function makeTool(
  name: string,
  opts: {
    requiresUserInteraction?: boolean
    ask?: boolean
    askReason?: 'rule' | 'safetyCheck'
  } = {},
): Tool {
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    async checkPermissions() {
      if (!opts.ask) {
        return { behavior: 'passthrough' as const, message: 'test' }
      }
      if (opts.askReason === 'rule') {
        return {
          behavior: 'ask' as const,
          message: 'ask?',
          decisionReason: {
            type: 'rule' as const,
            rule: {
              source: 'userSettings' as const,
              ruleBehavior: 'ask' as const,
              ruleValue: { toolName: name, ruleContent: 'publish:*' },
            },
          },
        }
      }
      if (opts.askReason === 'safetyCheck') {
        return {
          behavior: 'ask' as const,
          message: 'ask?',
          decisionReason: {
            type: 'safetyCheck' as const,
            reason: 'protected path',
            classifierApprovable: true,
          },
        }
      }
      return { behavior: 'ask' as const, message: 'ask?' }
    },
    ...(opts.requiresUserInteraction
      ? { requiresUserInteraction: () => true }
      : {}),
  } as unknown as Tool
}

const assistantMessage = { message: { id: 'test' } } as never

function bypassContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolUseContext {
  return makeContext({
    mode: 'bypassPermissions',
    ...overrides,
  } as ToolPermissionContext)
}

function planInterludeContext(): ToolUseContext {
  return makeContext({
    mode: 'plan',
    prePlanMode: 'bypassPermissions',
    autoPlan: true,
  } as ToolPermissionContext)
}

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR
  writeFileSync(join(TMP_CONFIG_DIR, 'settings.json'), '{}', 'utf8')
  resetSettingsCache()
})

afterAll(() => {
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  resetSettingsCache()
  rmSync(TMP_CONFIG_DIR, { recursive: true, force: true })
})

test('direct bypassPermissions mode allows tools (regression guard)', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('Bash'),
    { command: 'ls' },
    bypassContext(),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('allow')
})

test('zero-ask Auto: whole-tool ask rule (1b) releases to allow', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('CustomTool'),
    {},
    bypassContext({
      alwaysAskRules: { userSettings: ['CustomTool'] },
    } as ToolPermissionContext),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('allow')
})

test('zero-ask Auto: requiresUserInteraction tool (1e) releases to allow', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('CustomTool', { requiresUserInteraction: true, ask: true }),
    {},
    bypassContext(),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('allow')
})

test('zero-ask Auto: content ask rule (1f) releases to allow', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('CustomTool', { ask: true, askReason: 'rule' }),
    {},
    bypassContext(),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('allow')
})

test('zero-ask Auto: safety check (1g) releases to allow', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('CustomTool', { ask: true, askReason: 'safetyCheck' }),
    {},
    bypassContext(),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('allow')
})

test('zero-ask Auto: explicit deny rule (1a) still denies', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('CustomTool'),
    {},
    bypassContext({
      alwaysDenyRules: { userSettings: ['CustomTool'] },
    } as ToolPermissionContext),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('deny')
})

test('zero-ask Auto: tool-implemented deny (1d) still denies', async () => {
  const tool = {
    name: 'CustomTool',
    inputSchema: z.object({}).passthrough(),
    async checkPermissions() {
      return { behavior: 'deny' as const, message: 'denied' }
    },
  } as unknown as Tool
  const result = await hasPermissionsToUseTool(
    tool,
    {},
    bypassContext(),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('deny')
})

test('plan interlude (plan from Auto): write prompts become keep-planning denials', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('Bash'),
    { command: 'ls' },
    planInterludeContext(),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('deny')
  expect(result.behavior === 'deny' && result.message).toContain(
    'ExitPlanMode',
  )
})

test('plan interlude: requiresUserInteraction tools other than ExitPlanMode are denied', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('CustomTool', { requiresUserInteraction: true, ask: true }),
    {},
    planInterludeContext(),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('deny')
})

test('plan interlude: ExitPlanMode is auto-approved back to Auto', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('ExitPlanMode', { requiresUserInteraction: true, ask: true }),
    {},
    planInterludeContext(),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('allow')
})

test('plan interlude: read-only tools the tool itself allows still run', async () => {
  const tool = {
    name: 'Read',
    isReadOnly: () => true,
    inputSchema: z.object({}).passthrough(),
    async checkPermissions(input: Record<string, unknown>) {
      return { behavior: 'allow' as const, updatedInput: input }
    },
  } as unknown as Tool
  const result = await hasPermissionsToUseTool(
    tool,
    {},
    planInterludeContext(),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('allow')
})

test('manually selected Plan retains prompts even in a flag-launched session', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('Bash'),
    { command: 'ls' },
    makeContext({
      mode: 'plan',
      prePlanMode: 'bypassPermissions',
      isBypassPermissionsModeAvailable: true,
    } as ToolPermissionContext),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('ask')
})

test('plain plan mode still asks (regression guard)', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('Bash'),
    { command: 'ls' },
    makeContext({ mode: 'plan' } as ToolPermissionContext),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('ask')
})

test('leaving Auto restores prompts: acceptEdits still asks for non-edit tools', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('Bash'),
    { command: 'ls' },
    makeContext({ mode: 'acceptEdits' } as ToolPermissionContext),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('ask')
})

test('killswitch: zero-ask never activates when bypass is disabled by settings', async () => {
  writeFileSync(
    join(TMP_CONFIG_DIR, 'settings.json'),
    JSON.stringify({
      permissions: { disableBypassPermissionsMode: 'disable' },
    }),
    'utf8',
  )
  resetSettingsCache()

  const askResult = await hasPermissionsToUseTool(
    makeTool('CustomTool', { requiresUserInteraction: true, ask: true }),
    {},
    bypassContext(),
    assistantMessage,
    'test-id',
  )
  expect(askResult.behavior).toBe('ask')

  const interludeResult = await hasPermissionsToUseTool(
    makeTool('Bash'),
    { command: 'ls' },
    planInterludeContext(),
    assistantMessage,
    'test-id',
  )
  expect(interludeResult.behavior).toBe('ask')
})

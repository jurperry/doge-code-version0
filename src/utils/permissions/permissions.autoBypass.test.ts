import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { hasPermissionsToUseTool } from './permissions.js'

// Integration coverage for the doge-fork auto bypass in the central
// permission pipeline: a plan mode entered from /auto must release tools
// (issue 2) while the ExitPlanMode approval dialog keeps prompting (issue 3).

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
  opts: { requiresUserInteraction?: boolean; ask?: boolean } = {},
): Tool {
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    async checkPermissions() {
      return opts.ask
        ? { behavior: 'ask' as const, message: 'ask?' }
        : { behavior: 'passthrough' as const, message: 'test' }
    },
    ...(opts.requiresUserInteraction
      ? { requiresUserInteraction: () => true }
      : {}),
  } as unknown as Tool
}

const assistantMessage = { message: { id: 'test' } } as never

test('plan entered from /auto (prePlanMode bypass) allows tools without asking', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('Bash'),
    { command: 'ls' },
    makeContext({
      mode: 'plan',
      prePlanMode: 'bypassPermissions',
    } as ToolPermissionContext),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('allow')
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

test('direct bypassPermissions mode allows tools (regression guard)', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('Bash'),
    { command: 'ls' },
    makeContext({ mode: 'bypassPermissions' } as ToolPermissionContext),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('allow')
})

test('user-interaction tools (plan approval) still ask in auto+plan', async () => {
  const result = await hasPermissionsToUseTool(
    makeTool('ExitPlanMode', { requiresUserInteraction: true, ask: true }),
    {},
    makeContext({
      mode: 'plan',
      prePlanMode: 'bypassPermissions',
    } as ToolPermissionContext),
    assistantMessage,
    'test-id',
  )
  expect(result.behavior).toBe('ask')
})

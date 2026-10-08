import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sandbox = join(import.meta.dir, 'auto-elicitation-sandbox')
mkdirSync(sandbox, { recursive: true })
const originalConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = sandbox
const { resetSettingsCache } = await import('../src/utils/settings/settingsCache.js')
const { setCurrentPermissionMode } = await import('../src/utils/permissions/currentPermissionMode.js')
const { runElicitationHooks } = await import('../src/services/mcp/elicitationHandler.js')
const { resetHooksConfigSnapshot } = await import('../src/utils/hooks/hooksConfigSnapshot.js')
const signal = new AbortController().signal
const form = { message: 'Choose server options', requestedSchema: { type: 'object', properties: {
  strategy: { type: 'string', enum: ['reuse', 'replace'] },
  enabled: { type: 'boolean' },
  count: { type: 'integer', minimum: 2 },
  label: { type: 'string', default: 'automatic' },
}, required: ['strategy', 'enabled', 'count', 'label'] } } as any
const url = { mode: 'url', message: 'Approve server operation', url: 'http://127.0.0.1/approve', elicitationId: 'local-test' } as const

beforeEach(() => {
  writeFileSync(join(sandbox, 'settings.json'), '{}')
  resetSettingsCache()
  resetHooksConfigSnapshot()
  setCurrentPermissionMode('default')
})
afterAll(() => {
  setCurrentPermissionMode('default')
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  resetSettingsCache()
  resetHooksConfigSnapshot()
  rmSync(sandbox, { recursive: true, force: true })
})

test('Auto answers MCP forms and URL consent without asking the user', async () => {
  setCurrentPermissionMode('bypassPermissions')
  expect(await runElicitationHooks('local', form, signal)).toEqual({ action: 'accept', content: { strategy: 'reuse', enabled: true, count: 2, label: 'automatic' } })
  expect(await runElicitationHooks('local', url, signal)).toEqual({ action: 'accept' })
})

test('automatic Plan answers MCP elicitation and manual modes retain their dialogs', async () => {
  setCurrentPermissionMode('plan', true)
  expect((await runElicitationHooks('local', url, signal))?.action).toBe('accept')
  for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
    setCurrentPermissionMode(mode)
    expect(await runElicitationHooks('local', form, signal)).toBeUndefined()
  }
})

test('disabled bypass retains the MCP interaction boundary', async () => {
  writeFileSync(join(sandbox, 'settings.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }))
  resetSettingsCache()
  setCurrentPermissionMode('bypassPermissions')
  expect(await runElicitationHooks('local', url, signal)).toBeUndefined()
})

test('MCP form defaults, titled choices and numeric bounds stay valid', async () => {
  setCurrentPermissionMode('bypassPermissions')
  const params = { ...form, requestedSchema: { type: 'object', properties: {
    optional: { type: 'string' },
    disabled: { type: 'boolean', default: false },
    strategy: { type: 'string', oneOf: [{ const: 'reuse', title: 'Reuse' }] },
    choices: { type: 'array', minItems: 2, items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] } },
    upper: { type: 'number', maximum: -2 },
  }, required: ['strategy', 'choices', 'upper'] } }
  expect(await runElicitationHooks('local', params, signal)).toEqual({ action: 'accept', content: { disabled: false, strategy: 'reuse', choices: ['a', 'b'], upper: -2 } })
})

test('automatic MCP answers satisfy integer and formatted string limits', async () => {
  setCurrentPermissionMode('bypassPermissions')
  const params = { ...form, requestedSchema: { type: 'object', properties: {
    integer: { type: 'integer', maximum: -2.5 },
    email: { type: 'string', format: 'email', maxLength: 8 },
    time: { type: 'string', format: 'date-time', maxLength: 20 },
  }, required: ['integer', 'email', 'time'] } }
  const response = await runElicitationHooks('local', params, signal)
  const content = response?.content as any
  expect(content.integer).toBe(-3)
  expect(content.email).toMatch(/^[^@]+@[^@]+\.[^@]+$/)
  expect(content.email.length).toBeLessThanOrEqual(8)
  expect(content.time).toMatch(/Z$/)
  expect(content.time.length).toBeLessThanOrEqual(20)
})

test('automatic MCP answers still honor ElicitationResult hooks', async () => {
  const hook = join(sandbox, 'result-hook.cjs')
  writeFileSync(hook, `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'ElicitationResult',action:'decline'}}))`)
  writeFileSync(join(sandbox, 'settings.json'), JSON.stringify({ hooks: { ElicitationResult: [{ matcher: 'local', hooks: [{ type: 'command', command: `node "${hook.replaceAll('\\', '/')}"` }] }] } }))
  resetSettingsCache()
  setCurrentPermissionMode('bypassPermissions')
  expect((await runElicitationHooks('local', form, signal))?.action).toBe('decline')
  expect((await runElicitationHooks('local', url, signal))?.action).toBe('decline')
})

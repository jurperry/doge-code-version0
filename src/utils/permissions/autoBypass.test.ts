import { expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'
import { isAutoBypassActive } from './autoBypass.js'

function ctx(
  mode: PermissionMode,
  prePlanMode?: PermissionMode,
  isBypassPermissionsModeAvailable?: boolean,
): ToolPermissionContext {
  return {
    mode,
    ...(prePlanMode !== undefined ? { prePlanMode } : {}),
    ...(isBypassPermissionsModeAvailable !== undefined
      ? { isBypassPermissionsModeAvailable }
      : {}),
  } as ToolPermissionContext
}

test('direct bypassPermissions mode is auto-bypass active', () => {
  expect(isAutoBypassActive(ctx('bypassPermissions'))).toBe(true)
})

test('plan entered from bypassPermissions (/auto session) stays auto-bypass active', () => {
  expect(isAutoBypassActive(ctx('plan', 'bypassPermissions'))).toBe(true)
})

test('plan entered from bypass with flag-launched session is auto-bypass active', () => {
  expect(isAutoBypassActive(ctx('plan', undefined, true))).toBe(true)
})

test('plain plan mode (entered from default/acceptEdits) is not auto-bypass', () => {
  expect(isAutoBypassActive(ctx('plan'))).toBe(false)
  expect(isAutoBypassActive(ctx('plan', 'default'))).toBe(false)
  expect(isAutoBypassActive(ctx('plan', 'acceptEdits'))).toBe(false)
})

test('default and acceptEdits are never auto-bypass, even with stale prePlanMode', () => {
  // After plan approval downgrades the mode, a lingering prePlanMode must
  // not keep bypassing — only mode === 'plan' consults prePlanMode.
  expect(isAutoBypassActive(ctx('default', 'bypassPermissions'))).toBe(false)
  expect(isAutoBypassActive(ctx('acceptEdits', 'bypassPermissions'))).toBe(
    false,
  )
  expect(isAutoBypassActive(ctx('default'))).toBe(false)
})

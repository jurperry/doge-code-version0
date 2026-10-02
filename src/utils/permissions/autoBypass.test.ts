import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Sandbox the config dir BEFORE importing the settings chain: the zero-ask
// killswitch (isBypassPermissionsModeDisabled) reads
// <CLAUDE_CONFIG_DIR>/settings.json — tests must never touch the real
// ~/.doge. Re-pinned in beforeEach since bun test shares one process across
// files.
const TMP_CONFIG_DIR = join(tmpdir(), 'doge-auto-bypass-test-sandbox')
rmSync(TMP_CONFIG_DIR, { recursive: true, force: true })
mkdirSync(TMP_CONFIG_DIR, { recursive: true })
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR

const {
  isAutoBypassActive,
  isZeroAskAutoActive,
  isZeroAskPlanInterlude,
} = await import('./autoBypass.js')
const { resetSettingsCache } = await import('../settings/settingsCache.js')

import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'

function ctx(
  mode: PermissionMode,
  prePlanMode?: PermissionMode,
  isBypassPermissionsModeAvailable?: boolean,
): ToolPermissionContext {
  return {
    mode,
    ...(prePlanMode !== undefined ? { prePlanMode } : {}),
    ...(mode === 'plan' && prePlanMode === 'bypassPermissions' ? { autoPlan: true } : {}),
    ...(isBypassPermissionsModeAvailable !== undefined
      ? { isBypassPermissionsModeAvailable }
      : {}),
  } as ToolPermissionContext
}

function writeUserSettings(settings: Record<string, unknown>): void {
  writeFileSync(
    join(TMP_CONFIG_DIR, 'settings.json'),
    JSON.stringify(settings),
    'utf8',
  )
  resetSettingsCache()
}

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR
  writeUserSettings({})
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

test('direct bypassPermissions mode is auto-bypass active', () => {
  expect(isAutoBypassActive(ctx('bypassPermissions'))).toBe(true)
})

test('plan entered from bypassPermissions (/auto session) is NOT auto-bypass — it is the zero-ask plan interlude', () => {
  expect(isAutoBypassActive(ctx('plan', 'bypassPermissions'))).toBe(false)
})

test('plan in a flag-launched session retains planning boundaries', () => {
  expect(isAutoBypassActive(ctx('plan', undefined, true))).toBe(false)
  expect(isAutoBypassActive(ctx('plan', 'bypassPermissions', true))).toBe(false)
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

test('zero-ask auto is active exactly in bypassPermissions mode', () => {
  expect(isZeroAskAutoActive(ctx('bypassPermissions'))).toBe(true)
  expect(isZeroAskAutoActive(ctx('default'))).toBe(false)
  expect(isZeroAskAutoActive(ctx('acceptEdits'))).toBe(false)
  expect(isZeroAskAutoActive(ctx('plan'))).toBe(false)
  expect(isZeroAskAutoActive(ctx('plan', 'bypassPermissions'))).toBe(false)
})

test('zero-ask plan interlude is model-initiated Plan from Auto in every launch mode', () => {
  expect(isZeroAskPlanInterlude(ctx('plan', 'bypassPermissions'))).toBe(true)
  expect(isZeroAskPlanInterlude(ctx('plan', 'bypassPermissions', true))).toBe(
    true,
  )
  expect(isZeroAskPlanInterlude(ctx('plan'))).toBe(false)
  expect(isZeroAskPlanInterlude(ctx('plan', 'default'))).toBe(false)
  expect(isZeroAskPlanInterlude(ctx('plan', 'acceptEdits'))).toBe(false)
  expect(isZeroAskPlanInterlude(ctx('bypassPermissions'))).toBe(false)
})

test('killswitch disables zero-ask auto and the plan interlude', () => {
  writeUserSettings({
    permissions: { disableBypassPermissionsMode: 'disable' },
  })
  expect(isZeroAskAutoActive(ctx('bypassPermissions'))).toBe(false)
  expect(isZeroAskPlanInterlude(ctx('plan', 'bypassPermissions'))).toBe(false)
})

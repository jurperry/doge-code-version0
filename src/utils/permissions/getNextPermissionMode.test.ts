import { expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'
import { getNextPermissionMode } from './getNextPermissionMode.js'

// getNextPermissionMode only reads `mode` off the context; in this fork the
// bypass gate is isBypassPermissionsModeDisabled() (settings/gate), not the
// context's isBypassPermissionsModeAvailable.
function ctx(mode: PermissionMode): ToolPermissionContext {
  return { mode } as ToolPermissionContext
}

test('shift+tab carousel cycles auto -> accept -> plan -> auto', () => {
  expect(getNextPermissionMode(ctx('bypassPermissions'))).toBe('acceptEdits')
  expect(getNextPermissionMode(ctx('acceptEdits'))).toBe('plan')
  expect(getNextPermissionMode(ctx('plan'))).toBe('bypassPermissions')
})

test('entering the carousel from default lands on auto (bypassPermissions)', () => {
  expect(getNextPermissionMode(ctx('default'))).toBe('bypassPermissions')
})

test('dontAsk and unknown modes fall back to default', () => {
  expect(getNextPermissionMode(ctx('dontAsk'))).toBe('default')
  expect(getNextPermissionMode(ctx('bubble' as PermissionMode))).toBe(
    'default',
  )
})

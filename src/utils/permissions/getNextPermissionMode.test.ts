import { expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'
import { getNextPermissionMode } from './getNextPermissionMode.js'

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

test('a remote bypass refusal leaves Accept edits and Plan reachable', () => {
  const context = { ...ctx('default'), isRemoteBypassPermissionsDisabled: true }
  expect(getNextPermissionMode(context)).toBe('acceptEdits')
  expect(getNextPermissionMode({ ...context, mode: 'acceptEdits' })).toBe('plan')
  expect(getNextPermissionMode({ ...context, mode: 'plan' })).toBe('default')
})

test('dontAsk and unknown modes fall back to default', () => {
  expect(getNextPermissionMode(ctx('dontAsk'))).toBe('default')
  expect(getNextPermissionMode(ctx('bubble' as PermissionMode))).toBe(
    'default',
  )
})

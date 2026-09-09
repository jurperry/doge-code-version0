import { expect, test } from 'bun:test'
import { buildPlanApprovalOptions, resolvePlanApprovalMode } from './ExitPlanModePermissionRequest.js'

const noop = () => {}

function build(overrides: Partial<Parameters<typeof buildPlanApprovalOptions>[0]> = {}) {
  return buildPlanApprovalOptions({
    showClearContext: false,
    showUltraplan: false,
    usedPercent: null,
    isAutoModeAvailable: false,
    isBypassPermissionsModeAvailable: false,
    autoSession: false,
    canBypass: true,
    onFeedbackChange: noop,
    ...overrides,
  })
}

test('auto session: stay-in-auto offered first, auto-accept edits still listed, manual present', () => {
  const options = build({ autoSession: true })
  expect(options[0]).toEqual({
    label: 'Yes, and stay in auto mode',
    value: 'yes-auto-mode-keep-context',
  })
  expect(options[1]).toEqual({
    label: 'Yes, and auto-accept edits',
    value: 'yes-accept-edits-keep-context',
  })
  expect(options.map(o => o.value)).toContain('yes-default-keep-context')
  // The user's pick is final: choosing auto-accept edits in an auto session
  // must NOT be remapped back to bypassPermissions.
  expect(
    resolvePlanApprovalMode('yes-accept-edits-keep-context', {
      prePlanMode: 'bypassPermissions',
    } as never),
  ).toBe('acceptEdits')
  expect(resolvePlanApprovalMode('yes-auto-mode-keep-context', {})).toBe(
    'bypassPermissions',
  )
})

test('auto session with clear context: stay-in-auto first, auto-accept edits listed', () => {
  const options = build({ showClearContext: true, usedPercent: 42, autoSession: true })
  expect(options[0]).toEqual({
    label: 'Yes, clear context (42%) and stay in auto mode',
    value: 'yes-bypass-permissions',
  })
  expect(options[1]).toEqual({
    label: 'Yes, clear context (42%) and auto-accept edits',
    value: 'yes-accept-edits',
  })
})

test('normal session: default stays accept-edits, plus an explicit auto option', () => {
  const options = build()
  expect(options[0]).toEqual({
    label: 'Yes, and auto-accept edits',
    value: 'yes-accept-edits-keep-context',
  })
  expect(options.find(o => o.value === 'yes-auto-mode-keep-context')).toEqual({
    label: 'Yes, and use auto mode',
    value: 'yes-auto-mode-keep-context',
  })
  expect(resolvePlanApprovalMode('yes-auto-mode-keep-context', {})).toBe(
    'bypassPermissions',
  )
})

test('normal session with bypass disabled: no auto option anywhere', () => {
  const options = build({ showClearContext: true, canBypass: false })
  expect(options.map(o => o.value)).not.toContain('yes-auto-mode-keep-context')
  expect(options.map(o => o.value)).not.toContain('yes-bypass-permissions')
})

test('normal session with clear context: auto option added alongside the default', () => {
  const options = build({ showClearContext: true })
  expect(options[0]).toEqual({
    label: 'Yes, clear context and auto-accept edits',
    value: 'yes-accept-edits',
  })
  expect(options.find(o => o.value === 'yes-bypass-permissions')).toEqual({
    label: 'Yes, clear context and use auto mode',
    value: 'yes-bypass-permissions',
  })
})

test('flag-launched session keeps upstream bypass labels', () => {
  const options = build({ isBypassPermissionsModeAvailable: true })
  expect(options[0]).toEqual({
    label: 'Yes, and bypass permissions',
    value: 'yes-accept-edits-keep-context',
  })
  expect(options.map(o => o.value)).not.toContain('yes-auto-mode-keep-context')
})

test('keep-planning option is always present', () => {
  expect(build({ autoSession: true }).map(o => o.value)).toContain('no')
  expect(build().map(o => o.value)).toContain('no')
})

test('resolvePlanApprovalMode matrix', () => {
  const flag = { isBypassPermissionsModeAvailable: true }
  const plain = {}
  expect(resolvePlanApprovalMode('yes-accept-edits-keep-context', plain)).toBe(
    'acceptEdits',
  )
  // flag sessions: upstream maps their "bypass permissions" option here
  expect(resolvePlanApprovalMode('yes-accept-edits-keep-context', flag)).toBe(
    'bypassPermissions',
  )
  // mid-session disableBypassPermissionsMode: no silent bypass restore
  expect(
    resolvePlanApprovalMode('yes-accept-edits-keep-context', flag, true),
  ).toBe('acceptEdits')
  expect(resolvePlanApprovalMode('yes-default-keep-context', plain)).toBe(
    'default',
  )
  expect(resolvePlanApprovalMode('no', plain)).toBeUndefined()
  expect(resolvePlanApprovalMode('ultraplan', plain)).toBeUndefined()
})

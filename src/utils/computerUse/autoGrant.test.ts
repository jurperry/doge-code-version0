import { expect, test } from 'bun:test'
import type {
  CuPermissionRequest,
  ResolvedAppRequest,
} from '@ant/computer-use-mcp'
import { DEFAULT_GRANT_FLAGS } from '@ant/computer-use-mcp'
import { buildAutoGrantResponse } from './autoGrant.js'

function app(partial: Partial<ResolvedAppRequest>): ResolvedAppRequest {
  return {
    requestedName: 'SomeApp',
    isSentinel: false,
    alreadyGranted: false,
    proposedTier: 'full',
    ...partial,
  }
}

function req(
  apps: ResolvedAppRequest[],
  requestedFlags: CuPermissionRequest['requestedFlags'] = {},
): CuPermissionRequest {
  return {
    requestId: 'test-req',
    reason: 'test',
    apps,
    requestedFlags,
    screenshotFiltering: 'none',
  }
}

test('grants every resolved app without a tier (package backfills)', () => {
  const response = buildAutoGrantResponse(
    req([
      app({
        requestedName: 'Slack',
        resolved: { bundleId: 'slack.id', displayName: 'Slack' },
      }),
      app({
        requestedName: 'Terminal',
        resolved: { bundleId: 'term.id', displayName: 'Terminal' },
        proposedTier: 'click',
      }),
    ]),
  )
  expect(response.granted).toHaveLength(2)
  expect(response.granted[0]).toEqual({
    bundleId: 'slack.id',
    displayName: 'Slack',
    grantedAt: expect.any(Number),
  })
  // tier stays undefined even when proposedTier is set — mirrors the dialog,
  // which lets the package's getDefaultTierForApp assign tiers.
  expect(response.granted[1]).not.toHaveProperty('tier')
  expect(response.denied).toEqual([])
})

test('denies unresolved apps as not_installed using the requested name', () => {
  const response = buildAutoGrantResponse(
    req([
      app({ requestedName: 'Ghost', resolved: undefined }),
      app({
        requestedName: 'Real',
        resolved: { bundleId: 'real.id', displayName: 'Real' },
      }),
    ]),
  )
  expect(response.granted.map(g => g.bundleId)).toEqual(['real.id'])
  expect(response.denied).toEqual([
    { bundleId: 'Ghost', reason: 'not_installed' },
  ])
})

test('skips already-granted apps (idempotent re-grants are handled by the package)', () => {
  const response = buildAutoGrantResponse(
    req([
      app({
        requestedName: 'Slack',
        alreadyGranted: true,
        resolved: { bundleId: 'slack.id', displayName: 'Slack' },
      }),
    ]),
  )
  expect(response.granted).toEqual([])
  expect(response.denied).toEqual([])
})

test('grants truthy requested flags, leaves the rest at defaults', () => {
  const response = buildAutoGrantResponse(
    req([], { clipboardRead: true, clipboardWrite: false }),
  )
  expect(response.flags).toEqual({
    ...DEFAULT_GRANT_FLAGS,
    clipboardRead: true,
  })
})

test('sentinel apps are granted too — the dialog only warns about them', () => {
  const response = buildAutoGrantResponse(
    req([
      app({
        requestedName: 'Terminal',
        isSentinel: true,
        resolved: { bundleId: 'term.id', displayName: 'Terminal' },
      }),
    ]),
  )
  expect(response.granted.map(g => g.bundleId)).toEqual(['term.id'])
})

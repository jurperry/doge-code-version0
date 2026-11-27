import {
  type AppGrant,
  type CuGrantFlags,
  type CuPermissionRequest,
  type CuPermissionResponse,
  DEFAULT_GRANT_FLAGS,
} from '@ant/computer-use-mcp'

// doge fork: auto mode (/auto → bypassPermissions) grants the request_access
// consent without showing the ComputerUseApproval dialog — the user already
// opted into full release for the session. Mirrors the dialog's "Allow for
// this session" semantics exactly (ComputerUseApproval.tsx): every resolved
// app granted (tier left undefined — the package backfills via
// getDefaultTierForApp), unresolved apps denied as not_installed, requested
// flags granted when truthy. Sentinel apps stay grantable — the dialog only
// warns about them, it doesn't block.
export function buildAutoGrantResponse(
  req: CuPermissionRequest,
): CuPermissionResponse {
  const now = Date.now()
  const granted: AppGrant[] = req.apps.flatMap(a =>
    a.resolved && !a.alreadyGranted
      ? [
          {
            bundleId: a.resolved.bundleId,
            displayName: a.resolved.displayName,
            grantedAt: now,
          },
        ]
      : [],
  )
  const denied = req.apps
    .filter(a => !a.resolved)
    .map(a => ({
      bundleId: a.resolved?.bundleId ?? a.requestedName,
      reason: 'not_installed' as const,
    }))
  const flags: CuGrantFlags = {
    ...DEFAULT_GRANT_FLAGS,
    ...Object.fromEntries(
      (Object.keys(DEFAULT_GRANT_FLAGS) as Array<keyof CuGrantFlags>)
        .filter(k => req.requestedFlags[k])
        .map(k => [k, true] as const),
    ),
  }
  return { granted, denied, flags }
}

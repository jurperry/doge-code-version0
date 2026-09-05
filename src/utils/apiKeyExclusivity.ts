import { logForDebugging } from './debug.js'
import { getModelProfile, readCustomApiStorage } from './customApiStorage.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * DOGE_API_KEY and ANTHROPIC_AUTH_TOKEN are the two supported ways to hand
 * doge an API key, and they differ in HOW the key travels to the API:
 *
 *  - DOGE_API_KEY        → SDK `apiKey` → `x-api-key` header
 *  - ANTHROPIC_AUTH_TOKEN→ `Authorization: Bearer` header (client.ts
 *                          configureApiKeyHeaders)
 *
 * The two are mutually exclusive by contract (see start_*.ps1 which always
 * clear both before setting one). When BOTH survive into process.env — a
 * stale var left in the user's shell profile, a settings.json env block, or
 * a partially-applied start script — doge used to send BOTH headers with
 * different key values, and gateways answer that with an ambiguous 401
 * ("api-key 矛盾，导致不可用"). This module resolves the conflict once, at
 * startup, so exactly one token type remains.
 */

export type ApiKeyEnvType = 'DOGE_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'

export type ApiKeyConflictResolution = {
  keep: ApiKeyEnvType
  remove: ApiKeyEnvType
}

/**
 * Pure conflict arbitration. Returns null when there is no conflict (at most
 * one key present). Otherwise decides which var survives:
 *
 *  - If the active model's stored profile declares authTokenType
 *    ANTHROPIC_AUTH_TOKEN and its key matches the env ANTHROPIC_AUTH_TOKEN,
 *    the profile explicitly says this endpoint wants Bearer — keep it and
 *    drop the stray DOGE_API_KEY.
 *  - Otherwise DOGE_API_KEY wins (the fork's primary var; most start
 *    scripts and /provider entries use it) and ANTHROPIC_AUTH_TOKEN is
 *    dropped.
 */
export function resolveApiKeyConflict(input: {
  dogeKey?: string | undefined
  authKey?: string | undefined
  profileApiKey?: string | undefined
  profileAuthTokenType?: ApiKeyEnvType | undefined
}): ApiKeyConflictResolution | null {
  const { dogeKey, authKey, profileApiKey, profileAuthTokenType } = input
  if (!dogeKey || !authKey) return null
  const profilePrefersAuthToken =
    !!profileApiKey &&
    profileApiKey === authKey &&
    profileAuthTokenType === 'ANTHROPIC_AUTH_TOKEN'
  return profilePrefersAuthToken
    ? { keep: 'ANTHROPIC_AUTH_TOKEN', remove: 'DOGE_API_KEY' }
    : { keep: 'DOGE_API_KEY', remove: 'ANTHROPIC_AUTH_TOKEN' }
}

/**
 * Enforce mutual exclusion of DOGE_API_KEY / ANTHROPIC_AUTH_TOKEN in
 * process.env. Idempotent; safe to call multiple times during startup.
 *
 * Called at the end of applySafeConfigEnvironmentVariables() and
 * applyConfigEnvironmentVariables() in managedEnv.ts, i.e. after every
 * settings-sourced env injection has settled, and before any API request is
 * made. Multi-terminal note: this only touches THIS process's env — sibling
 * terminals are separate processes and are never affected.
 *
 * Skipped in contexts where ANTHROPIC_AUTH_TOKEN has an orchestration
 * meaning we must not disturb (ssh auth-proxy placeholders, CCD/remote
 * managed OAuth sessions).
 *
 * Returns the surviving token type when a conflict was resolved, undefined
 * when nothing needed to change.
 */
export function enforceApiKeyExclusivity(): ApiKeyEnvType | undefined {
  return enforceApiKeyExclusivityWithDeps({
    // Real binding: the active model's stored profile is the explicit
    // record of which token type this endpoint wants.
    getActiveProfileCredentials: () => {
      const activeModel =
        process.env.ANTHROPIC_MODEL || readCustomApiStorage().model
      if (!activeModel) return undefined
      const profile = getModelProfile(activeModel)
      if (!profile) return undefined
      return { apiKey: profile.apiKey, authTokenType: profile.authTokenType }
    },
  })
}

/** Injectable variant used by tests. */
export function enforceApiKeyExclusivityWithDeps(deps: {
  getActiveProfileCredentials: () => {
    apiKey?: string | undefined
    authTokenType?: ApiKeyEnvType | undefined
  } | undefined
}): ApiKeyEnvType | undefined {
  // `claude ssh` remote: launcher placeholders must survive untouched.
  if (process.env.ANTHROPIC_UNIX_SOCKET) return undefined
  // CCD / managed OAuth context: env vars belong to the host orchestrator.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
    process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
  ) {
    return undefined
  }

  const dogeKey = process.env.DOGE_API_KEY
  const authKey = process.env.ANTHROPIC_AUTH_TOKEN
  let profileApiKey: string | undefined
  let profileAuthTokenType: ApiKeyEnvType | undefined
  try {
    const profile = deps.getActiveProfileCredentials()
    profileApiKey = profile?.apiKey
    profileAuthTokenType = profile?.authTokenType
  } catch {
    // Storage read failure must not block startup — fall back to default
    // arbitration below.
  }

  const final = resolveApiKeyConflict({
    dogeKey,
    authKey,
    profileApiKey,
    profileAuthTokenType,
  })
  if (!final) return undefined

  delete process.env[final.remove]
  logForDebugging(
    `[auth] DOGE_API_KEY and ANTHROPIC_AUTH_TOKEN are both set — keeping ${final.keep}, deleting ${final.remove}. ` +
      'Sending both an x-api-key and a Bearer header makes providers reject the request; unset the stale variable at its source (shell profile / start script / settings env).',
    { level: 'error' },
  )
  // Visible without --debug: a silent deletion would look like the wrong key
  // being used for no reason. Key VALUES are never logged.
  // biome-ignore lint/suspicious/noConsole:: startup-time conflict warning must be visible without --debug
  console.error(
    `[doge] DOGE_API_KEY and ANTHROPIC_AUTH_TOKEN are both set; using ${final.keep} and ignoring ${final.remove}. Unset the stale one to silence this.`,
  )
  return final.keep
}

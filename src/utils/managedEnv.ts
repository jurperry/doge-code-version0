import { isRemoteManagedSettingsEligible } from '../services/remoteManagedSettings/syncCache.js'
import { clearCACertsCache } from './caCerts.js'
import { getGlobalConfig } from './config.js'
import { getModelProfile, readCustomApiStorage } from './customApiStorage.js'
import { enforceApiKeyExclusivity } from './apiKeyExclusivity.js'
import { isEnvTruthy } from './envUtils.js'
import {
  isProviderManagedEnvVar,
  SAFE_ENV_VARS,
} from './managedEnvConstants.js'
import { clearMTLSCache } from './mtls.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'

/**
 * `claude ssh` remote: ANTHROPIC_UNIX_SOCKET routes auth through a -R forwarded
 * socket to a local proxy, and the launcher sets a handful of placeholder auth
 * env vars that the remote's ~/.claude settings.env MUST NOT clobber (see
 * isAnthropicAuthEnabled). Strip them from any settings-sourced env object.
 */
function withoutSSHTunnelVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !process.env.ANTHROPIC_UNIX_SOCKET) return env || {}
  const {
    ANTHROPIC_UNIX_SOCKET: _1,
    ANTHROPIC_BASE_URL: _2,
    DOGE_API_KEY: _3,
    ANTHROPIC_AUTH_TOKEN: _4,
    CLAUDE_CODE_OAUTH_TOKEN: _5,
    ...rest
  } = env
  return rest
}

/**
 * When the host owns inference routing (sets
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST in spawn env), strip
 * provider-selection / model-default vars from settings-sourced env so a
 * user's ~/.claude/settings.json can't redirect requests away from the
 * host-configured provider.
 */
function withoutHostManagedProviderVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {}
  if (!isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) {
    return env
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isProviderManagedEnvVar(key)) {
      out[key] = value
    }
  }
  return out
}

/**
 * Snapshot of env keys present before any settings.env is applied — for CCD,
 * these are the keys the desktop host set to orchestrate the subprocess.
 * Settings must not override them (OTEL_LOGS_EXPORTER=console would corrupt
 * the stdio JSON-RPC transport). Keys added LATER by user/project settings
 * are not in this set, so mid-session settings.json changes still apply.
 * Lazy-captured on first applySafeConfigEnvironmentVariables() call.
 */
let ccdSpawnEnvKeys: Set<string> | null | undefined

function withoutCcdSpawnEnvKeys(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !ccdSpawnEnvKeys) return env || {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!ccdSpawnEnvKeys.has(key)) out[key] = value
  }
  return out
}

/**
 * Compose the strip filters applied to every settings-sourced env object.
 */
function filterSettingsEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return withoutCcdSpawnEnvKeys(
    withoutHostManagedProviderVars(withoutSSHTunnelVars(env)),
  )
}

/**
 * Trusted setting sources whose env vars can be applied before the trust dialog.
 *
 * - userSettings (~/.claude/settings.json): controlled by the user, not project-specific
 * - flagSettings (--settings CLI flag or SDK inline settings): explicitly passed by the user
 * - policySettings (managed settings from enterprise API or local managed-settings.json):
 *   controlled by IT/admin (highest priority, cannot be overridden)
 *
 * Project-scoped sources (projectSettings, localSettings) are excluded because they live
 * inside the project directory and could be committed by a malicious actor to redirect
 * traffic (e.g., ANTHROPIC_BASE_URL) to an attacker-controlled server.
 */
const TRUSTED_SETTING_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

/**
 * Apply environment variables from trusted sources to process.env.
 * Called before the trust dialog so that user/enterprise env vars like
 * ANTHROPIC_BASE_URL take effect during first-run/onboarding.
 *
 * For trusted sources (user settings, managed settings, CLI flags), ALL env vars
 * are applied — including ones like ANTHROPIC_BASE_URL that would be dangerous
 * from project-scoped settings.
 *
 * For project-scoped sources (projectSettings, localSettings), only safe env vars
 * from the SAFE_ENV_VARS allowlist are applied. These are applied after trust is
 * fully established via applyConfigEnvironmentVariables().
 */
export function applySafeConfigEnvironmentVariables(): void {
  // Capture CCD spawn-env keys before any settings.env is applied (once).
  if (ccdSpawnEnvKeys === undefined) {
    ccdSpawnEnvKeys =
      process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
        ? new Set(Object.keys(process.env))
        : null
  }

  // Global config (~/.claude.json) is user-controlled. In CCD mode,
  // filterSettingsEnv strips keys that were in the spawn env snapshot so
  // the desktop host's operational vars (OTEL, etc.) are not overridden.
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))
  applyPersistedCustomApiEndpointEnv()

  // Apply ALL env vars from trusted setting sources, policySettings last.
  // Gate on isSettingSourceEnabled so SDK settingSources: [] (isolation mode)
  // doesn't get clobbered by ~/.claude/settings.json env (gh#217). policy/flag
  // sources are always enabled, so this only ever filters userSettings.
  for (const source of TRUSTED_SETTING_SOURCES) {
    if (source === 'policySettings') continue
    if (!isSettingSourceEnabled(source)) continue
    Object.assign(
      process.env,
      filterSettingsEnv(getSettingsForSource(source)?.env),
    )
  }

  // Compute remote-managed-settings eligibility now, with userSettings and
  // flagSettings env applied. Eligibility reads CLAUDE_CODE_USE_BEDROCK,
  // ANTHROPIC_BASE_URL — both settable via settings.env.
  // getSettingsForSource('policySettings') below consults the remote cache,
  // which guards on this. The two-phase structure makes the ordering
  // dependency visible: non-policy env → eligibility → policy env.
  isRemoteManagedSettingsEligible()

  Object.assign(
    process.env,
    filterSettingsEnv(getSettingsForSource('policySettings')?.env),
  )

  // Apply only safe env vars from the fully-merged settings (which includes
  // project-scoped sources). For safe vars that also exist in trusted sources,
  // the merged value (which may come from a higher-priority project source)
  // will overwrite the trusted value — this is acceptable since these vars are
  // in the safe allowlist. Only policySettings values are guaranteed to survive
  // unchanged (it has the highest merge priority in both loops) — except
  // provider-routing vars, which filterSettingsEnv strips from every source
  // when CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is set.
  const settingsEnv = filterSettingsEnv(getSettings_DEPRECATED()?.env)
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (SAFE_ENV_VARS.has(key.toUpperCase())) {
      process.env[key] = value
    }
  }

  // Settings-sourced env may (re)introduce both key vars — collapse to one
  // before anything reads them.
  enforceApiKeyExclusivity()
}

/**
 * Apply environment variables from settings to process.env.
 * This applies ALL environment variables (except provider-routing vars when
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is set — see filterSettingsEnv) and
 * should only be called after trust is established. This applies potentially
 * dangerous environment variables such as LD_PRELOAD, PATH, etc.
 */
export function applyConfigEnvironmentVariables(): void {
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))
  applyPersistedCustomApiEndpointEnv()

  Object.assign(process.env, filterSettingsEnv(getSettings_DEPRECATED()?.env))

  // The full settings env is now applied — re-enforce key-var mutual
  // exclusion (idempotent) so a settings block carrying both DOGE_API_KEY
  // and ANTHROPIC_AUTH_TOKEN can't produce conflicting auth headers.
  enforceApiKeyExclusivity()

  // Clear caches so agents are rebuilt with the new env vars
  clearCACertsCache()
  clearMTLSCache()
  clearProxyCache()

  // Reconfigure proxy/mTLS agents to pick up any proxy env vars from settings
  configureGlobalAgents()
}

function applyPersistedCustomApiEndpointEnv(): void {
  const customApiEndpoint = {
    ...(getGlobalConfig().customApiEndpoint ?? {}),
    ...readCustomApiStorage(),
  }

  // Only apply the persisted model if ANTHROPIC_MODEL is not already
  // explicitly set in the environment. Otherwise the user's explicit
  // env var (e.g. deepseek-v4-pro[1m]) gets silently overwritten by
  // the last saved value from settings/customApiStorage.
  if (customApiEndpoint?.model && !process.env.ANTHROPIC_MODEL) {
    process.env.ANTHROPIC_MODEL = customApiEndpoint.model
  }

  // When starting without env vars (pure `doge` launch, no start_.ps1),
  // the top-level credentials in customApiStorage reflect the LAST model
  // added via /provider add, not necessarily the active model. If multiple
  // models are configured and /model was used to switch, the top-level
  // provider/baseURL/apiKey may belong to a different model than the
  // top-level model field — this causes credential misalignment on restart.
  //
  // Fix: when the active model has a stored profile, apply its full
  // credentials (provider, baseURL, apiKey) to override any stale
  // top-level values. Start scripts (start_.ps1) take priority because
  // they set env vars BEFORE this function runs — the env var guards
  // prevent overwriting them.
  const activeModel = process.env.ANTHROPIC_MODEL || customApiEndpoint?.model
  let hasProfileCredentials = false
  
  if (activeModel) {
    const profile = getModelProfile(activeModel)
    if (profile) {
      // Apply provider if not already set by env
      if (profile.provider && !process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER) {
        process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = profile.provider
      }
      // Apply baseURL from profile if not already set by env
      if (profile.baseURL && !process.env.ANTHROPIC_BASE_URL) {
        process.env.ANTHROPIC_BASE_URL = profile.baseURL
      }
      // Apply API key from profile if neither DOGE_API_KEY nor ANTHROPIC_AUTH_TOKEN is set
      if (profile.apiKey && !process.env.DOGE_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        if (profile.authTokenType === 'ANTHROPIC_AUTH_TOKEN') {
          process.env.ANTHROPIC_AUTH_TOKEN = profile.apiKey
        } else {
          process.env.DOGE_API_KEY = profile.apiKey
        }
        hasProfileCredentials = true
      }
      // Apply context window from profile
      if (profile.contextWindow !== undefined && !process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOW) {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOW = String(profile.contextWindow)
      }

      // Apply tier model configuration from profile if not already set by env.
      // Without this, /model shows Opus/Sonnet/Haiku all pointing to the main model
      // because the tier env vars are never populated at startup when no PS script runs.
      if (profile.defaultOpusModel && !process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = profile.defaultOpusModel
      }
      if (profile.defaultSonnetModel && !process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = profile.defaultSonnetModel
      }
      if (profile.defaultHaikuModel && !process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = profile.defaultHaikuModel
      }

      // Apply sub-agent model from profile
      if (profile.subagentModel && !process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
        process.env.CLAUDE_CODE_SUBAGENT_MODEL = profile.subagentModel
      }

      // Apply capability overrides from profile
      if (profile.opusCapabilities && !process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES) {
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = profile.opusCapabilities
      }
      if (profile.sonnetCapabilities && !process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES) {
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = profile.sonnetCapabilities
      }

      // Apply behavior flags from profile
      if (profile.disableNonessentialTraffic && !process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      }
      if (profile.disableNonstreamingFallback && !process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) {
        process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
      }
    }
  }

  // Only apply top-level credentials if profile did NOT provide them.
  // Top-level credentials are only used as fallback when no profile exists
  // for the active model.
  if (!hasProfileCredentials) {
    if (customApiEndpoint?.baseURL && !process.env.ANTHROPIC_BASE_URL) {
      process.env.ANTHROPIC_BASE_URL = customApiEndpoint.baseURL
    }

    // Only apply persisted API key when neither DOGE_API_KEY nor
    // ANTHROPIC_AUTH_TOKEN is already set in the environment. These two
    // are mutually exclusive — the start script will set one of them.
    // Applying the persisted key when the other token type is active
    // causes auth conflicts and routes the wrong key to the API.
    if (customApiEndpoint?.apiKey && !process.env.DOGE_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      if (customApiEndpoint.authTokenType === 'ANTHROPIC_AUTH_TOKEN') {
        process.env.ANTHROPIC_AUTH_TOKEN = customApiEndpoint.apiKey
      } else {
        process.env.DOGE_API_KEY = customApiEndpoint.apiKey
      }
    }
  }
}

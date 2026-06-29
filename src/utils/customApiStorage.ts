import { getSecureStorage } from './secureStorage/index.js'

/**
 * Complete model profile that captures ALL environment variables
 * needed to fully switch between different API providers/models.
 */
export type ModelProfile = {
  model: string
  /** API provider type */
  provider?: 'anthropic' | 'openai' | 'responses'
  /** API base URL */
  baseURL?: string
  /** API key value */
  apiKey?: string
  /** Which env var was used for the API key */
  authTokenType?: 'DOGE_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'
  /** Context window size (from CLAUDE_CODE_MODEL_CONTEXT_WINDOW) */
  contextWindow?: number

  // --- Sub-agent model configuration ---
  /** Override for Opus-tier agent model */
  defaultOpusModel?: string
  /** Override for Sonnet-tier agent model */
  defaultSonnetModel?: string
  /** Override for Haiku-tier agent model */
  defaultHaikuModel?: string
  /** Override for all sub-agent models */
  subagentModel?: string
  /** Capabilities string for Opus model */
  opusCapabilities?: string
  /** Capabilities string for Sonnet model */
  sonnetCapabilities?: string

  // --- Behavior configuration ---
  /** Disable non-essential network traffic */
  disableNonessentialTraffic?: boolean
  /** Disable non-streaming fallback */
  disableNonstreamingFallback?: boolean
  /** Effort level (e.g., 'max', 'high') */
  effortLevel?: string
}

export type CustomApiStorageData = {
  provider?: 'anthropic' | 'openai' | 'responses'
  baseURL?: string
  apiKey?: string
  /** Which env var was used for the API key (DOGE_API_KEY or ANTHROPIC_AUTH_TOKEN) */
  authTokenType?: 'DOGE_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'
  model?: string
  savedModels?: string[]
  /** Per-model profiles with full provider/credentials config */
  modelProfiles?: ModelProfile[]
}

const CUSTOM_API_STORAGE_KEY = 'customApiEndpoint'

export function readCustomApiStorage(): CustomApiStorageData {
  const storage = getSecureStorage() as {
    read?: () => Record<string, unknown> | null
    update?: (data: Record<string, unknown>) => { success: boolean }
  }
  const data = storage.read?.() ?? {}
  const raw = data[CUSTOM_API_STORAGE_KEY]
  if (!raw || typeof raw !== 'object') return {}
  const value = raw as Record<string, unknown>
  return {
    provider:
      value.provider === 'openai' || value.provider === 'anthropic' || value.provider === 'responses'
        ? value.provider
        : undefined,
    baseURL: typeof value.baseURL === 'string' ? value.baseURL : undefined,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : undefined,
    authTokenType:
      value.authTokenType === 'DOGE_API_KEY' || value.authTokenType === 'ANTHROPIC_AUTH_TOKEN'
        ? value.authTokenType
        : undefined,
    model: typeof value.model === 'string' ? value.model : undefined,
    savedModels: Array.isArray(value.savedModels)
      ? value.savedModels.filter((item): item is string => typeof item === 'string')
      : [],
    modelProfiles: Array.isArray(value.modelProfiles)
      ? value.modelProfiles.filter(
          (p): p is ModelProfile =>
            typeof p === 'object' && p !== null && typeof p.model === 'string',
        )
      : [],
  }
}

export function writeCustomApiStorage(next: CustomApiStorageData): void {
  const storage = getSecureStorage() as {
    read?: () => Record<string, unknown> | null
    update?: (data: Record<string, unknown>) => { success: boolean }
  }
  const current = storage.read?.() ?? {}
  storage.update?.({
    ...current,
    customApiEndpoint: next,
  })
}

export function clearCustomApiStorage(): void {
  const storage = getSecureStorage() as {
    read?: () => Record<string, unknown> | null
    update?: (data: Record<string, unknown>) => { success: boolean }
  }
  const current = storage.read?.() ?? {}
  const { customApiEndpoint: _, ...rest } = current
  storage.update?.(rest)
}

// --- Model Profile helpers ---

/**
 * Normalize a model name for profile matching.
 * - Lowercase and trim to avoid case-sensitivity mismatches
 * - Strip [1m] suffix (used for context window signaling, not part of model identity)
 *   so "deepseek-v4-pro" and "deepseek-v4-pro[1m]" match the same profile.
 */
export function normalizeModelName(name: string): string {
  return name.toLowerCase().trim().replace(/\[[12]m\]$/i, '')
}

export function getModelProfile(modelName: string): ModelProfile | undefined {
  const normalized = normalizeModelName(modelName)
  return readCustomApiStorage().modelProfiles?.find(
    p => normalizeModelName(p.model) === normalized,
  )
}

export function saveModelProfile(profile: ModelProfile): void {
  const current = readCustomApiStorage()
  const profiles = current.modelProfiles ?? []
  const normalized = normalizeModelName(profile.model)
  const idx = profiles.findIndex(p => normalizeModelName(p.model) === normalized)
  if (idx >= 0) {
    profiles[idx] = profile
  } else {
    profiles.push(profile)
  }
  writeCustomApiStorage({
    ...current,
    modelProfiles: profiles,
  })
}

/** Read a string env var, return undefined if empty */
function envStr(val: string | undefined): string | undefined {
  return val && val.trim() ? val.trim() : undefined
}

/** Read a numeric env var, return undefined if empty/invalid */
function envNum(val: string | undefined): number | undefined {
  if (!val || !val.trim()) return undefined
  const n = parseInt(val, 10)
  return isNaN(n) ? undefined : n
}

/** Read a boolean-like env var (1 or true) */
function envBool(val: string | undefined): boolean | undefined {
  if (!val || !val.trim()) return undefined
  return val === '1' || val.toLowerCase() === 'true'
}

/**
 * Capture the current process environment into a ModelProfile.
 * Used by /add-model to snapshot all relevant env vars.
 */
export function captureModelProfile(modelName: string): ModelProfile {
  // Detect which auth token env var is actually in use
  let authTokenType: 'DOGE_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | undefined
  let apiKeyValue: string | undefined
  if (envStr(process.env.ANTHROPIC_AUTH_TOKEN)) {
    authTokenType = 'ANTHROPIC_AUTH_TOKEN'
    apiKeyValue = process.env.ANTHROPIC_AUTH_TOKEN
  } else if (envStr(process.env.DOGE_API_KEY)) {
    authTokenType = 'DOGE_API_KEY'
    apiKeyValue = process.env.DOGE_API_KEY
  }

  const provider = process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER as
    | 'anthropic'
    | 'openai'
    | 'responses'
    | undefined

  return {
    model: modelName,
    // Save provider for ALL types including 'anthropic' so switching between
    // different providers can correctly override stale persisted values.
    provider: provider && (provider === 'openai' || provider === 'responses' || provider === 'anthropic') ? provider : undefined,
    baseURL: envStr(process.env.ANTHROPIC_BASE_URL),
    apiKey: apiKeyValue,
    authTokenType,
    contextWindow: envNum(process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOW),
    // Sub-agent models
    defaultOpusModel: envStr(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL),
    defaultSonnetModel: envStr(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL),
    defaultHaikuModel: envStr(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    subagentModel: envStr(process.env.CLAUDE_CODE_SUBAGENT_MODEL),
    opusCapabilities: envStr(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES),
    sonnetCapabilities: envStr(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES),
    // Behavior config
    disableNonessentialTraffic: envBool(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC),
    disableNonstreamingFallback: envBool(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK),
    // NOTE: Do NOT capture CLAUDE_CODE_EFFORT_LEVEL. Effort is a runtime user
    // preference, not model-specific configuration. Capturing it would
    // contaminate the new model's profile with the previous model's effort.
  }
}

/** Helper: set or delete an env var */
function applyEnvVar(name: string, value: string | undefined): void {
  if (value !== undefined && value !== '') {
    process.env[name] = value
  } else {
    delete process.env[name]
  }
}

/**
 * Apply a model profile to the current process environment and customApiStorage.
 * Updates ALL relevant env vars and persists to storage for next launch.
 *
 * CONTRACT (since 2026-06-29, model-switch-fix):
 *  - This function MUST NOT be relied upon to clear env vars the new profile
 *    does not provide. The caller is responsible for calling
 *    `clearProfileEnvVars()` (see `utils/model/switchModelProfile.ts`) BEFORE
 *    invoking this function, so that any whitelisted env var the new profile
 *    omits is left `undefined` rather than retaining a stale value from a
 *    previous profile. Without the pre-clear, switching from a profile that
 *    defines `defaultHaikuModel` to one that does not would leave the old
 *    profile's `ANTHROPIC_DEFAULT_HAIKU_MODEL` in `process.env`, causing
 *    `getDefaultHaikuModel()` alias resolution to land on the wrong tier.
 *  - The canonical caller is `switchModelProfileAtomic` in
 *    `utils/model/switchModelProfile.ts`, which performs snapshot → clear →
 *    apply → persist → commit as an atomic transaction with rollback on
 *    failure. Direct callers outside of that transaction MUST replicate the
 *    clear-then-apply sequence themselves.
 *  - Env vars written here but NOT in `PROFILE_MANAGED_ENV_KEYS` (and hence
 *    not cleared/restored by `clearProfileEnvVars`/`restoreEnvSnapshot`):
 *    `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `DOGE_API_KEY` /
 *    `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_COMPATIBLE_API_PROVIDER`.
 *    `switchModelProfileAtomic` captures these in a second apply-snapshot and
 *    restores them on rollback; standalone callers should be aware they are
 *    mutated.
 */
export function applyModelProfile(profile: ModelProfile): void {
  // --- Core config ---
  process.env.ANTHROPIC_MODEL = profile.model
  applyEnvVar('ANTHROPIC_BASE_URL', profile.baseURL)

  // Apply API key to the correct env var based on authTokenType.
  // When no key is present in the profile, clear both to prevent
  // the previous model's credentials from leaking.
  if (profile.apiKey) {
    if (profile.authTokenType === 'ANTHROPIC_AUTH_TOKEN') {
      process.env.ANTHROPIC_AUTH_TOKEN = profile.apiKey
      delete process.env.DOGE_API_KEY
    } else {
      process.env.DOGE_API_KEY = profile.apiKey
      delete process.env.ANTHROPIC_AUTH_TOKEN
    }
  } else {
    delete process.env.DOGE_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
  }
  applyEnvVar('CLAUDE_CODE_COMPATIBLE_API_PROVIDER', profile.provider)
  applyEnvVar('CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
    profile.contextWindow !== undefined ? String(profile.contextWindow) : undefined)

  // --- Sub-agent models ---
  // When a profile provides tier models, set them.
  // When a profile does NOT provide tier models (undefined), delete the old
  // ones so they inherit from the new main model. This ensures switching
  // from DeepSeek (which has tiers) to GLM (which doesn't) clears the old
  // DeepSeek tiers, causing Opus/Sonnet/Haiku to inherit from glm-5.
  // Switching back to a DeepSeek profile restores its tiers.
  applyEnvVar('ANTHROPIC_DEFAULT_OPUS_MODEL', profile.defaultOpusModel)
  applyEnvVar('ANTHROPIC_DEFAULT_SONNET_MODEL', profile.defaultSonnetModel)
  applyEnvVar('ANTHROPIC_DEFAULT_HAIKU_MODEL', profile.defaultHaikuModel)
  applyEnvVar('CLAUDE_CODE_SUBAGENT_MODEL', profile.subagentModel)
  applyEnvVar('ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES', profile.opusCapabilities)
  applyEnvVar('ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES', profile.sonnetCapabilities)

  // --- Behavior config ---
  applyEnvVar('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    profile.disableNonessentialTraffic ? '1' : undefined)
  applyEnvVar('CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
    profile.disableNonstreamingFallback ? '1' : undefined)
  // NOTE: Do NOT apply CLAUDE_CODE_EFFORT_LEVEL from profile.
  // Effort is a runtime user preference controlled by:
  //   - CLAUDE_CODE_EFFORT_LEVEL env var (set by PS startup scripts)
  //   - /effort command (persisted to settings.json)
  //   - ModelPicker ← → toggle (session-scoped)
  //   - Model default (from getDefaultEffortForModel)
  // Restoring effort from profile would override the user's choice
  // and potentially leak effort from a different model's configuration.

  // --- Persist model name to storage for next launch ---
  // Only update the model name at the top level. Provider, baseURL, apiKey,
  // and authTokenType are managed exclusively by /add-model (explicit save).
  // Writing them here on every /model switch would overwrite the previously
  // saved model's credentials, causing the wrong provider/key to leak across
  // start-script launches. The full profile (including credentials) is stored
  // in modelProfiles[] and applied to process.env for the current session.
  const current = readCustomApiStorage()
  writeCustomApiStorage({
    ...current,
    model: profile.model,
  })
}

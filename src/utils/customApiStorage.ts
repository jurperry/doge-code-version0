import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { saveGlobalConfig } from './config.js'
import { getGlobalClaudeFile } from './env.js'
import { getSecureStorage } from './secureStorage/index.js'
import { clearModelCapabilityOverrideCache } from './model/modelSupportOverrides.js'

export type TierAliasName = 'opus' | 'sonnet' | 'haiku'

/**
 * Persisted tier→model mapping snapshot. Captured from the process env at
 * the moment a tier switch (or profile switch) happens, so a later bare
 * `doge` launch (no start-script env) can restore the tier configuration
 * instead of falling back every tier to the main model.
 */
export type TierModelsSnapshot = {
  opus?: string
  sonnet?: string
  haiku?: string
}

/**
 * Complete model profile that captures ALL environment variables
 * needed to fully switch between different API providers/models.
 */
export type ModelProfile = {
  model: string
  /**
   * User-facing provider name (e.g. "deepseek官方", "glm官方"). Unique across
   * profiles — /provider add enforces this and /model shows it as
   * `Custom model(<providerName>)`. Optional for backward compatibility with
   * profiles saved before the field existed.
   */
  providerName?: string
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
  /**
   * @deprecated Tier selections are session-scoped since the 2026-09-07
   * provider refactor; nothing writes or restores this field anymore. Parsed
   * only so old on-disk payloads stay readable; cleared by
   * clearLegacyTierState().
   */
  activeTier?: TierAliasName
  /**
   * @deprecated Cross-provider global snapshot replaced by per-profile tier
   * fields (defaultOpusModel etc.). Parsed only for backward compatibility;
   * cleared by clearLegacyTierState().
   */
  tierModels?: TierModelsSnapshot
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
  return normalizeCustomApiStorageData(parseCustomApiStorage(raw))
}

function parseCustomApiStorage(raw: object): CustomApiStorageData {
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
    activeTier:
      value.activeTier === 'opus' || value.activeTier === 'sonnet' || value.activeTier === 'haiku'
        ? value.activeTier
        : undefined,
    tierModels:
      value.tierModels && typeof value.tierModels === 'object'
        ? {
            opus: typeof value.tierModels.opus === 'string' ? value.tierModels.opus : undefined,
            sonnet:
              typeof value.tierModels.sonnet === 'string' ? value.tierModels.sonnet : undefined,
            haiku: typeof value.tierModels.haiku === 'string' ? value.tierModels.haiku : undefined,
          }
        : undefined,
  }
}

// --- Provider identity (providerName is THE unique key) ---

/** Case-insensitive comparison key for provider names (trim + lowercase). */
export function normalizeProviderName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Whether two profile objects describe the SAME stored provider entry.
 *
 * Identity is the normalized providerName when both sides have one; profiles
 * saved before the field existed fall back to normalized-model matching.
 *
 * The stored side (`a`) is typically an entry from disk while `b` is the
 * entry being edited — when the user renames the provider AND/OR its main
 * model, the old values on `b` still identify the entry to replace, so
 * edits land in place instead of appending a same-name duplicate.
 */
export function isSameProviderEntry(a: ModelProfile, b: ModelProfile): boolean {
  const an = a.providerName?.trim()
  const bn = b.providerName?.trim()
  if (an && bn) return normalizeProviderName(an) === normalizeProviderName(bn)
  return normalizeModelName(a.model) === normalizeModelName(b.model)
}

/**
 * Collapse duplicate profiles that share a providerName (legacy unnamed
 * profiles group by normalized model instead). Winner per group: the entry
 * whose main model is the active model, else the LAST entry (the most recent
 * edit — the historic duplicate bug appended newer entries after older ones).
 * Order of first occurrences is preserved.
 */
export function dedupeModelProfiles(
  profiles: ModelProfile[],
  activeModel?: string,
): ModelProfile[] {
  if (profiles.length <= 1) return profiles
  const activeKey = activeModel?.trim() ? normalizeModelName(activeModel) : undefined
  type Entry = { winner: ModelProfile; active: boolean }
  const groups: Entry[] = []
  const byKey = new Map<string, Entry>()
  for (const p of profiles) {
    const nameKey = p.providerName?.trim() ? normalizeProviderName(p.providerName) : undefined
    const key = nameKey ? `name:${nameKey}` : `model:${normalizeModelName(p.model)}`
    const isActive = activeKey !== undefined && normalizeModelName(p.model) === activeKey
    const existing = byKey.get(key)
    if (!existing) {
      const entry: Entry = { winner: p, active: isActive }
      byKey.set(key, entry)
      groups.push(entry)
      continue
    }
    // Later occurrence wins unless the kept one is the active entry.
    if (!existing.active) existing.winner = p
    if (isActive) existing.active = true
  }
  if (groups.length === profiles.length) return profiles
  return groups.map(g => g.winner)
}

/**
 * Normalize a parsed storage payload: deduplicate same-providerName profiles
 * and prune savedModels entries orphaned by that dedupe (the dropped
 * duplicates' main models, unless a kept profile still uses them). Returns
 * the input unchanged when there is nothing to repair. Pure — no I/O.
 */
export function normalizeCustomApiStorageData(data: CustomApiStorageData): CustomApiStorageData {
  const profiles = data.modelProfiles ?? []
  if (profiles.length <= 1) return data
  const kept = dedupeModelProfiles(profiles, data.model)
  if (kept.length === profiles.length) return data
  const dropped = profiles.filter(p => !kept.includes(p))
  const droppedKeys = new Set(dropped.map(p => normalizeModelName(p.model)))
  const keptKeys = new Set(kept.map(p => normalizeModelName(p.model)))
  const savedModels = (data.savedModels ?? []).filter(
    m => !droppedKeys.has(normalizeModelName(m)) || keptKeys.has(normalizeModelName(m)),
  )
  return { ...data, modelProfiles: kept, savedModels }
}

/**
 * One-time startup migration: physically repair stores corrupted by the
 * historic duplicate-provider bug (editing a provider and renaming its main
 * model appended a second profile with the same providerName instead of
 * replacing the old one). Dedupes customApiEndpoint.modelProfiles/savedModels
 * in BOTH secure storage (~/.doge/.credentials.json) and the ~/.doge/.claude.json
 * mirror — the .claude.json copy is written directly via fs because the
 * saveGlobalConfig guard is not unlocked this early in startup.
 *
 * Idempotent: no-op (and no write) when no duplicates exist. Must run before
 * restoreTierStateFromStorage so the credential heal reads repaired data.
 * Returns true when a repair write happened.
 */
export function migrateDuplicateProviderProfiles(): boolean {
  let changed = false

  const storage = getSecureStorage() as {
    read?: () => Record<string, unknown> | null
    update?: (data: Record<string, unknown>) => { success: boolean }
  }
  const data = storage.read?.() ?? {}
  const raw = data[CUSTOM_API_STORAGE_KEY]
  let normalized: CustomApiStorageData | undefined
  if (raw && typeof raw === 'object') {
    const parsed = parseCustomApiStorage(raw)
    normalized = normalizeCustomApiStorageData(parsed)
    if (normalized !== parsed) {
      storage.update?.({ ...data, [CUSTOM_API_STORAGE_KEY]: normalized })
      changed = true
    }
  }

  try {
    const claudeFile = getGlobalClaudeFile()
    const config = JSON.parse(readFileSync(claudeFile, 'utf8')) as Record<string, unknown>
    const ep = config[CUSTOM_API_STORAGE_KEY]
    if (ep && typeof ep === 'object') {
      if (normalized) {
        // The .claude.json copy is a MIRROR of secure storage: align its
        // profiles/savedModels with the normalized source of truth. Deduping
        // only the credentials side leaves the mirror's copy of a dropped
        // duplicate's model as a phantom /provider menu row (the mirror may
        // legitimately have fewer profiles than the pre-migration store, so
        // its own "no duplicates" fast path never prunes it).
        if (
          JSON.stringify(ep.modelProfiles) !== JSON.stringify(normalized.modelProfiles) ||
          JSON.stringify(ep.savedModels) !== JSON.stringify(normalized.savedModels)
        ) {
          config[CUSTOM_API_STORAGE_KEY] = {
            ...ep,
            modelProfiles: normalized.modelProfiles ?? [],
            savedModels: normalized.savedModels ?? [],
          }
          writeAtomicJson(claudeFile, config)
          changed = true
        }
      } else {
        // No secure-storage payload to align with — normalize the mirror
        // standalone (it may predate the credentials store).
        const parsed = parseCustomApiStorage(ep)
        const mirrorNormalized = normalizeCustomApiStorageData(parsed)
        if (mirrorNormalized !== parsed) {
          config[CUSTOM_API_STORAGE_KEY] = mirrorNormalized
          writeAtomicJson(claudeFile, config)
          changed = true
        }
      }
    }
  } catch {
    // Missing/unreadable .claude.json — secure storage is the source of truth.
  }

  return changed
}

/** tmp + rename write, so a crash mid-migration can't truncate the config. */
function writeAtomicJson(path: string, data: unknown): void {
  const tmp = `${path}.doge-tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

// --- Tier selection persistence ---

/**
 * Self-heal: restore top-level credentials in SECURE STORAGE from the active
 * model's profile when they are missing or diverge from it.
 *
 * Profile switches historically wiped the top-level provider/baseURL/apiKey
 * (switchModelProfileAtomic's clearCredentials=true), which left a bare
 * `doge` launch — no start-script env — with no credentials at all
 * ("Not logged in · Run /login"). The wipe was masked for a long time by the
 * tier-switch path re-persisting credentials as a side effect. This heal runs
 * at startup (restoreTierState) and repairs already-wiped installs from the
 * intact modelProfiles entries.
 *
 * Deliberately writes ONLY secure storage:
 *  - Secure storage is the auth source of truth (getAnthropicApiKeyWithSource
 *    reads it first); the .claude.json copy is a fallback that re-syncs on
 *    the next interactive model operation.
 *  - At startup the global-config guard is not yet unlocked (enableConfigs),
 *    so touching saveGlobalConfig here would crash the CLI before main().
 *
 * Returns true if a repair write happened.
 */
export function healStoredCredentials(): boolean {
  const current = readCustomApiStorage()
  const model = current.model?.trim()
  if (!model) return false
  const profile = getModelProfile(model)
  if (!profile?.apiKey) return false

  const credsMatch =
    current.apiKey === profile.apiKey &&
    current.provider === profile.provider &&
    current.baseURL === profile.baseURL &&
    current.authTokenType === profile.authTokenType
  if (credsMatch) return false

  writeCustomApiStorage({
    ...current,
    provider: profile.provider,
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
    authTokenType: profile.authTokenType,
  })
  return true
}

/**
 * Remove the deprecated global tier state (activeTier / tierModels) from BOTH
 * config stores. Tier selections are session-scoped since the 2026-09-07
 * provider refactor: persisting them globally forced every other terminal
 * (and every new `doge` launch) onto one terminal's Opus/Sonnet/Haiku choice
 * — the cross-terminal "custom model pollution" bug. Tier→model mappings now
 * live exclusively on each ModelProfile's default{Opus,Sonnet,Haiku}Model
 * fields and are injected into env at startup by restoreTierState.
 *
 * No-op when no legacy fields are present. Runtime-safe only (uses
 * saveGlobalConfig — do NOT call before enableConfigs(); startup cleanup
 * writes secure storage directly instead).
 */
export function clearLegacyTierState(): void {
  const current = readCustomApiStorage()
  if (current.activeTier === undefined && current.tierModels === undefined) return

  writeCustomApiStorage({
    ...current,
    activeTier: undefined,
    tierModels: undefined,
  })
  saveGlobalConfig(cfg => ({
    ...cfg,
    customApiEndpoint: {
      ...(cfg.customApiEndpoint ?? {}),
      activeTier: undefined,
      tierModels: undefined,
    },
  }))
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
export function applyModelProfile(profile: ModelProfile, opts?: { persist?: boolean }): void {
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
  // Tier env changed — drop memoized capability overrides (the memo key does
  // not include env state, see modelSupportOverrides).
  clearModelCapabilityOverrideCache()

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
  // and authTokenType are managed exclusively by /provider add (explicit save).
  // Writing them here on every /model switch would overwrite the previously
  // saved model's credentials, causing the wrong provider/key to leak across
  // start-script launches. The full profile (including credentials) is stored
  // in modelProfiles[] and applied to process.env for the current session.
  // A profile switch selects a NEW main model, so any legacy global tier
  // selection/snapshot is cleared as well (tiers are session-scoped; the
  // tier mapping lives on the profile itself).
  // Session-scoped switches (multi-terminal isolation) skip this block:
  // disk stays at the global baseline so other terminals are unaffected.
  if (opts?.persist === false) return
  const current = readCustomApiStorage()
  writeCustomApiStorage({
    ...current,
    model: profile.model,
    activeTier: undefined,
    tierModels: undefined,
  })
}

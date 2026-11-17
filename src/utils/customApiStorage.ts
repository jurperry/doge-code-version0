import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getGlobalClaudeFile } from './env.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  readCatalogEndpoint,
  readModelCatalog,
  writeCatalogFromEndpoint,
  writeModelCatalog,
  type CatalogEndpoint,
  type CatalogProfile,
  type CatalogModel,
} from './model/modelCatalog.js'
import { ACTIVE_PROFILE_ENV, getProfileId, matchModelProfile } from './model/profileIdentity.js'
import { getModelEnvironment, readModelApiStorage } from './model/runtimeModelContext.js'

export type TierAliasName = 'opus' | 'sonnet' | 'haiku'

/**
 * Complete model profile that captures ALL environment variables
 * needed to fully switch between different API providers/models.
 */
export type ModelProfile = {
  id?: string
  /** Catalog connection/model identity (derived; never persisted here). */
  connectionId?: string
  catalogModelId?: string
  models?: CatalogModel[]
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
}

export type CustomApiStorageData = {
  activeProfileId?: string
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

function secureEndpoint(): CatalogEndpoint {
  const storage = getSecureStorage() as {
    read?: () => Record<string, unknown> | null
    update?: (data: Record<string, unknown>) => { success: boolean }
  }
  const raw = storage.read?.()?.[CUSTOM_API_STORAGE_KEY]
  return raw && typeof raw === 'object' ? (raw as CatalogEndpoint) : {}
}

function scrubLegacyModelConfig(): void {
  const storage = getSecureStorage() as {
    read?: () => Record<string, unknown> | null
    update?: (data: Record<string, unknown>) => { success: boolean }
  }
  const data = storage.read?.() ?? {}
  if (CUSTOM_API_STORAGE_KEY in data) {
    const { [CUSTOM_API_STORAGE_KEY]: _legacy, ...rest } = data
    storage.update?.(rest)
  }

  // .claude.json mirror is no longer source of truth. Write it directly here:
  // startup migration runs before the global-config auth guard is unlocked.
  // Scrub it even when secure storage has no customApiEndpoint key.
  try {
    const file = getGlobalClaudeFile()
    const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (CUSTOM_API_STORAGE_KEY in config) {
      delete config[CUSTOM_API_STORAGE_KEY]
      const tmp = `${file}.doge-tmp`
      writeFileSync(tmp, `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
    }
  } catch {
    // A missing/locked legacy mirror is harmless; the catalog is authoritative.
  }

  try {
    const hasCatalogModels = Boolean(readModelCatalog()?.connections.some(connection => connection.models.length > 0))
    if (!hasCatalogModels) return
    const settingsFile = join(dirname(getGlobalClaudeFile()), 'settings.json')
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
    if ('model' in settings) {
      delete settings.model
      const tmp = `${settingsFile}.doge-tmp`
      writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      renameSync(tmp, settingsFile)
    }
  } catch {
    // No settings file yet.
  }
}

/**
 * One-time upgrade: old `.credentials`/`.claude` customApiEndpoint →
 * model-catalog.json, then remove the legacy model config from both stores.
 * Never fall back to the old stores once the catalog exists.
 */
function legacyGlobalEndpoint(): CatalogEndpoint {
  try {
    const raw = JSON.parse(readFileSync(getGlobalClaudeFile(), 'utf8')) as {
      customApiEndpoint?: CatalogEndpoint
    }
    return raw.customApiEndpoint && typeof raw.customApiEndpoint === 'object'
      ? raw.customApiEndpoint
      : {}
  } catch {
    return {}
  }
}

let legacyScrubChecked = false

function ensureCatalogMigrated(): void {
  if (readModelCatalog()) {
    // A catalog exists: legacy model config is never a runtime fallback.
    // Scrub once per process (hot path: readCustomApiStorage is called per request).
    if (!legacyScrubChecked) {
      scrubLegacyModelConfig()
      legacyScrubChecked = true
    }
    return
  }
  const secure = secureEndpoint()
  const legacy: CatalogEndpoint = { ...legacyGlobalEndpoint(), ...secure }
  if (!legacy.modelProfiles?.length && !legacy.model?.trim()) return
  writeCatalogFromEndpoint(legacy)
  scrubLegacyModelConfig()
  legacyScrubChecked = true
}

export function readCustomApiStorage(): CustomApiStorageData {
  ensureCatalogMigrated()
  return normalizeCustomApiStorageData((readCatalogEndpoint() ?? {}) as unknown as CustomApiStorageData)
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
  if (a.id && b.id) return a.id === b.id
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
export function migrateLegacyModelConfig(): boolean {
  const hadCatalog = Boolean(readModelCatalog())
  ensureCatalogMigrated()
  return !hadCatalog && Boolean(readModelCatalog())
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
/** Persist the in-memory connection view into the unified catalog. */
export function writeCustomApiStorage(next: CustomApiStorageData): void {
  ensureCatalogMigrated()
  writeCatalogFromEndpoint(next as unknown as CatalogEndpoint)
}

export function clearCustomApiStorage(): void {
  writeModelCatalog({ version: 2, connections: [] })
  scrubLegacyModelConfig()
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
  return matchModelProfile(readModelApiStorage().modelProfiles ?? [], modelName, getModelEnvironment())
}

/** The catalog is the single source; keep the old API as a thin alias. */
export function readMergedCustomApiStorage(): CustomApiStorageData {
  return readCustomApiStorage()
}

/**
 * Pure mapping: ModelProfile → the env-var patch that fully selects that
 * provider for a process. Single source shared by applyModelProfile() (which
 * mutates process.env in place) and the workflow engine's cross-API steps
 * (which build an isolated child env without touching the parent).
 * Keys mapped to undefined (or '') mean "delete".
 */
export function modelProfileEnvPatch(
  profile: ModelProfile,
): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {
    [ACTIVE_PROFILE_ENV]: getProfileId(profile),
    DOGE_ACTIVE_CONNECTION_ID: profile.connectionId,
    DOGE_ACTIVE_MODEL_ID: profile.catalogModelId,
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_BASE_URL: profile.baseURL,
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER: profile.provider,
    CLAUDE_CODE_MODEL_CONTEXT_WINDOW:
      profile.contextWindow !== undefined
        ? String(profile.contextWindow)
        : undefined,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.defaultOpusModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.defaultSonnetModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.defaultHaikuModel,
    CLAUDE_CODE_SUBAGENT_MODEL: profile.subagentModel,
  }
  if (profile.apiKey) {
    if (profile.authTokenType === 'ANTHROPIC_AUTH_TOKEN') {
      patch.ANTHROPIC_AUTH_TOKEN = profile.apiKey
      patch.DOGE_API_KEY = undefined
    } else {
      patch.DOGE_API_KEY = profile.apiKey
      patch.ANTHROPIC_AUTH_TOKEN = undefined
    }
  } else {
    patch.ANTHROPIC_AUTH_TOKEN = undefined
    patch.DOGE_API_KEY = undefined
  }
  return patch
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
  // --- Core config, credentials, tier models and behavior flags ---
  // modelProfileEnvPatch is the single source for the env mapping; applying
  // it here mutates process.env in place (undefined/'' → delete). The
  // call-site contract above (clearProfileEnvVars before apply) is unchanged.
  for (const [name, value] of Object.entries(modelProfileEnvPatch(profile))) {
    if (value !== undefined && value !== '') {
      process.env[name] = value
    } else {
      delete process.env[name]
    }
  }
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
    activeProfileId: getProfileId(profile),
  })
}

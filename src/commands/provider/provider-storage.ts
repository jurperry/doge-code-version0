import { randomUUID } from 'node:crypto'
import { saveGlobalConfig } from '../../utils/config.js'
import {
  isSameProviderEntry,
  normalizeModelName,
  normalizeProviderName,
  readCustomApiStorage,
  writeCustomApiStorage,
  type CustomApiStorageData,
  type ModelProfile,
} from '../../utils/customApiStorage.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { switchModelProfileAtomicBound } from '../../utils/model/switchModelProfile.bindings.js'
import { getProfileId } from '../../utils/model/profileIdentity.js'

/** API format used at the protocol-conversion boundary. */
export type ProviderFormat = 'anthropic' | 'openai' | 'responses'

/** Which env var / header style the key is sent with. */
export type AuthTokenType = 'DOGE_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'

/** Values collected by the /provider add form. */
export type ProviderFormValues = {
  /** User-facing provider name, e.g. "deepseek官方". Unique across profiles. */
  providerName?: string
  provider: ProviderFormat
  baseURL?: string
  apiKey?: string
  /** Defaults to DOGE_API_KEY (x-api-key header). */
  authTokenType?: AuthTokenType
  model: string
  /** Context window override, typed as text in the form (e.g. "200000"). */
  contextWindow?: string
  opusModel?: string
  sonnetModel?: string
  haikuModel?: string
}

/** Case-insensitive comparison key for provider names. */
export { normalizeProviderName }

/**
 * Find a DIFFERENT profile already using this provider name.
 * `self` (the stored entry being edited, identified by its ORIGINAL name /
 * model so renames still match) is excluded so re-saving or renaming an
 * existing provider with its own name is allowed.
 */
export function findProviderNameConflict(
  providerName: string,
  profiles: ModelProfile[],
  self?: ModelProfile,
): ModelProfile | undefined {
  const key = normalizeProviderName(providerName)
  if (!key) return undefined
  return profiles.find(
    p =>
      p.providerName !== undefined &&
      normalizeProviderName(p.providerName) === key &&
      !(self && isSameProviderEntry(p, self)),
  )
}

/**
 * Validate form values. Returns an error message, or undefined when valid.
 * `profiles`/`self` power the provider-name uniqueness check — pass
 * them wherever available; the form re-validates on save as the final gate.
 */
export function validateProviderForm(
  values: ProviderFormValues,
  profiles: ModelProfile[] = [],
  self?: ModelProfile,
): string | undefined {
  if (!values.providerName?.trim()) return 'Provider name is required (e.g. deepseek官方).'
  const conflict = findProviderNameConflict(values.providerName, profiles, self)
  if (conflict) {
    return `Provider name '${values.providerName.trim()}' is already used by ${conflict.model}. Provider names must be unique.`
  }
  if (!values.model?.trim()) return 'Main model is required.'
  if (!values.apiKey?.trim()) return 'API key is required.'
  if (values.provider !== 'anthropic' && !values.baseURL?.trim()) {
    return `Base URL is required for ${values.provider} providers.`
  }
  const cw = values.contextWindow?.trim()
  if (cw) {
    const n = Number(cw)
    if (!Number.isInteger(n) || n <= 0) {
      return 'Context window must be a positive integer (tokens), e.g. 200000.'
    }
  }
  return undefined
}

/** Build the ModelProfile persisted by /provider add from form values. */
export function buildModelProfile(values: ProviderFormValues): ModelProfile {
  const cw = values.contextWindow?.trim()
  return {
    model: values.model.trim(),
    providerName: values.providerName?.trim() || undefined,
    provider: values.provider,
    baseURL: values.baseURL?.trim() || undefined,
    apiKey: values.apiKey?.trim() || undefined,
    // The form explicitly picks which header style the endpoint expects:
    // DOGE_API_KEY → x-api-key, ANTHROPIC_AUTH_TOKEN → Authorization: Bearer.
    authTokenType: values.authTokenType ?? 'DOGE_API_KEY',
    contextWindow: cw ? Number(cw) : undefined,
    defaultOpusModel: values.opusModel?.trim() || undefined,
    defaultSonnetModel: values.sonnetModel?.trim() || undefined,
    defaultHaikuModel: values.haikuModel?.trim() || undefined,
  }
}

/** Mask a secret for display: keep a short head/tail, elide the middle. */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return '(not set)'
  if (secret.length <= 8) return `${secret.slice(0, 2)}…`
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`
}

/** Dedupe savedModels against `next` using normalized names ([1m]/[2m]- and case-insensitive). */
export function dedupeSavedModels(existing: string[], next: string): string[] {
  const normalized = normalizeModelName(next)
  return [...existing.filter(m => normalizeModelName(m) !== normalized), next]
}

/**
 * Upsert a profile into the profiles list.
 *
 * providerName is the identity (legacy unnamed profiles fall back to
 * normalized-model matching via isSameProviderEntry). `self` is the stored
 * entry being edited, identified by its ORIGINAL providerName/model — when
 * the user renames the provider and/or its main model, the upsert replaces
 * the old entry in place instead of appending a same-name duplicate.
 */
export function upsertModelProfile(
  profiles: ModelProfile[],
  profile: ModelProfile,
  self?: ModelProfile,
): ModelProfile[] {
  const selfIdx = self ? profiles.findIndex(p => isSameProviderEntry(p, self)) : -1
  const idx = selfIdx >= 0 ? selfIdx : profiles.findIndex(p => isSameProviderEntry(p, profile))
  if (idx < 0) return [...profiles, profile]
  const next = [...profiles]
  next[idx] = { ...profile, ...(profiles[idx]?.id ? { id: profiles[idx]!.id } : {}) }
  return next
}

export type ProviderSaveDeps = {
  readStorage: () => CustomApiStorageData
  writeStorage: (data: CustomApiStorageData) => void
  saveGlobalConfig: (updater: (current: any) => any) => void
  updateSettings: (patch: { model: string }) => void
  switchAtomic: (
    profile: ModelProfile,
    deps: {
      syncToDisk: (model: string, clearCredentials: boolean) => void
      commitAppState: (updater: (prev: any) => any) => void
    },
  ) => Promise<void>
}

export function defaultProviderSaveDeps(): ProviderSaveDeps {
  return {
    readStorage: readCustomApiStorage,
    writeStorage: writeCustomApiStorage,
    saveGlobalConfig,
    updateSettings: patch => updateSettingsForSource('userSettings', patch),
    switchAtomic: (profile, deps) =>
      switchModelProfileAtomicBound(profile, {
        syncToDisk: deps.syncToDisk,
        setAppState: updater => deps.commitAppState(updater),
      }),
  }
}

/**
 * Persist a provider profile and switch the current session to it.
 *
 * Two-phase, mirroring the contracts of the commands it replaces:
 *  1. Explicit save (old /add-model contract): upsert into modelProfiles,
 *     dedupe savedModels, and persist the profile's credentials to the
 *     top-level customApiEndpoint so a bare `doge` restart recovers them.
 *  2. Atomic activation (old /model contract): switchModelProfileAtomic
 *     clears profile-managed env vars, applies the new profile, syncs disk,
 *     and commits AppState with rollback on failure.
 */
export async function saveAndActivateProvider(
  profile: ModelProfile,
  deps: ProviderSaveDeps,
  setAppState: (updater: (prev: any) => any) => void,
  self?: ModelProfile,
): Promise<void> {
  const stored = deps.readStorage()
  const anchor = self ?? (stored.modelProfiles ?? []).find(p => isSameProviderEntry(p, profile))
  profile = { ...profile, id: anchor ? getProfileId(anchor) : profile.id ?? randomUUID() }
  const modelProfiles = upsertModelProfile(stored.modelProfiles ?? [], profile, self)
  // The replaced entry's OLD main model must leave savedModels (the
  // /provider menu is driven by savedModels) unless a remaining profile
  // still uses it — otherwise the rename leaves an orphan duplicate row.
  const priorProfiles = stored.modelProfiles ?? []
  const replaced =
    self !== undefined
      ? priorProfiles.find(p => isSameProviderEntry(p, self))
      : priorProfiles.find(p => isSameProviderEntry(p, profile))
  let savedModels = stored.savedModels ?? []
  if (replaced && normalizeModelName(replaced.model) !== normalizeModelName(profile.model)) {
    const oldKey = normalizeModelName(replaced.model)
    const stillUsed = modelProfiles.some(p => normalizeModelName(p.model) === oldKey)
    if (!stillUsed) {
      savedModels = savedModels.filter(m => normalizeModelName(m) !== oldKey)
    }
  }
  savedModels = dedupeSavedModels(savedModels, profile.model)
  const credentials = {
    activeProfileId: profile.id,
    provider: profile.provider,
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
    authTokenType: profile.authTokenType,
  }

  deps.saveGlobalConfig(current => ({
    ...current,
    customApiEndpoint: {
      ...current.customApiEndpoint,
      model: profile.model,
      savedModels,
      // Keep the .claude.json mirror's profile list in sync too — it used to
      // stay stale (the credentials store is the source of truth, but the
      // startup dedupe migration then has to repair the mirror every boot).
      modelProfiles,
      ...credentials,
    },
  }))
  // Re-read after saveGlobalConfig: it may have merged concurrent changes.
  deps.writeStorage({
    ...deps.readStorage(),
    model: profile.model,
    savedModels,
    modelProfiles,
    ...credentials,
  })
  deps.updateSettings({ model: profile.model })

  await deps.switchAtomic(profile, {
    // Unlike the /model switch (whose syncToDisk clears top-level
    // credentials), /provider add is an explicit save: keep the credentials
    // written above on disk, only move the model field forward.
    syncToDisk: model => {
      deps.saveGlobalConfig(current => ({
        ...current,
        customApiEndpoint: { ...current.customApiEndpoint, model },
      }))
      deps.updateSettings({ model })
    },
    commitAppState: updater => setAppState(prev => updater(prev)),
  })
}

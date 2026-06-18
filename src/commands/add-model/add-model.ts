import type { LocalCommandCall } from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { captureModelProfile, normalizeModelName, readCustomApiStorage, writeCustomApiStorage } from '../../utils/customApiStorage.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export const call: LocalCommandCall = async (args, _context) => {
  const nextModel = args.trim()
  if (!nextModel) {
    return {
      type: 'text',
      value: 'Usage: /add-model <model-name>',
    }
  }

  // Single read at start — all data computed in memory, then written once.
  const stored = readCustomApiStorage()

  // Capture ALL current environment variables into a complete profile
  const profile = captureModelProfile(nextModel)

  // Compute deduplicated savedModels (normalize strips [1m]/[2m] suffix)
  const normalizedNext = normalizeModelName(nextModel)
  const existingSaved = stored.savedModels ?? []
  const dedupedSaved = [
    ...existingSaved.filter(m => normalizeModelName(m) !== normalizedNext),
    nextModel,
  ]

  // Upsert profile into modelProfiles
  const profiles = stored.modelProfiles ?? []
  const profileIdx = profiles.findIndex(p => normalizeModelName(p.model) === normalizedNext)
  if (profileIdx >= 0) {
    profiles[profileIdx] = profile
  } else {
    profiles.push(profile)
  }

  // Persist to all three config files
  saveGlobalConfig(current => ({
    ...current,
    customApiEndpoint: {
      ...current.customApiEndpoint,
      model: nextModel,
      savedModels: dedupedSaved,
    },
  }))

  writeCustomApiStorage({
    ...stored,
    model: nextModel,
    savedModels: dedupedSaved,
    modelProfiles: profiles,
    provider: profile.provider ?? stored.provider,
    baseURL: profile.baseURL ?? stored.baseURL,
    apiKey: profile.apiKey ?? stored.apiKey,
    authTokenType: profile.authTokenType ?? stored.authTokenType,
  })

  updateSettingsForSource('userSettings', { model: nextModel })

  process.env.ANTHROPIC_MODEL = nextModel

  return {
    type: 'text',
    value: `Added custom model: ${nextModel}`,
  }
}

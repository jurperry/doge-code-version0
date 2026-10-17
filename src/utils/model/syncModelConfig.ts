import { saveGlobalConfig } from '../config.js'
import {
  getModelProfile,
  readCustomApiStorage,
  writeCustomApiStorage,
  type ModelProfile,
} from '../customApiStorage.js'
import { updateSettingsForSource } from '../settings/settings.js'
import { getProfileId } from './profileIdentity.js'

/**
 * Persist a model change to .claude.json (mirror), secure storage and
 * settings.json so all three config files stay in sync. Writing a new main
 * model invalidates any tier selection (activeTier), since the tier mapping
 * belonged to the previous main model.
 *
 * Moved verbatim out of the compiled artifact src/commands/model/model.tsx so
 * every switch entry point (the /model command, the inline ModelPicker in
 * PromptInput, and headless set_model in global scope) persists through ONE
 * implementation — per-entry copies of this logic are how the inline picker
 * ended up switching models without switching provider env at all.
 */
export function syncModelConfigToDisk(
  model: string,
  clearCredentials?: boolean,
  credentialSourceProfile?: ModelProfile,
): void {
  const profile = credentialSourceProfile ?? getModelProfile(model)
  let credsUpdate: Record<string, unknown> = { activeProfileId: undefined }

  if (clearCredentials) {
    credsUpdate = { activeProfileId: undefined, provider: undefined, baseURL: undefined, apiKey: undefined, authTokenType: undefined }
  } else if (profile) {
    credsUpdate = {
      activeProfileId: getProfileId(profile),
      provider: profile.provider,
      baseURL: profile.baseURL,
      apiKey: profile.apiKey,
      authTokenType: profile.authTokenType,
    }
  }

  saveGlobalConfig(current => ({
    ...current,
    customApiEndpoint: {
      ...current.customApiEndpoint,
      model,
      // Tiers are session-scoped; scrub deprecated global tier state on write.
      activeTier: undefined,
      tierModels: undefined,
      ...credsUpdate,
    },
  }))
  updateSettingsForSource('userSettings', { model })

  const currentStorage = readCustomApiStorage()
  writeCustomApiStorage({
    ...currentStorage,
    model,
    activeTier: undefined,
    tierModels: undefined,
    ...credsUpdate,
  })
}

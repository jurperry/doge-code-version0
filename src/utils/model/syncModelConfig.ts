import {
  getModelProfile,
  readCustomApiStorage,
  writeCustomApiStorage,
  type ModelProfile,
} from '../customApiStorage.js'
import { getProfileId } from './profileIdentity.js'
import { updateSettingsForSource } from '../settings/settings.js'

/**
 * Persist a model change to the unified catalog. Session-scoped switches
 * don't call this; only global/default changes do.
 */
export function syncModelConfigToDisk(
  model: string,
  _clearCredentials?: boolean,
  credentialSourceProfile?: ModelProfile,
): void {
  const profile = credentialSourceProfile ?? getModelProfile(model)
  if (!profile) {
    // First-party users keep their default in settings.json.model.
    updateSettingsForSource('userSettings', { model })
    return
  }
  const currentStorage = readCustomApiStorage()
  writeCustomApiStorage({
    ...currentStorage,
    model,
    activeProfileId: getProfileId(profile),
  })
}

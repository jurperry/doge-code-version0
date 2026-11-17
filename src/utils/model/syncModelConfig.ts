import {
  getModelProfile,
  normalizeModelName,
  type ModelProfile,
} from '../customApiStorage.js'
import { readModelCatalog, writeModelCatalog } from './modelCatalog.js'
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
  if (!persistCatalogModelSelection(model, credentialSourceProfile)) {
    updateSettingsForSource('userSettings', { model })
  }
}

export function persistCatalogModelSelection(model: string, profile = getModelProfile(model)): boolean {
  if (!profile) return false
  const catalog = readModelCatalog()
  const connection = catalog?.connections.find(c => c.id === getProfileId(profile))
  const selected = connection?.models.find(m => normalizeModelName(m.upstreamModel) === normalizeModelName(profile.model))
  if (!catalog || !connection || !selected) throw new Error('The selected model is no longer in the catalog.')
  if (connection.defaultModelId === selected.id && catalog.defaultModel?.connectionId === connection.id &&
    catalog.defaultModel.modelId === selected.id) return true
  writeModelCatalog({
    ...catalog,
    connections: catalog.connections.map(c => c.id === connection.id ? { ...c, defaultModelId: selected.id } : c),
    defaultModel: { connectionId: connection.id, modelId: selected.id },
  })
  return true
}

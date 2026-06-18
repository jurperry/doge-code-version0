import type { LocalCommandCall } from '../../types/command.js'
import { saveGlobalConfig, getGlobalConfig } from '../../utils/config.js'
import { applyModelProfile, getModelProfile, normalizeModelName, readCustomApiStorage, writeCustomApiStorage } from '../../utils/customApiStorage.js'
import { formatCustomModelLabel } from '../../utils/model/model.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export const call: LocalCommandCall = async (args, _context) => {
  const targetModel = args.trim()
  if (!targetModel) {
    const storage = readCustomApiStorage()
    const configModels = getGlobalConfig().customApiEndpoint?.savedModels ?? []
    const storageModels = storage.savedModels ?? []
    const allSaved = [...new Set([...configModels, ...storageModels].map(normalizeModelName))].filter(Boolean)
    if (allSaved.length === 0) {
      return {
        type: 'text',
        value: 'No saved models.',
      }
    }
    // Show models from both config and storage, deduplicated
    const currentModel = storage.model ?? getGlobalConfig().customApiEndpoint?.model
    const list = allSaved.map((m, i) => {
      const marker = normalizeModelName(currentModel ?? '') === normalizeModelName(m) ? ' (current)' : ''
      return `${i + 1}. ${formatCustomModelLabel(m)}${marker}`
    }).join('\n')
    return {
      type: 'text',
      value: `Saved models:\n${list}\n\nUse /remove-model <name> to remove a model.`,
    }
  }

  const currentConfig = getGlobalConfig()
  const secureStored = readCustomApiStorage()

  // Merge savedModels from both .claude.json and .credentials.json.
  // These can diverge if modified externally. Use the union so existence
  // checks and the last-model guard see the full picture.
  const configModels = currentConfig.customApiEndpoint?.savedModels ?? []
  const storageModels = secureStored.savedModels ?? []
  // Merge and deduplicate using normalized names (case-insensitive + [1m] suffix stripped)
  const savedModels = [...new Set(
    [...configModels, ...storageModels].map(normalizeModelName),
  )].filter(Boolean)
  const targetNormalized = normalizeModelName(targetModel)
  if (!savedModels.some(m => normalizeModelName(m) === targetNormalized)) {
    return {
      type: 'text',
      value: `Model not found in saved list: ${targetModel}`,
    }
  }

  // Guard: refuse to delete the last saved model. At least one model must
  // remain so the user always has a valid fallback with credentials.
  if (savedModels.length <= 1) {
    return {
      type: 'text',
      value: `Cannot remove the last saved model. Use /add-model to add another model first.`,
    }
  }

  const remainingModels = savedModels.filter(
    model => normalizeModelName(model) !== targetNormalized,
  )
  const currentModel = secureStored.model ?? currentConfig.customApiEndpoint?.model
  const isRemovingCurrent =
    normalizeModelName(currentModel ?? '') === targetNormalized
  const nextCurrentModel =
    isRemovingCurrent ? (remainingModels[0] ?? undefined) : currentModel

  saveGlobalConfig(current => ({
    ...current,
    customApiEndpoint: {
      ...current.customApiEndpoint,
      model: nextCurrentModel,
      savedModels: remainingModels,
    },
  }))
  // Re-read .credentials.json after saveGlobalConfig to ensure we have latest
  // state for modelProfiles — saveModelProfile may have been called elsewhere.
  const freshStored = readCustomApiStorage()
  // Also remove the model profile if it exists (uses normalizeModelName for matching)
  const remainingProfiles = (freshStored.modelProfiles ?? []).filter(
    p => normalizeModelName(p.model) !== targetNormalized,
  )

  // Build the storage update. We'll finalize it after env-var cleanup below.
  const storageUpdate: Record<string, unknown> = {
    model: nextCurrentModel,
    savedModels: remainingModels,
    modelProfiles: remainingProfiles,
  }

  if (isRemovingCurrent) {
    if (nextCurrentModel) {
      // Apply the fallback model's full profile so all env vars
      // (provider, key, baseURL, sub-agents, etc.) switch atomically.
      const fallbackProfile = getModelProfile(nextCurrentModel)
      if (fallbackProfile) {
        applyModelProfile(fallbackProfile)
        // applyModelProfile wrote model/provider/baseURL/apiKey to storage,
        // but NOT savedModels/modelProfiles. Re-read and write the cleaned
        // list so .credentials.json stays consistent.
        const postApply = readCustomApiStorage()
        writeCustomApiStorage({ ...postApply, ...storageUpdate })
      } else {
        // No stored profile — just set model name, clear all credentials
        // so the removed model's keys don't leak into env or storage.
        process.env.ANTHROPIC_MODEL = nextCurrentModel
        delete process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
        delete process.env.DOGE_API_KEY
        delete process.env.ANTHROPIC_AUTH_TOKEN
        delete process.env.ANTHROPIC_BASE_URL
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOW
        // Clear storage credentials too
        storageUpdate.provider = undefined
        storageUpdate.baseURL = undefined
        storageUpdate.apiKey = undefined
        writeCustomApiStorage({ ...freshStored, ...storageUpdate })
      }
      updateSettingsForSource('userSettings', { model: nextCurrentModel })
    } else {
      // Should not reach here due to last-model guard, but clean up fully
      delete process.env.ANTHROPIC_MODEL
      delete process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
      delete process.env.DOGE_API_KEY
      delete process.env.ANTHROPIC_AUTH_TOKEN
      delete process.env.ANTHROPIC_BASE_URL
      storageUpdate.provider = undefined
      storageUpdate.baseURL = undefined
      storageUpdate.apiKey = undefined
      writeCustomApiStorage({ ...freshStored, ...storageUpdate })
    }
  } else {
    // Not the current model — just remove from storage
    writeCustomApiStorage({ ...freshStored, ...storageUpdate })
  }

  return {
    type: 'text',
    value: `Removed custom model: ${targetModel}`,
  }
}

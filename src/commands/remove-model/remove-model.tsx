import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { Select } from '../../components/CustomSelect/index.js';
import { saveGlobalConfig, getGlobalConfig } from '../../utils/config.js';
import {
  applyModelProfile,
  getModelProfile,
  normalizeModelName,
  readCustomApiStorage,
  writeCustomApiStorage,
  type ModelProfile,
} from '../../utils/customApiStorage.js';
import { formatCustomModelLabel } from '../../utils/model/model.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

/**
 * Build a map from sub-model normalized key → its owning main model normalized key,
 * scanning all stored modelProfiles. Only profile-based tier overrides are used
 * (not env vars, which are session-scoped).
 */
function buildSubToMainMap(): Map<string, string> {
  const subToMain = new Map<string, string>();
  try {
    const storage = readCustomApiStorage();
    for (const p of storage.modelProfiles ?? []) {
      const ownerKey = normalizeModelName(p.model);
      if (p.defaultOpusModel) subToMain.set(normalizeModelName(p.defaultOpusModel), ownerKey);
      if (p.defaultSonnetModel) subToMain.set(normalizeModelName(p.defaultSonnetModel), ownerKey);
      if (p.defaultHaikuModel) subToMain.set(normalizeModelName(p.defaultHaikuModel), ownerKey);
    }
  } catch { /* ignore */ }
  return subToMain;
}

/**
 * Get sub-model normalized keys that belong to a specific main model profile.
 */
function getProfileSubKeys(profile?: ModelProfile): Set<string> {
  const keys = new Set<string>();
  if (profile) {
    if (profile.defaultOpusModel) keys.add(normalizeModelName(profile.defaultOpusModel));
    if (profile.defaultSonnetModel) keys.add(normalizeModelName(profile.defaultSonnetModel));
    if (profile.defaultHaikuModel) keys.add(normalizeModelName(profile.defaultHaikuModel));
  }
  return keys;
}

/**
 * Gather MAIN models only (not tier sub-models like Opus/Sonnet/Haiku).
 * A model in savedModels is only excluded if it's a tier override owned by a
 * DIFFERENT main model's profile (not itself).
 */
function getMainModels(): string[] {
  const envModel = process.env.ANTHROPIC_MODEL?.trim();
  let configModel: string | undefined;
  let configSaved: string[] = [];
  let storageSaved: string[] = [];
  try {
    const config = getGlobalConfig();
    configModel = config.customApiEndpoint?.model?.trim();
    configSaved = config.customApiEndpoint?.savedModels ?? [];
  } catch { /* ignore */ }
  try {
    storageSaved = readCustomApiStorage().savedModels ?? [];
  } catch { /* ignore */ }

  const activeModel = envModel || configModel;

  // Build set of normalized keys that are "must include" (in savedModels or active)
  const mustInclude = new Set<string>();
  if (activeModel) mustInclude.add(normalizeModelName(activeModel));
  for (const m of [...configSaved, ...storageSaved]) {
    if (m) mustInclude.add(normalizeModelName(m));
  }

  // Build sub→main ownership map from stored profiles
  const subToMain = buildSubToMainMap();

  const modelMap = new Map<string, string>();
  const addModel = (name: string | undefined) => {
    if (!name) return;
    const key = normalizeModelName(name);
    if (!modelMap.has(key)) modelMap.set(key, name);
  };

  // Active model always included
  if (activeModel) addModel(activeModel);

  // savedModels: only exclude if it's a tier override of a DIFFERENT main model
  for (const m of [...configSaved, ...storageSaved]) {
    if (!m) continue;
    const key = normalizeModelName(m);
    const ownerKey = subToMain.get(key);
    // Exclude only if: owned by another model that is also in savedModels/active,
    // AND the owner is different from this model itself.
    if (ownerKey && ownerKey !== key && mustInclude.has(ownerKey)) continue;
    addModel(m);
  }

  return [...modelMap.values()];
}

/** Clear tier model env vars that belong to a deleted main model */
function clearTierModelEnvVars() {
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES;
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES;
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES;
}

function doRemoveModel(targetModel: string): { success: boolean; message: string } {
  const targetNormalized = normalizeModelName(targetModel);
  const mainModels = getMainModels();
  if (!mainModels.some(m => normalizeModelName(m) === targetNormalized)) {
    return { success: false, message: `Model not found: ${targetModel}` };
  }
  if (mainModels.length <= 1) {
    return { success: false, message: 'Cannot remove the last model. Use /add-model to add another first.' };
  }

  const currentConfig = getGlobalConfig();
  const secureStored = readCustomApiStorage();

  // Find the deleted model's profile to identify its sub-models for cascade cleanup
  const deletedProfile = (secureStored.modelProfiles ?? []).find(
    p => normalizeModelName(p.model) === targetNormalized,
  );
  const deletedSubKeys = getProfileSubKeys(deletedProfile);

  // Deduplicate remaining main models
  const modelMap = new Map<string, string>();
  for (const m of mainModels) {
    const key = normalizeModelName(m);
    if (!modelMap.has(key)) modelMap.set(key, m);
  }

  const currentModel = secureStored.model ?? currentConfig.customApiEndpoint?.model;
  const isRemovingCurrent = normalizeModelName(currentModel ?? '') === targetNormalized;
  // Remove target main model AND its sub-models from savedModels
  const remainingModels = [...modelMap.entries()]
    .filter(([key]) => key !== targetNormalized && !deletedSubKeys.has(key))
    .map(([, name]) => name);
  const nextCurrentModel = isRemovingCurrent ? (remainingModels[0] ?? undefined) : currentModel;

  // Write .claude.json — three config files must stay in sync (requirement 10)
  const fallbackProfile = nextCurrentModel ? getModelProfile(nextCurrentModel) : undefined;
  saveGlobalConfig(current => ({
    ...current,
    customApiEndpoint: {
      ...current.customApiEndpoint,
      model: nextCurrentModel,
      savedModels: remainingModels,
      ...(fallbackProfile ? {
        provider: fallbackProfile.provider,
        baseURL: fallbackProfile.baseURL,
        apiKey: fallbackProfile.apiKey,
        authTokenType: fallbackProfile.authTokenType,
      } : {}),
    },
  }));

  // Clean up modelProfiles: remove the target + any profile whose model is a sub-model of target
  const freshStored = readCustomApiStorage();
  const remainingProfiles = (freshStored.modelProfiles ?? []).filter(
    p => normalizeModelName(p.model) !== targetNormalized && !deletedSubKeys.has(normalizeModelName(p.model)),
  );
  const storageUpdate: Record<string, unknown> = { 
    model: nextCurrentModel, 
    savedModels: remainingModels, 
    modelProfiles: remainingProfiles,
    ...(fallbackProfile ? {
      provider: fallbackProfile.provider,
      baseURL: fallbackProfile.baseURL,
      apiKey: fallbackProfile.apiKey,
      authTokenType: fallbackProfile.authTokenType,
    } : {}),
  };

  if (isRemovingCurrent) {
    // Clear tier model env vars that belong to the deleted model
    clearTierModelEnvVars();

    if (nextCurrentModel) {
      const fallbackProfile = getModelProfile(nextCurrentModel);
      if (fallbackProfile) {
        applyModelProfile(fallbackProfile);
        writeCustomApiStorage({ ...readCustomApiStorage(), ...storageUpdate });
      } else {
        process.env.ANTHROPIC_MODEL = nextCurrentModel;
        delete process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER;
        delete process.env.DOGE_API_KEY;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOW;
        storageUpdate.provider = undefined;
        storageUpdate.baseURL = undefined;
        storageUpdate.apiKey = undefined;
        writeCustomApiStorage({ ...freshStored, ...storageUpdate });
      }
      updateSettingsForSource('userSettings', { model: nextCurrentModel });
    } else {
      // Unreachable due to last-model guard, kept as defensive cleanup
      clearTierModelEnvVars();
      delete process.env.ANTHROPIC_MODEL;
      delete process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER;
      delete process.env.DOGE_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_BASE_URL;
      storageUpdate.provider = undefined;
      storageUpdate.baseURL = undefined;
      storageUpdate.apiKey = undefined;
      writeCustomApiStorage({ ...freshStored, ...storageUpdate });
      updateSettingsForSource('userSettings', {});
    }
  } else {
    writeCustomApiStorage({ ...freshStored, ...storageUpdate });
  }

  const removedName = mainModels.find(m => normalizeModelName(m) === targetNormalized) || targetModel;
  const subNames: string[] = [];
  if (deletedProfile?.defaultOpusModel) subNames.push(deletedProfile.defaultOpusModel);
  if (deletedProfile?.defaultSonnetModel) subNames.push(deletedProfile.defaultSonnetModel);
  if (deletedProfile?.defaultHaikuModel) subNames.push(deletedProfile.defaultHaikuModel);
  const cascadeMsg = subNames.length > 0 ? ` (sub-models: ${subNames.join(', ')})` : '';
  return { success: true, message: `Removed custom model: ${removedName}${cascadeMsg}` };
}

type RemoveModelPickerProps = {
  models: string[];
  onDone: (result?: string, options?: { display?: 'system' }) => void;
};

function RemoveModelPicker({ models, onDone }: RemoveModelPickerProps): React.ReactNode {
  const typedModelNameRef = React.useRef('');
  const currentModel = readCustomApiStorage().model ?? getGlobalConfig().customApiEndpoint?.model;

  const selectOptions = React.useMemo(() => {
    const modelOptions = models.map(m => {
      const isCurrent = normalizeModelName(currentModel ?? '') === normalizeModelName(m);
      return {
        value: m,
        label: formatCustomModelLabel(m),
        description: isCurrent ? '(currently active)' : undefined,
      };
    });
    return [
      {
        type: 'input' as const,
        value: '__INPUT__',
        label: 'Type model name to remove...',
        placeholder: 'Enter model name',
        allowEmptySubmitToCancel: true,
        onChange: (value: string) => { typedModelNameRef.current = value; },
        description: 'Enter any model name and press Enter to remove',
      },
      ...modelOptions,
    ];
  }, [models, currentModel]);

  const handleSelect = React.useCallback((value: string) => {
    if (value === '__INPUT__') {
      const typed = typedModelNameRef.current.trim();
      if (typed) {
        const result = doRemoveModel(typed);
        onDone(result.message, { display: result.success ? undefined : 'system' });
      } else {
        onDone('No model removed.');
      }
      return;
    }
    const result = doRemoveModel(value);
    onDone(result.message, { display: result.success ? undefined : 'system' });
  }, [onDone]);

  const handleCancel = React.useCallback(() => {
    onDone('No model removed.');
  }, [onDone]);

  return (
    <Box flexDirection="column">
      <Text bold>Remove Custom Model</Text>
      <Text dimColor>Select a model with arrow keys and Enter, or type a name in the input.</Text>
      <Box flexDirection="column" marginBottom={1}>
        <Select
          options={selectOptions}
          onChange={handleSelect}
          onCancel={handleCancel}
          visibleOptionCount={Math.min(10, selectOptions.length)}
        />
      </Box>
      <Text dimColor>Or run /remove-model {'<model-name>'} to remove directly.</Text>
    </Box>
  );
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  try {
    const targetModel = (args ?? '').trim();
    if (!targetModel) {
      const models = getMainModels();
      if (models.length === 0) {
        onDone('No custom models configured.');
        return;
      }
      return React.createElement(RemoveModelPicker, { models, onDone });
    }

    const result = doRemoveModel(targetModel);
    onDone(result.message, { display: result.success ? undefined : 'system' });
  } catch (err) {
    onDone(`Error in /remove-model: ${String(err)}`);
  }
};

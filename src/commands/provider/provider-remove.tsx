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
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { buildSubToMainMap, getMainModels } from './provider-entries.js';

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

/** Clear tier model env vars that belong to a deleted main model */
function clearTierModelEnvVars() {
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES;
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES;
}

export function doRemoveProvider(targetModel: string): { success: boolean; message: string } {
  const targetNormalized = normalizeModelName(targetModel);
  const mainModels = getMainModels();
  if (!mainModels.some(m => normalizeModelName(m) === targetNormalized)) {
    return { success: false, message: `Provider not found: ${targetModel}` };
  }
  if (mainModels.length <= 1) {
    return { success: false, message: 'Cannot remove the last provider. Use /provider add to add another first.' };
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
  return { success: true, message: `Removed provider: ${removedName}${cascadeMsg}` };
}

type RemoveProviderPickerProps = {
  onDone: LocalJSXCommandOnDone;
};

export function RemoveProviderPicker({ onDone }: RemoveProviderPickerProps): React.ReactNode {
  const typedModelNameRef = React.useRef('');
  const models = React.useMemo(() => getMainModels(), []);
  const currentModel = readCustomApiStorage().model ?? getGlobalConfig().customApiEndpoint?.model;

  const selectOptions = React.useMemo(() => {
    const profiles = readCustomApiStorage().modelProfiles ?? [];
    const modelOptions = models.map(m => {
      const isCurrent = normalizeModelName(currentModel ?? '') === normalizeModelName(m);
      const name = profiles.find(
        p => normalizeModelName(p.model) === normalizeModelName(m),
      )?.providerName;
      const desc = [
        ...(name ? [name] : []),
        ...(isCurrent ? ['(currently active)'] : []),
      ].join(' ');
      return {
        value: m,
        label: formatCustomModelLabel(m),
        description: desc || undefined,
      };
    });
    return [
      {
        type: 'input' as const,
        value: '__INPUT__',
        label: 'Type provider (main model) name to remove...',
        placeholder: 'Enter main model name',
        allowEmptySubmitToCancel: true,
        onChange: (value: string) => { typedModelNameRef.current = value; },
        description: 'Enter any main model name and press Enter to remove',
      },
      ...modelOptions,
    ];
  }, [models, currentModel]);

  const handleSelect = React.useCallback((value: string) => {
    if (value === '__INPUT__') {
      const typed = typedModelNameRef.current.trim();
      if (typed) {
        const result = doRemoveProvider(typed);
        onDone(result.message, { display: result.success ? undefined : 'system' });
      } else {
        onDone('No provider removed.');
      }
      return;
    }
    const result = doRemoveProvider(value);
    onDone(result.message, { display: result.success ? undefined : 'system' });
  }, [onDone]);

  const handleCancel = React.useCallback(() => {
    onDone('No provider removed.');
  }, [onDone]);

  return (
    <Box flexDirection="column">
      <Text bold>Remove Provider</Text>
      <Text dimColor>Select a provider (by its main model) with arrow keys and Enter, or type a name in the input.</Text>
      <Box flexDirection="column" marginBottom={1}>
        <Select
          options={selectOptions}
          onChange={handleSelect}
          onCancel={handleCancel}
          visibleOptionCount={Math.min(10, selectOptions.length)}
        />
      </Box>
      <Text dimColor>Or run /provider remove {'<model-name>'} to remove directly.</Text>
    </Box>
  );
}

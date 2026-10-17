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
import { PROFILE_MANAGED_ENV_KEYS } from '../../utils/model/profileEnvKeys.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getProviderEntries } from './provider-entries.js';
import { getProfileId, profileSelection, isProfileSelection, resolveProfileReference } from '../../utils/model/profileIdentity.js';
import { useSetAppState } from '../../state/AppState.js';

/** Remove a provider identity, preserving other providers with the same model. */
export function doRemoveProvider(target: string): { success: boolean; message: string; activeModel?: string } {
  const stored = readCustomApiStorage();
  const entries = getProviderEntries();
  const profile = getModelProfile(target);
  const entry = entries.find(e => profile && e.profile
    ? getProfileId(e.profile) === getProfileId(profile)
    : !isProfileSelection(target) && normalizeModelName(e.model) === normalizeModelName(target));
  if (!entry) return { success: false, message: `Provider not found: ${target}` };
  if (entries.length <= 1) return { success: false, message: 'Cannot remove the last provider. Use /provider add to add another first.' };
  const remaining = entries.filter(e => e !== entry);
  const profiles = remaining.flatMap(e => e.profile ? [e.profile] : []);
  const currentDisk = (stored.activeProfileId ? resolveProfileReference(stored.modelProfiles ?? [], stored.activeProfileId) : undefined)
    ?? (stored.model ? (stored.modelProfiles ?? []).find(p => normalizeModelName(p.model) === normalizeModelName(stored.model!)) : undefined);
  const removesDisk = entry.profile && currentDisk
    ? getProfileId(entry.profile) === getProfileId(currentDisk)
    : normalizeModelName(stored.model ?? '') === normalizeModelName(entry.model);
  const fallback = remaining[0]!;
  const disk = removesDisk ? fallback : { model: stored.model, profile: currentDisk };
  const credentials = removesDisk ? {
    provider: disk.profile?.provider, baseURL: disk.profile?.baseURL,
    apiKey: disk.profile?.apiKey, authTokenType: disk.profile?.authTokenType,
  } : {};
  const next = { ...stored, model: disk.model, modelProfiles: profiles,
    savedModels: [...new Set(remaining.map(e => e.model))],
    activeProfileId: disk.profile ? getProfileId(disk.profile) : undefined, ...credentials };
  saveGlobalConfig(current => ({ ...current, customApiEndpoint: { ...current.customApiEndpoint, ...next } }));
  writeCustomApiStorage(next);
  if (removesDisk && disk.model) updateSettingsForSource('userSettings', { model: disk.model });
  if (entry.isCurrent) {
    if (fallback.profile) applyModelProfile(fallback.profile, { persist: false });
    else {
      for (const key of PROFILE_MANAGED_ENV_KEYS) delete process.env[key];
      for (const key of ['DOGE_ACTIVE_MODEL_PROFILE', 'CLAUDE_CODE_COMPATIBLE_API_PROVIDER', 'DOGE_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete process.env[key];
      process.env.ANTHROPIC_MODEL = fallback.model;
    }
  }
  return { success: true, message: `Removed provider: ${entry.profile?.providerName ?? entry.model}`,
    ...(entry.isCurrent ? { activeModel: fallback.model } : {}) };
}

type RemoveProviderPickerProps = {
  onDone: LocalJSXCommandOnDone;
};

export function RemoveProviderPicker({ onDone }: RemoveProviderPickerProps): React.ReactNode {
  const typedModelNameRef = React.useRef('');
  const models = React.useMemo(() => getProviderEntries(), []);
  const setAppState = useSetAppState();
  const currentModel = readCustomApiStorage().model ?? getGlobalConfig().customApiEndpoint?.model;

  const selectOptions = React.useMemo(() => {
    const modelOptions = models.map(entry => ({
      value: entry.profile ? profileSelection(entry.profile) : entry.model,
      label: formatCustomModelLabel(entry.model),
      description: [entry.profile?.providerName, entry.isCurrent ? '(currently active)' : undefined].filter(Boolean).join(' '),
    }));
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
        if (result.activeModel) setAppState(prev => ({ ...prev, mainLoopModelForSession: result.activeModel! }));
        onDone(result.message, { display: result.success ? undefined : 'system' });
      } else {
        onDone('No provider removed.');
      }
      return;
    }
    const result = doRemoveProvider(value);
    if (result.activeModel) setAppState(prev => ({ ...prev, mainLoopModelForSession: result.activeModel! }));
    onDone(result.message, { display: result.success ? undefined : 'system' });
  }, [onDone, setAppState]);

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

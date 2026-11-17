import { useState } from 'react'
import capitalize from 'lodash-es/capitalize.js'
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js'
import { FAST_MODE_MODEL_DISPLAY, isFastModeAvailable, isFastModeCooldown, isFastModeEnabled } from 'src/utils/fastMode.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { getModelProfile } from '../utils/customApiStorage.js'
import { convertEffortValueToLevel, type EffortLevel, getDefaultEffortForModel, getEffortEnvOverride, toPersistableEffort } from '../utils/effort.js'
import { suppressEffort } from '../utils/effortContext.js'
import { getEffortCapability } from '../utils/model/effortCapabilities.js'
import { getDefaultMainLoopModel, type ModelSetting, modelDisplayString, parseUserSpecifiedModel } from '../utils/model/model.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import { isProfileSelection, profileSelection } from '../utils/model/profileIdentity.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/index.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
import { effortLevelToSymbol } from './EffortIndicator.js'

export type Props = {
  initial: string | null
  sessionModel?: ModelSetting
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  showFastModeNotice?: boolean
  headerText?: string
  /** Skip global effort settings for project-scoped choices. */
  skipSettingsWrite?: boolean
}

const NO_PREFERENCE = '__NO_PREFERENCE__'

function effortForOption(value: string, thinkingEnabled: boolean) {
  if (isProfileSelection(value) && !getModelProfile(value)) return { levels: [], defaultLevel: undefined }
  const model = value === NO_PREFERENCE ? getDefaultMainLoopModel() : isProfileSelection(value) ? value : parseUserSpecifiedModel(value)
  const env = thinkingEnabled ? process.env : { ...process.env, CLAUDE_CODE_DISABLE_THINKING: '1' }
  const capability = getEffortCapability(model, env)
  if (capability.source === 'catalog') return capability
  const level = convertEffortValueToLevel(getDefaultEffortForModel(model) ?? 'high')
  return { levels: capability.levels, defaultLevel: capability.levels.includes(level) ? level : undefined }
}

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  showFastModeNotice,
  headerText,
  skipSettingsWrite,
}: Props) {
  const setAppState = useSetAppState()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const fastMode = useAppState(s => isFastModeEnabled() && !!s.fastMode)
  const sessionEffort = useAppState(s => s.effortValue)
  const thinkingEnabled = useAppState(s => s.thinkingEnabled !== false)
  const effectiveInitial = sessionModel ?? initial
  const activeProfile = effectiveInitial ? getModelProfile(effectiveInitial) : undefined
  const initialModelId = activeProfile?.catalogModelId ?? activeProfile?.models?.find(m => m.upstreamModel === activeProfile.model)?.id
  const initialValue = activeProfile && initialModelId ? profileSelection(activeProfile, initialModelId) : effectiveInitial ?? NO_PREFERENCE
  const options = getModelOptions(fastMode).map(option => ({ ...option, value: option.value ?? NO_PREFERENCE }))
  if (effectiveInitial !== null && !options.some(option => option.value === initialValue)) {
    options.push({ value: initialValue, label: modelDisplayString(effectiveInitial), description: 'Current model' })
  }
  const initialFocus = options.find(option => option.value === initialValue)?.value ?? options[0]?.value ?? NO_PREFERENCE
  const [focusedValue, setFocusedValue] = useState(initialFocus)
  const [adjustment, setAdjustment] = useState<{ value: string; effort: EffortLevel }>()
  const focusedLabel = options.find(option => option.value === focusedValue)?.label
  const { levels, defaultLevel } = effortForOption(focusedValue, thinkingEnabled)
  const override = getEffortEnvOverride()
  const requested = override === null ? undefined : override ?? sessionEffort
  const requestedLevel = requested === undefined ? undefined : convertEffortValueToLevel(requested)
  const adjustedLevel = adjustment?.value === focusedValue ? adjustment.effort : undefined
  const automatic = override === null && suppressEffort()
  const displayEffort = adjustedLevel ?? (automatic ? undefined : requestedLevel && levels.includes(requestedLevel) ? requestedLevel : defaultLevel)

  function cycleEffort(direction: -1 | 1) {
    if (levels.length === 0) return
    const current = displayEffort ? levels.indexOf(displayEffort) : -1
    const next = current < 0 ? (direction === 1 ? 0 : levels.length - 1) : (current + direction + levels.length) % levels.length
    setAdjustment({ value: focusedValue, effort: levels[next]! })
  }

  useKeybindings({
    'modelPicker:decreaseEffort': () => cycleEffort(-1),
    'modelPicker:increaseEffort': () => cycleEffort(1),
  }, { context: 'ModelPicker' })

  function handleSelect(value: string) {
    const effort = adjustment?.value === value ? adjustment.effort : undefined
    logEvent('tengu_model_command_menu_effort', {
      effort: (effort ?? displayEffort) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (effort !== undefined && !skipSettingsWrite && !isStandaloneCommand) {
      const persistable = toPersistableEffort(effort)
      if (persistable !== undefined) updateSettingsForSource('userSettings', { effortLevel: persistable })
      setAppState(previous => ({ ...previous, effortValue: effort }))
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    }
    onSelect(value === NO_PREFERENCE ? null : value, effort)
  }

  const content = <Box flexDirection="column">
    <Box marginBottom={1} flexDirection="column">
      <Text color="remember" bold>Select model</Text>
      <Text dimColor>{headerText ?? 'Select a model, or specify one at startup with --model.'}</Text>
      {sessionModel && <Text dimColor>Currently using {modelDisplayString(sessionModel)} for this session (session override).</Text>}
    </Box>
    <Box flexDirection="column" marginBottom={1}>
      <Select defaultValue={initialValue} defaultFocusValue={initialFocus} options={options} onChange={handleSelect}
        onFocus={setFocusedValue} onCancel={onCancel ?? (() => {})} visibleOptionCount={Math.min(10, options.length)} />
      {options.length > 10 && <Box paddingLeft={3}><Text dimColor>and {options.length - 10} more…</Text></Box>}
    </Box>
    <Box marginBottom={1}>
      {levels.length > 0 ? <Text dimColor>
        <EffortLevelIndicator effort={displayEffort} /> {displayEffort ? capitalize(displayEffort) : 'Auto'} effort
        {displayEffort && displayEffort === defaultLevel ? ' (default)' : ''} <Text color="subtle">← → to adjust</Text>
      </Text> : <Text color="subtle"><EffortLevelIndicator /> Effort not supported{focusedLabel ? ` for ${focusedLabel}` : ''}</Text>}
    </Box>
    {isFastModeEnabled() && (showFastModeNotice ? <Box marginBottom={1}>
      <Text dimColor>Fast mode is <Text bold>ON</Text> and available with{' '}{FAST_MODE_MODEL_DISPLAY} only (/fast). Switching to other models turns off fast mode.</Text>
    </Box> : isFastModeAvailable() && !isFastModeCooldown() ? <Box marginBottom={1}>
      <Text dimColor>Use <Text bold>/fast</Text> to turn on Fast mode ({FAST_MODE_MODEL_DISPLAY} only).</Text>
    </Box> : null)}
  </Box>

  return isStandaloneCommand ? <Pane color="permission">
    {content}
    <Text dimColor italic>{exitState.pending ? <>Press {exitState.keyName} again to exit</> : <Byline>
      <KeyboardShortcutHint shortcut="Enter" action="confirm" />
      <ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="exit" />
    </Byline>}</Text>
  </Pane> : content
}

function EffortLevelIndicator({ effort }: { effort?: EffortLevel }) {
  return <Text color={effort ? 'claude' : 'subtle'}>{effortLevelToSymbol(effort ?? 'low')}</Text>
}

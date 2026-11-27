import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { join } from 'path'
import { useEffect, useState } from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { isAutoDreamEnabled } from '../../services/autoDream/config.js'
import { readLastConsolidatedAt } from '../../services/autoDream/consolidationLock.js'
import { useAppState } from '../../state/AppState.js'
import { getAgentMemoryDir } from '../../tools/AgentTool/agentMemory.js'
import type { MemoryFileInfo } from '../../utils/claudemd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatRelativeTimeAgo } from '../../utils/format.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'
import { Select } from '../CustomSelect/index.js'
import { ListItem } from '../design-system/ListItem.js'

const teamMemPaths = feature('TEAMMEM')
  ? require('../../memdir/teamMemPaths.js') as typeof import('../../memdir/teamMemPaths.js')
  : null

const FOLDER = '__open_folder__'
let lastSelectedPath: string | undefined

type Preference = 'autoMemoryEnabled' | 'autoDreamEnabled'

function readPreferences() {
  const user = getSettingsForSource('userSettings')
  const userAutoMemory = user?.autoMemoryEnabled !== false
  return {
    autoMemoryEnabled: isAutoMemoryEnabled(),
    autoDreamEnabled: isAutoDreamEnabled(),
    userAutoMemory,
    userAutoDream: user?.autoDreamEnabled === true,
  }
}

export function MemoryFileSelector({ memoryFiles, onSelect, onOpenFolder, onCancel }: {
  memoryFiles: Array<MemoryFileInfo & { isNested?: boolean }>
  onSelect: (path: string) => void
  onOpenFolder: (path: string) => void
  onCancel: () => void
}) {
  const files = memoryFiles.filter(file => file.type !== 'AutoMem' && file.type !== 'TeamMem')
  const userFile = join(getClaudeConfigHomeDir(), 'CLAUDE.md')
  const projectFile = join(getOriginalCwd(), 'CLAUDE.md')
  const [preferences, setPreferences] = useState(readPreferences)
  const [focused, setFocused] = useState<number | null>(null)
  const [lastDreamAt, setLastDreamAt] = useState<number | null>(null)
  const [error, setError] = useState('')
  const running = useAppState(state => Object.values(state.tasks).some(task => task.type === 'dream' && task.status === 'running'))
  const { activeAgents } = useAppState(state => state.agentDefinitions)
  const { autoMemoryEnabled, autoDreamEnabled } = preferences
  const lastToggle = autoMemoryEnabled ? 1 : 0

  useEffect(() => settingsChangeDetector.subscribe(() => {
    const next = readPreferences()
    setPreferences(next)
    if (!next.autoMemoryEnabled) setFocused(current => current === 1 ? 0 : current)
  }), [])
  useEffect(() => {
    let active = true
    void readLastConsolidatedAt().then(at => { if (active) setLastDreamAt(at) })
    return () => { active = false }
  }, [running])

  const primaryName = (path: string) =>
    path === userFile ? 'User memory' : path === projectFile ? 'Project memory' : undefined

  const depths = new Map<string, number>()
  const options = files.map(file => {
    const path = getDisplayPath(file.path)
    const depth = file.parent ? (depths.get(file.parent) ?? 0) + 1 : 0
    depths.set(file.path, depth)
    const primary = !file.isNested && primaryName(file.path)
    return {
      label: primary || (depth ? `${'  '.repeat(depth - 1)}L ${path}` : path),
      value: file.path,
      description: primary ? path : file.parent ? '@-imported' : file.isNested ? 'dynamically loaded' : '',
    }
  })
  for (const path of [userFile, projectFile]) {
    if (!files.some(file => file.path === path)) {
      options.push({ label: primaryName(path)!, value: path, description: `Create ${getDisplayPath(path)}` })
    }
  }

  function addFolder(label: string, path: string) {
    options.push({ label, value: FOLDER + path, description: getDisplayPath(path) })
  }

  if (autoMemoryEnabled) {
    addFolder('Open auto-memory folder', getAutoMemPath())
    if (feature('TEAMMEM') && teamMemPaths?.isTeamMemoryEnabled()) {
      addFolder('Open team memory folder', teamMemPaths.getTeamMemPath())
    }
    for (const agent of activeAgents) {
      if (agent.memory) addFolder(`Open ${chalk.bold(agent.agentType)} agent memory`, getAgentMemoryDir(agent.agentType, agent.memory))
    }
  }

  function toggle(key: Preference) {
    const enabled = !(key === 'autoMemoryEnabled' ? preferences.userAutoMemory : preferences.userAutoDream)
    const { error: failure } = updateSettingsForSource('userSettings', { [key]: enabled })
    const next = readPreferences()
    setPreferences(next)
    setError(failure?.message ?? (next[key] !== enabled ? 'User default updated. A setting for this session overrides it.' : ''))
    if (!next.autoMemoryEnabled && focused === 1) setFocused(0)
  }

  const toggleFocused = focused !== null
  useExitOnCtrlCDWithKeybindings()
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })
  useKeybinding('confirm:yes', () => {
    if (focused === 0) toggle('autoMemoryEnabled')
    if (focused === 1 && autoMemoryEnabled) toggle('autoDreamEnabled')
  }, { context: 'Confirmation', isActive: toggleFocused })
  useKeybinding('select:next', () => {
    setFocused(value => value !== null && value < lastToggle ? value + 1 : null)
  }, { context: 'Select', isActive: toggleFocused })
  useKeybinding('select:previous', () => {
    setFocused(value => value !== null && value > 0 ? value - 1 : value)
  }, { context: 'Select', isActive: toggleFocused })

  const dreamOn = autoMemoryEnabled && autoDreamEnabled
  const userDreamOn = preferences.userAutoMemory && preferences.userAutoDream
  const dreamStatus = running ? 'running' : lastDreamAt === null ? '' :
    lastDreamAt === 0 ? 'never' : `last ran ${formatRelativeTimeAgo(new Date(lastDreamAt))}`
  const initialPath = options.some(option => option.value === lastSelectedPath) ? lastSelectedPath : options[0]?.value

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" marginBottom={1}>
        <ListItem isFocused={focused === 0}><Text>
          Auto-memory: {autoMemoryEnabled ? 'on' : 'off'}
          {autoMemoryEnabled !== preferences.userAutoMemory && <Text dimColor>{' · user default '}{preferences.userAutoMemory ? 'on' : 'off'}</Text>}
        </Text></ListItem>
        <ListItem isFocused={focused === 1} styled={false}>
          <Text color={focused === 1 ? 'suggestion' : undefined}>
            Auto-dream: {dreamOn ? 'on' : 'off'}
            {dreamOn !== userDreamOn && <Text dimColor>{' · user default '}{userDreamOn ? 'on' : 'off'}</Text>}
            {dreamStatus && <Text dimColor>{' · '}{dreamStatus}</Text>}
            {autoMemoryEnabled && !running && <Text dimColor>{' · /dream to run'}</Text>}
          </Text>
        </ListItem>
        {error && <Text color="error">{error}</Text>}
      </Box>
      <Select
        defaultFocusValue={initialPath}
        options={options}
        isDisabled={toggleFocused}
        onCancel={onCancel}
        onUpFromFirstItem={() => setFocused(lastToggle)}
        onChange={value => {
          if (value.startsWith(FOLDER)) {
            onOpenFolder(value.slice(FOLDER.length))
            return
          }
          lastSelectedPath = value
          onSelect(value)
        }}
      />
    </Box>
  )
}

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import { COMMON_HELP_ARGS } from '../../constants/xml.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getModelProfile, type ModelProfile } from '../../utils/customApiStorage.js'
import { formatCustomModelLabel } from '../../utils/model/model.js'
import { describeProviderEntry, formatProviderEntry, getProviderEntries } from './provider-entries.js'
import { ProviderForm } from './provider-form.js'
import { doRemoveProvider, RemoveProviderPicker } from './provider-remove.js'

const USAGE = [
  'Usage:',
  '  /provider                    Open the provider manager',
  '  /provider add [model]        Add or edit a provider: API format, base URL, API key,',
  '                              and main / opus / sonnet / haiku models',
  '  /provider remove [model]     Remove a saved provider (by its main model)',
  '  /provider list               List saved providers',
].join('\n')

function listProvidersText(): string {
  const entries = getProviderEntries()
  if (entries.length === 0) return 'No providers configured. Use /provider add to create one.'
  const blocks = entries.map(formatProviderEntry)
  return `Saved providers:\n\n${blocks.join('\n\n')}`
}

type ProviderMenuProps = {
  onDone: (result?: string, options?: { display?: 'system' }) => void
}

export function ProviderMenu({ onDone }: ProviderMenuProps): React.ReactNode {
  const [view, setView] = React.useState<'menu' | 'add' | 'edit' | 'remove'>('menu')
  const [editProfile, setEditProfile] = React.useState<ModelProfile | undefined>()

  // All hooks must run before the view early-returns below — switching views
  // changes the subtree but not this component's hook count.
  const handleSelect = React.useCallback((value: string) => {
    if (value === '__ADD__') {
      setView('add')
      return
    }
    if (value === '__REMOVE__') {
      setView('remove')
      return
    }
    if (value.startsWith('edit:')) {
      const model = value.slice('edit:'.length)
      // Entries without a stored profile still open the form with the model prefilled.
      setEditProfile(getModelProfile(model) ?? { model })
      setView('edit')
    }
  }, [])

  const handleCancel = React.useCallback(() => {
    onDone('No changes made.')
  }, [onDone])

  if (view === 'add') return <ProviderForm onDone={onDone} />
  if (view === 'edit') return <ProviderForm existing={editProfile} onDone={onDone} />
  if (view === 'remove') return <RemoveProviderPicker onDone={onDone} />

  const entries = getProviderEntries()
  const options = [
    ...entries.map(e => ({
      value: `edit:${e.model}`,
      label: formatCustomModelLabel(e.model),
      description: e.isCurrent
        ? `${describeProviderEntry(e)} · currently active`
        : describeProviderEntry(e),
    })),
    {
      value: '__ADD__',
      label: 'Add new provider…',
      description: 'API format, base URL, API key, main / opus / sonnet / haiku models',
    },
    ...(entries.length > 0
      ? [{
          value: '__REMOVE__',
          label: 'Remove a provider…',
          description: 'Delete a saved provider and its tier models',
        }]
      : []),
  ]

  return (
    <Box flexDirection="column">
      <Text bold>Manage Providers</Text>
      <Text dimColor>Select a provider to edit it, or add a new one.</Text>
      <Box flexDirection="column" marginY={1}>
        <Select
          options={options}
          onChange={handleSelect}
          onCancel={handleCancel}
          visibleOptionCount={Math.min(10, options.length)}
        />
      </Box>
      <Text dimColor>Esc to cancel · /provider list for a detailed view</Text>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  try {
    const trimmed = (args ?? '').trim()
    if (COMMON_HELP_ARGS.includes(trimmed)) {
      onDone(USAGE, { display: 'system' })
      return
    }

    const [sub, ...rest] = trimmed.split(/\s+/)
    const restArgs = rest.join(' ').trim()

    if (!sub) {
      return React.createElement(ProviderMenu, { onDone })
    }
    if (sub === 'add' || sub === 'edit') {
      return React.createElement(ProviderForm, { initialModel: restArgs || undefined, onDone })
    }
    if (sub === 'remove' || sub === 'rm') {
      if (restArgs) {
        const result = doRemoveProvider(restArgs)
        onDone(result.message, { display: result.success ? undefined : 'system' })
        return
      }
      return React.createElement(RemoveProviderPicker, { onDone })
    }
    if (sub === 'list' || sub === 'ls') {
      onDone(listProvidersText())
      return
    }
    onDone(`Unknown subcommand: ${sub}\n${USAGE}`, { display: 'system' })
  } catch (err) {
    onDone(`Error in /provider: ${String(err)}`)
  }
}

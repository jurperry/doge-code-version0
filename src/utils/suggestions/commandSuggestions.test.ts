import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../../commands.js'
import { generateCommandSuggestions } from './commandSuggestions.js'

function fakePromptCommand(name: string): Command {
  return {
    type: 'prompt',
    name,
    description: `fake ${name}`,
    source: 'builtin',
    async getPromptForCommand(): Promise<ContentBlockParam[]> {
      return []
    },
  } as unknown as Command
}

describe('generateCommandSuggestions — id namespace', () => {
  test('command ids carry the command- prefix so agent-* names never hit the @agent layout', () => {
    // PromptInputFooterSuggestions dispatches unified layout by id prefix
    // (file-/mcp-resource-/agent-). A command literally named 'agent-teams'
    // must not produce an id starting with 'agent-'.
    const suggestions = generateCommandSuggestions('/agent', [
      fakePromptCommand('agent-teams'),
    ])
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]!.id).toBe('command-agent-teams:builtin')
    expect(suggestions[0]!.id.startsWith('agent-')).toBe(false)
    expect(suggestions[0]!.displayText).toBe('/agent-teams')
  })

  test('regular command names keep working with the prefix', () => {
    const suggestions = generateCommandSuggestions('/revi', [
      fakePromptCommand('review'),
    ])
    expect(suggestions[0]!.id).toBe('command-review:builtin')
  })
})

import { test, expect } from 'bun:test'
import { PROFILE_MANAGED_ENV_KEYS } from './profileEnvKeys.js'

test('PROFILE_MANAGED_ENV_KEYS contains the exact 7 catalog-owned keys', () => {
  expect(PROFILE_MANAGED_ENV_KEYS).toEqual([
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
    'DOGE_ACTIVE_CONNECTION_ID',
    'DOGE_ACTIVE_MODEL_ID',
  ])
})

test('PROFILE_MANAGED_ENV_KEYS does NOT include CLAUDE_CODE_EFFORT_LEVEL (effort is independent)', () => {
  expect(PROFILE_MANAGED_ENV_KEYS).not.toContain('CLAUDE_CODE_EFFORT_LEVEL')
})

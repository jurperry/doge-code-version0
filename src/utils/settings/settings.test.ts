import { test, expect } from 'bun:test'
import { join } from 'path'
import { getRelativeSettingsFilePathForSource } from './settings.js'

// DOGE: project-scoped settings must live under .doge/ so doge stays isolated
// from an official Claude Code install (.claude/settings*.json must never be
// picked up as doge project settings — e.g. a stale ~/.claude/settings.json
// env block injecting ANTHROPIC_AUTH_TOKEN when running from ~).
test('project settings resolve under .doge, not .claude', () => {
  expect(getRelativeSettingsFilePathForSource('projectSettings')).toBe(
    join('.doge', 'settings.json'),
  )
  expect(getRelativeSettingsFilePathForSource('localSettings')).toBe(
    join('.doge', 'settings.local.json'),
  )
})

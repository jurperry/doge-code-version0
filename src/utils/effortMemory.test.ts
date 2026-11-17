import { test, expect } from 'bun:test'
import {
  effortModelKey,
  getRememberedEffort,
  rememberEffortForModel,
  seedEffortMemory,
} from './effortMemory.js'

test('model keys normalize case/variant suffixes and reject empty input', () => {
  expect(effortModelKey(' Claude-Opus-4-8[1m] ')).toBe('claude-opus-4-8')
  expect(effortModelKey('sonnet')).toBe('sonnet')
  expect(effortModelKey('  ')).toBeUndefined()
  expect(effortModelKey(undefined)).toBeUndefined()
})

test('remembering effort never mutates the input map', () => {
  const original = { sonnet: 'high' as const }
  const next = rememberEffortForModel(original, 'opus', 'max')
  expect(next).toEqual({ sonnet: 'high', opus: 'max' })
  expect(original).toEqual({ sonnet: 'high' })
})

test('remembering auto stores an explicit null so it beats the global default', () => {
  const next = rememberEffortForModel({ opus: 'max' }, 'opus', undefined)
  expect(next).toEqual({ opus: null })
  expect(getRememberedEffort(next, 'opus')).toBeNull()
})

test('lookup distinguishes "no memory" from explicit auto', () => {
  const map = rememberEffortForModel({}, 'Claude-Sonnet-5', 'medium')
  expect(getRememberedEffort(map, 'claude-sonnet-5')).toBe('medium')
  expect(getRememberedEffort(map, 'claude-sonnet-5[1m]')).toBe('medium')
  expect(getRememberedEffort(map, 'claude-opus-4-8')).toBeUndefined()
})

test('same-name models remember different effort on distinct connections', () => {
  let memory = seedEffortMemory('shared-model', 'high', 'provider-A')
  memory = rememberEffortForModel(memory, 'shared-model[1m]', 'low', 'provider-B')
  expect(getRememberedEffort(memory, 'shared-model', 'provider-A')).toBe('high')
  expect(getRememberedEffort(memory, 'shared-model', 'provider-B')).toBe('low')
})

test('seedEffortMemory seeds the startup model, empty for auto', () => {
  expect(seedEffortMemory('Claude-Opus-4-8[1m]', 'high')).toEqual({
    'claude-opus-4-8': 'high',
  })
  expect(seedEffortMemory('sonnet', undefined)).toEqual({})
})

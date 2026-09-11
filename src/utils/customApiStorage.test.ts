import { test, expect } from 'bun:test'
import {
  dedupeModelProfiles,
  isSameProviderEntry,
  normalizeCustomApiStorageData,
  type CustomApiStorageData,
  type ModelProfile,
} from './customApiStorage.js'

// --- isSameProviderEntry ---

test('isSameProviderEntry: providerName wins when both sides have one', () => {
  expect(
    isSameProviderEntry(
      { model: 'glm-5.3', providerName: 'GLM官方' },
      { model: 'glm-5.5', providerName: 'glm官方' },
    ),
  ).toBe(true)
  expect(
    isSameProviderEntry(
      { model: 'glm-5.3', providerName: 'glm官方' },
      { model: 'glm-5.3', providerName: 'kimi官方' },
    ),
  ).toBe(false)
})

test('isSameProviderEntry: falls back to normalized model for legacy unnamed profiles', () => {
  expect(isSameProviderEntry({ model: 'glm-5' }, { model: 'GLM-5[1m]' })).toBe(true)
  expect(isSameProviderEntry({ model: 'glm-5' }, { model: 'glm-5.5' })).toBe(false)
  // Mixed: only one side named → identity is still the model
  expect(isSameProviderEntry({ model: 'glm-5', providerName: 'glm官方' }, { model: 'glm-5' })).toBe(true)
})

// --- dedupeModelProfiles ---

test('dedupeModelProfiles keeps the active duplicate, else the last one', () => {
  const older: ModelProfile = { model: 'deepseek-old[1m]', providerName: 'deepseek官方', apiKey: 'old' }
  const newer: ModelProfile = { model: 'deepseek-new[1m]', providerName: 'deepseek官方', apiKey: 'new' }
  const other: ModelProfile = { model: 'kimi-k3', providerName: 'kimi官方' }

  // No active model → last occurrence wins
  expect(dedupeModelProfiles([older, other, newer])).toEqual([newer, other])
  // Active model points at the older entry → the active one wins
  expect(dedupeModelProfiles([older, other, newer], 'deepseek-old[1m]')).toEqual([older, other])
})

test('dedupeModelProfiles: legacy unnamed profiles group by model', () => {
  expect(
    dedupeModelProfiles([{ model: 'glm-5', apiKey: 'a' }, { model: 'GLM-5[1m]', apiKey: 'b' }]),
  ).toEqual([{ model: 'GLM-5[1m]', apiKey: 'b' }])
})

test('dedupeModelProfiles is a no-op for unique lists', () => {
  const profiles: ModelProfile[] = [
    { model: 'glm-5.3', providerName: 'glm官方' },
    { model: 'kimi-k3', providerName: 'kimi官方' },
  ]
  expect(dedupeModelProfiles(profiles)).toBe(profiles)
})

// --- normalizeCustomApiStorageData ---

test('normalizeCustomApiStorageData collapses same-name profiles and prunes orphaned savedModels', () => {
  const data: CustomApiStorageData = {
    model: 'deepseek-flash[1m]',
    savedModels: ['kimi-k3[1m]', 'glm-5.3[1m]', 'deepseek-v4.1[1m]', 'deepseek-flash[1m]'],
    modelProfiles: [
      { model: 'kimi-k3[1m]', providerName: 'kimi offical' },
      { model: 'glm-5.3[1m]', providerName: 'glm official' },
      // duplicate pair, same providerName, active on the second
      { model: 'deepseek-v4.1[1m]', providerName: 'deepseek offical' },
      { model: 'deepseek-flash[1m]', providerName: 'deepseek offical' },
    ],
  }
  const normalized = normalizeCustomApiStorageData(data)
  expect(normalized.modelProfiles?.map(p => p.model)).toEqual([
    'kimi-k3[1m]',
    'glm-5.3[1m]',
    'deepseek-flash[1m]',
  ])
  // The dropped duplicate's model leaves savedModels; everything else stays
  expect(normalized.savedModels).toEqual(['kimi-k3[1m]', 'glm-5.3[1m]', 'deepseek-flash[1m]'])
})

test('normalizeCustomApiStorageData keeps a dropped duplicate model that a kept profile still uses', () => {
  const data: CustomApiStorageData = {
    model: 'shared[1m]',
    savedModels: ['shared[1m]'],
    modelProfiles: [
      { model: 'shared[1m]', providerName: 'a官方' },
      { model: 'shared[1m]', providerName: 'a官方' },
      { model: 'other', providerName: 'b官方' },
    ],
  }
  const normalized = normalizeCustomApiStorageData(data)
  expect(normalized.modelProfiles).toHaveLength(2)
  expect(normalized.savedModels).toEqual(['shared[1m]'])
})

test('normalizeCustomApiStorageData returns the input unchanged when clean', () => {
  const data: CustomApiStorageData = {
    model: 'a',
    savedModels: ['a', 'b'],
    modelProfiles: [
      { model: 'a', providerName: 'a官方' },
      { model: 'b', providerName: 'b官方' },
    ],
  }
  expect(normalizeCustomApiStorageData(data)).toBe(data)
})

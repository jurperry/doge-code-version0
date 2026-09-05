import { test, expect, mock } from 'bun:test'
import {
  buildModelProfile,
  dedupeSavedModels,
  maskSecret,
  saveAndActivateProvider,
  upsertModelProfile,
  validateProviderForm,
  type ProviderFormValues,
  type ProviderSaveDeps,
} from './provider-storage.js'
import type { CustomApiStorageData, ModelProfile } from '../../utils/customApiStorage.js'

// --- validateProviderForm ---

test('validateProviderForm: missing main model is rejected', () => {
  const values: ProviderFormValues = { provider: 'openai', baseURL: 'https://api.x.com', apiKey: 'sk-1', model: '  ' }
  expect(validateProviderForm(values)).toBe('Main model is required.')
})

test('validateProviderForm: missing API key is rejected', () => {
  const values: ProviderFormValues = { provider: 'openai', baseURL: 'https://api.x.com', apiKey: '', model: 'm1' }
  expect(validateProviderForm(values)).toBe('API key is required.')
})

test('validateProviderForm: openai/responses require a base URL', () => {
  const values: ProviderFormValues = { provider: 'openai', baseURL: '', apiKey: 'sk-1', model: 'm1' }
  expect(validateProviderForm(values)).toBe('Base URL is required for openai providers.')
  expect(validateProviderForm({ ...values, provider: 'responses' })).toBe('Base URL is required for responses providers.')
})

test('validateProviderForm: anthropic without base URL is valid (official endpoint)', () => {
  const values: ProviderFormValues = { provider: 'anthropic', baseURL: '', apiKey: 'sk-1', model: 'm1' }
  expect(validateProviderForm(values)).toBeUndefined()
})

// --- buildModelProfile ---

test('buildModelProfile trims values and drops empty optionals', () => {
  const values: ProviderFormValues = {
    provider: 'openai',
    baseURL: '  https://api.deepseek.com  ',
    apiKey: ' sk-test ',
    model: ' deepseek-v4-pro ',
    opusModel: '   ',
    sonnetModel: '',
    haikuModel: ' deepseek-v4-flash ',
  }
  expect(buildModelProfile(values)).toEqual({
    model: 'deepseek-v4-pro',
    provider: 'openai',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    authTokenType: 'DOGE_API_KEY',
    defaultOpusModel: undefined,
    defaultSonnetModel: undefined,
    defaultHaikuModel: 'deepseek-v4-flash',
  })
})

test('buildModelProfile defaults to DOGE_API_KEY when no key type is chosen', () => {
  const values: ProviderFormValues = {
    provider: 'anthropic',
    baseURL: '',
    apiKey: 'sk-1',
    model: 'm1',
  }
  expect(buildModelProfile(values).authTokenType).toBe('DOGE_API_KEY')
})

test('buildModelProfile persists the selected ANTHROPIC_AUTH_TOKEN key type', () => {
  const values: ProviderFormValues = {
    provider: 'anthropic',
    baseURL: 'https://gw.example.com',
    apiKey: 'sk-bearer',
    authTokenType: 'ANTHROPIC_AUTH_TOKEN',
    model: 'm1',
  }
  const profile = buildModelProfile(values)
  expect(profile.authTokenType).toBe('ANTHROPIC_AUTH_TOKEN')
  expect(profile.baseURL).toBe('https://gw.example.com')
})

// --- maskSecret ---

test('maskSecret masks secrets for display', () => {
  expect(maskSecret(undefined)).toBe('(not set)')
  expect(maskSecret('sk')).toBe('sk…') // short secrets keep a 2-char head
  expect(maskSecret('sk-1234567890abcdef')).toBe('sk-12…cdef')
})

// --- dedupeSavedModels ---

test('dedupeSavedModels appends new models', () => {
  expect(dedupeSavedModels(['a'], 'b')).toEqual(['a', 'b'])
})

test('dedupeSavedModels dedupes case-insensitively and across [1m] suffixes', () => {
  expect(dedupeSavedModels(['deepseek-v4-pro[1m]'], 'DeepSeek-V4-Pro')).toEqual(['DeepSeek-V4-Pro'])
})

// --- upsertModelProfile ---

test('upsertModelProfile inserts when absent and replaces by normalized name', () => {
  const existing: ModelProfile[] = [{ model: 'glm-5' }, { model: 'deepseek-v4-pro', apiKey: 'old' }]
  const withNew = upsertModelProfile(existing, { model: 'kimi-k2' })
  expect(withNew.map(p => p.model)).toEqual(['glm-5', 'deepseek-v4-pro', 'kimi-k2'])

  const withReplaced = upsertModelProfile(existing, { model: 'DeepSeek-V4-Pro[1m]', apiKey: 'new' })
  expect(withReplaced).toHaveLength(2)
  expect(withReplaced[1].apiKey).toBe('new')
})

// --- saveAndActivateProvider ---

function makeHarness(initialStorage: CustomApiStorageData = {}) {
  let storage = initialStorage
  let globalConfig: any = { customApiEndpoint: { model: 'old-model', savedModels: ['old-model'] } }
  const settingsUpdates: Array<{ model: string }> = []
  let switchCall: {
    profile: ModelProfile
    syncToDisk: (model: string, clearCredentials: boolean) => void
    commitAppState: (updater: (prev: any) => any) => void
  } | null = null
  const deps: ProviderSaveDeps = {
    readStorage: () => storage,
    writeStorage: data => { storage = data },
    saveGlobalConfig: updater => { globalConfig = updater(globalConfig) },
    updateSettings: patch => { settingsUpdates.push(patch) },
    switchAtomic: async (profile, d) => {
      switchCall = { profile, syncToDisk: d.syncToDisk, commitAppState: d.commitAppState }
    },
  }
  const setAppState = mock((_updater: (prev: any) => any) => {})
  return {
    deps,
    setAppState,
    settingsUpdates,
    getStorage: () => storage,
    getGlobalConfig: () => globalConfig,
    getSwitchCall: () => switchCall,
  }
}

test('saveAndActivateProvider persists profile, credentials and saved list, then switches atomically', async () => {
  const h = makeHarness({
    model: 'old-model',
    savedModels: ['old-model'],
    modelProfiles: [{ model: 'old-model', provider: 'anthropic' }],
  })
  const profile: ModelProfile = {
    model: 'deepseek-v4-pro',
    provider: 'openai',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    authTokenType: 'DOGE_API_KEY',
    defaultHaikuModel: 'deepseek-v4-flash',
  }

  await saveAndActivateProvider(profile, h.deps, h.setAppState)

  // Explicit save: storage gets model + deduped saved list + profile upsert + top-level credentials
  expect(h.getStorage().model).toBe('deepseek-v4-pro')
  expect(h.getStorage().savedModels).toEqual(['old-model', 'deepseek-v4-pro'])
  expect(h.getStorage().modelProfiles).toHaveLength(2)
  expect(h.getStorage().modelProfiles?.[1]).toBe(profile)
  expect(h.getStorage().apiKey).toBe('sk-test')
  expect(h.getStorage().provider).toBe('openai')
  expect(h.getStorage().authTokenType).toBe('DOGE_API_KEY')

  // .claude.json mirrors the same fields
  expect(h.getGlobalConfig().customApiEndpoint.model).toBe('deepseek-v4-pro')
  expect(h.getGlobalConfig().customApiEndpoint.apiKey).toBe('sk-test')
  expect(h.getGlobalConfig().customApiEndpoint.savedModels).toEqual(['old-model', 'deepseek-v4-pro'])

  // settings.json model updated
  expect(h.settingsUpdates).toEqual([{ model: 'deepseek-v4-pro' }])

  // Atomic activation is invoked with the saved profile
  expect(h.getSwitchCall()?.profile).toBe(profile)

  // Activation syncToDisk moves the model field but keeps credentials (explicit-save semantics)
  h.getSwitchCall()!.syncToDisk('deepseek-v4-pro', true)
  expect(h.getGlobalConfig().customApiEndpoint.model).toBe('deepseek-v4-pro')
  expect(h.getGlobalConfig().customApiEndpoint.apiKey).toBe('sk-test')

  // Activation commitAppState passes through to the React setAppState
  h.getSwitchCall()!.commitAppState(prev => ({ ...prev, mainLoopModel: 'deepseek-v4-pro', mainLoopModelForSession: null }))
  expect(h.setAppState).toHaveBeenCalledTimes(1)
})

test('saveAndActivateProvider replaces an existing profile for the same model', async () => {
  const h = makeHarness({
    model: 'deepseek-v4-pro',
    savedModels: ['deepseek-v4-pro'],
    modelProfiles: [{ model: 'deepseek-v4-pro', provider: 'anthropic', apiKey: 'old-key' }],
  })
  const profile: ModelProfile = {
    model: 'deepseek-v4-pro[1m]',
    provider: 'anthropic',
    apiKey: 'new-key',
    authTokenType: 'DOGE_API_KEY',
  }

  await saveAndActivateProvider(profile, h.deps, h.setAppState)

  expect(h.getStorage().modelProfiles).toHaveLength(1)
  expect(h.getStorage().modelProfiles?.[0].apiKey).toBe('new-key')
  // The saved list keeps a single entry for the same normalized model
  expect(h.getStorage().savedModels).toEqual(['deepseek-v4-pro[1m]'])
})

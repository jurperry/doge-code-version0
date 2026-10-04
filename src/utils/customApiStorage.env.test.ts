import { describe, expect, test } from 'bun:test'
import { modelProfileEnvPatch, type ModelProfile } from './customApiStorage.js'

describe('modelProfileEnvPatch', () => {
  test('maps core provider fields', () => {
    const profile: ModelProfile = {
      model: 'glm-5.3',
      providerName: 'glm官方',
      provider: 'anthropic',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'sk-x',
      contextWindow: 200_000,
    }
    const patch = modelProfileEnvPatch(profile)
    expect(patch.ANTHROPIC_MODEL).toBe('glm-5.3')
    expect(patch.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(patch.CLAUDE_CODE_COMPATIBLE_API_PROVIDER).toBe('anthropic')
    expect(patch.CLAUDE_CODE_MODEL_CONTEXT_WINDOW).toBe('200000')
    // default authTokenType (DOGE_API_KEY) wins and the sibling is cleared
    expect(patch.DOGE_API_KEY).toBe('sk-x')
    expect(patch.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  test('authTokenType ANTHROPIC_AUTH_TOKEN flips the key channel', () => {
    const patch = modelProfileEnvPatch({
      model: 'kimi-k3',
      apiKey: 'tok-1',
      authTokenType: 'ANTHROPIC_AUTH_TOKEN',
    })
    expect(patch.ANTHROPIC_AUTH_TOKEN).toBe('tok-1')
    expect(patch.DOGE_API_KEY).toBeUndefined()
  })

  test('missing apiKey clears both channels (no credential leak)', () => {
    const patch = modelProfileEnvPatch({ model: 'm1' })
    expect(patch.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(patch.DOGE_API_KEY).toBeUndefined()
  })

  test('tier/subagent models and behavior flags round-trip', () => {
    const patch = modelProfileEnvPatch({
      model: 'deepseek-chat',
      defaultOpusModel: 'deepseek-reasoner',
      defaultSonnetModel: 'deepseek-chat',
      subagentModel: 'deepseek-chat',
      opusCapabilities: 'vision',
      disableNonessentialTraffic: true,
    })
    expect(patch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-reasoner')
    expect(patch.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-chat')
    expect(patch.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-chat')
    expect(patch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
    expect(patch.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES).toBe('vision')
    expect(patch['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1')
    expect(patch['CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK']).toBeUndefined()
  })
})

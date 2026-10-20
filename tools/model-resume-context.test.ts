import { expect, test } from 'bun:test'
import { captureModelEnvironment, getModelConnection, rememberAgentModelEnvironment, restoreAgentModelEnvironment, runWithModelEnvironment } from '../src/utils/model/runtimeModelContext.js'

test('worker resume reuses memory connection and restores non-secret identity after restart', () => {
  const base = captureModelEnvironment()
  const profiles = ['a', 'b'].map(id => ({ id, model: `model-${id}`, provider: 'openai' as const, baseURL: `https://${id}.invalid`, apiKey: `fake-${id}` }))
  const a = { ...base, env: { ...base.env, ANTHROPIC_MODEL: 'model-a', ANTHROPIC_BASE_URL: 'https://a.invalid', DOGE_API_KEY: 'old-memory-a', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'openai' }, stored: { modelProfiles: profiles } }
  const b = { ...base, env: { ...base.env, ANTHROPIC_MODEL: 'model-b', ANTHROPIC_BASE_URL: 'https://b.invalid', DOGE_API_KEY: 'fake-b', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'openai' }, stored: { modelProfiles: profiles } }
  const identity = { profileId: 'a', provider: 'openai', baseURL: 'https://a.invalid' }
  rememberAgentModelEnvironment('live-worker', a)
  expect(restoreAgentModelEnvironment('live-worker', identity, b)).toBe(a)
  const resumed = restoreAgentModelEnvironment('restarted-worker', identity, b)
  runWithModelEnvironment(resumed, () => {
    expect(getModelConnection()).toMatchObject({ baseURL: 'https://a.invalid', apiKey: 'fake-a', provider: 'openai' })
  })
  expect(() => restoreAgentModelEnvironment('missing-profile', { ...identity, profileId: 'deleted' }, b)).toThrow('已不存在')
  const edited = { ...b, stored: { modelProfiles: [{ ...profiles[0]!, baseURL: 'https://edited.invalid' }, profiles[1]!] } }
  expect(() => restoreAgentModelEnvironment('edited-profile', identity, edited)).toThrow('原始模型连接')
  expect(() => restoreAgentModelEnvironment('unbound-profile', { provider: 'anthropic', baseURL: 'https://api.anthropic.com' }, b)).toThrow('原始模型连接')
  expect(JSON.stringify(identity)).not.toContain('fake-')
})

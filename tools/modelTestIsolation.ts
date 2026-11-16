const ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_COMPATIBLE_API_PROVIDER',
  'DOGE_ACTIVE_MODEL_PROFILE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'DOGE_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_SIMPLE',
]

export async function resetModelTestState(options: { managed?: boolean } = {}): Promise<void> {
  for (const key of ROUTING_ENV_KEYS) delete process.env[key]

  const [{ getGlobalClaudeFile }, config, settingsCache, runtime, catalog] = await Promise.all([
    import('../src/utils/env.js'),
    import('../src/utils/config.js'),
    import('../src/utils/settings/settingsCache.js'),
    import('../src/utils/model/runtimeModelContext.js'),
    import('../src/utils/model/modelCatalog.js'),
  ])
  const { rmSync } = await import('node:fs')
  rmSync(catalog.catalogFilePath(), { force: true })
  rmSync(`${catalog.catalogFilePath()}.bak`, { force: true })
  getGlobalClaudeFile.cache.clear()
  config._resetGlobalConfigForTesting()
  runtime._resetModelRuntimeContextForTesting()
  settingsCache.resetSettingsCache()
  const auth = await import('../src/utils/auth.js')
  auth.getApiKeyFromConfigOrMacOSKeychain.cache.clear()
  config.saveGlobalConfig(current => {
    const next = { ...current }
    for (const key of [
      'customApiEndpoint', 'env', 'oauthAccount', 'primaryApiKey',
      'model', 'modelProfiles', 'activeProfileId', 'fallbackModel',
    ]) next[key] = undefined
    return next
  })

  if (options.managed) {
    const managed = await import('../src/utils/managedEnv.js')
    managed._resetManagedEnvForTesting()
  }
}

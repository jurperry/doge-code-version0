import { afterAll, expect, mock, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'test', 'model-oauth-source')
const saved = { ...process.env }
process.env.CLAUDE_CONFIG_DIR = dir
delete process.env.CLAUDE_CODE_OAUTH_TOKEN
delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
mkdirSync(dir, { recursive: true })
mock.module('../src/utils/authFileDescriptor.js', () => ({ getOAuthTokenFromFileDescriptor: () => 'ccr-file-token', getApiKeyFromFileDescriptor: () => null }))
afterAll(() => {
  mock.restore()
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(dir, { recursive: true, force: true })
})
test('worker captures CCR file fallback without an FD env and keeps inference-only source', async () => {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'wrong-storage-token' } }))
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const snapshot = ctx.captureModelEnvironment()
  await ctx.runWithModelEnvironment(snapshot, async () => {
    expect(ctx.getModelOAuthTokens()?.accessToken).toBe('ccr-file-token')
    expect((await ctx.readUpdatedModelOAuthTokens())?.accessToken).toBe('ccr-file-token')
  })
})

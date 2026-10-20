import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensureBootstrapMacro } from '../src/bootstrapMacro.js'
ensureBootstrapMacro()
const saved = { ...process.env }
const dir = join(process.cwd(), 'test', 'model-profile-wire')
mkdirSync(dir, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = dir
process.env.DOGE_API_KEY = 'fake-wire-key'
process.env.DOGE_ACTIVE_MODEL_PROFILE = 'profile-a'
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(dir, { recursive: true, force: true })
})

test('init metadata publishes the worker profile identity without credentials', async () => {
  const { buildSystemInitMessage } = await import('../src/utils/messages/systemInit.js')
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const snapshot = ctx.captureModelEnvironment()
  process.env.DOGE_ACTIVE_MODEL_PROFILE = 'profile-b'
  ctx.runWithModelEnvironment(snapshot, () => {
    const init = buildSystemInitMessage({ tools: [], mcpClients: [], model: 'shared-main', permissionMode: 'default', commands: [], agents: [], skills: [], plugins: [], fastMode: false })
    expect((init as any).profile_id).toBe('profile-a')
    expect(JSON.stringify(init)).not.toContain('fake-wire-key')
  })
})

test('get_settings schema preserves the public runtime profile identity', async () => {
  const { SDKControlGetSettingsResponseSchema } = await import('../src/entrypoints/sdk/controlSchemas.js')
  const parsed = SDKControlGetSettingsResponseSchema().parse({ effective: {}, sources: [], applied: { model: 'shared-main', profileId: 'profile-b', effort: null } })
  expect(parsed.applied?.profileId).toBe('profile-b')
})

test('clearing an unchanged worktree preserves persisted worker model selection', async () => {
  const { asAgentId } = await import('../src/types/ids.js')
  const { writeAgentMetadata, readAgentMetadata } = await import('../src/utils/sessionStorage.js')
  const agentId = asAgentId('metadata-selection')
  const modelSelection = { requestedModel: 'haiku', resolvedModel: 'glm-5.3-flash', source: 'tool' as const }
  await writeAgentMetadata(agentId, { agentType: 'general-purpose', modelSelection, worktreePath: 'E:/old-worktree' })
  await writeAgentMetadata(agentId, { agentType: 'general-purpose', description: 'kept description', worktreePath: undefined })
  expect((await readAgentMetadata(agentId))?.modelSelection).toEqual(modelSelection)
  expect((await readAgentMetadata(agentId))?.worktreePath).toBeUndefined()
})

test('remote metadata remains independent of local worker identity patches', async () => {
  const { writeRemoteAgentMetadata, readRemoteAgentMetadata } = await import('../src/utils/sessionStorage.js')
  const record = { taskId: 'remote-safe', remoteTaskType: 'test', sessionId: 'remote-session', title: 'remote', command: 'test', spawnedAt: 1 }
  await writeRemoteAgentMetadata(record.taskId, record)
  expect(await readRemoteAgentMetadata(record.taskId)).toEqual(record)
})

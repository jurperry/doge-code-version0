import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, test } from 'bun:test'

const TMP = mkdtempSync(join(tmpdir(), 'doge-teamdelete-'))
process.env.CLAUDE_CONFIG_DIR = TMP

const { TeamDeleteTool } = await import('./TeamDeleteTool.js')
const { writeTeamFileAsync, readTeamFile } = await import(
  '../../utils/swarm/teamHelpers.js'
)

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

function fakeContext(tasks: Record<string, unknown> = {}) {
  let state = {
    teamContext: { teamName: 'zombie-team', teammates: {} },
    tasks,
  }
  return {
    getAppState: () => state,
    setAppState: (fn: (prev: typeof state) => typeof state) => {
      state = fn(state)
    },
  } as never
}

async function createTeamWithZombieMember() {
  await writeTeamFileAsync('zombie-team', {
    teamName: 'zombie-team',
    createdAt: Date.now(),
    leadAgentId: 'lead@zombie-team',
    members: [
      { agentId: 'lead@zombie-team', name: 'team-lead', joinedAt: Date.now() },
      {
        // Stale registration: isActive never flipped (crash / lost write),
        // but no running task exists in AppState.
        agentId: 'zombie@zombie-team',
        name: 'zombie-researcher',
        joinedAt: Date.now(),
        backendType: 'in-process',
      },
    ],
  } as never)
}

describe('TeamDelete — in-process zombie member exemption', () => {
  test('stale in-process member with no running task does not block deletion', async () => {
    await createTeamWithZombieMember()
    const tool = TeamDeleteTool as never
    const result = await tool.call({}, fakeContext())
    expect((result.data as { success: boolean }).success).toBe(true)
    // Team file cleaned up
    expect(readTeamFile('zombie-team')).toBeNull()
  })

  test('in-process member with a RUNNING task still blocks deletion', async () => {
    await createTeamWithZombieMember()
    const tasks = {
      'task-1': {
        id: 'task-1',
        type: 'in_process_teammate',
        status: 'running',
        identity: { agentId: 'zombie@zombie-team', agentName: 'zombie-researcher' },
      },
    }
    const tool = TeamDeleteTool as never
    const result = await tool.call({}, fakeContext(tasks))
    expect((result.data as { success: boolean }).success).toBe(false)
    expect((result.data as { message: string }).message).toContain(
      'active member',
    )
  })
})

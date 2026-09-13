import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const TMP = mkdtempSync(join(tmpdir(), 'doge-teamhelpers-'))
process.env.CLAUDE_CONFIG_DIR = TMP

const {
  mutateTeamFileAsync,
  readTeamFile,
  removeTeammateFromTeamFile,
  setMemberActive,
  writeTeamFileAsync,
} = await import('./teamHelpers.js')

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const TEAM = 'lock-test-team'

async function createTeam() {
  await writeTeamFileAsync(TEAM, {
    teamName: TEAM,
    createdAt: Date.now(),
    leadAgentId: 'lead@lock-test-team',
    members: [
      { agentId: 'lead@lock-test-team', name: 'team-lead', joinedAt: Date.now() },
    ],
  } as never)
}

beforeAll(createTeam)

describe('mutateTeamFileAsync — locked read-modify-write', () => {
  test('concurrent member registrations all survive (lost-update regression)', async () => {
    // Reproduces the live bug: N parallel spawns each did an unlocked
    // read→push→write and the last writer erased everyone else.
    const N = 10
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutateTeamFileAsync(TEAM, tf => {
          tf.members.push({
            agentId: `agent-${i}@${TEAM}`,
            name: `researcher-${i}`,
            joinedAt: Date.now(),
          })
        }),
      ),
    )
    const tf = readTeamFile(TEAM)
    expect(tf?.members.filter(m => m.name.startsWith('researcher-'))).toHaveLength(N)
  })

  test('returns null when the team file does not exist', async () => {
    const result = await mutateTeamFileAsync('no-such-team', () => 42)
    expect(result).toBeNull()
  })
})

describe('setMemberActive', () => {
  test('flips isActive under the lock without losing other members', async () => {
    await setMemberActive(TEAM, 'researcher-0', false)
    const tf = readTeamFile(TEAM)
    expect(tf?.members.find(m => m.name === 'researcher-0')?.isActive).toBe(false)
    expect(tf?.members.find(m => m.name === 'researcher-1')?.isActive).toBeUndefined()
    // idempotent second call must not throw
    await setMemberActive(TEAM, 'researcher-0', false)
  })
})

describe('removeTeammateFromTeamFile', () => {
  test('removes by name (registry-miss fallback path)', async () => {
    const removed = await removeTeammateFromTeamFile(TEAM, {
      name: 'researcher-9',
    })
    expect(removed).toBe(true)
    expect(
      readTeamFile(TEAM)?.members.some(m => m.name === 'researcher-9'),
    ).toBe(false)
  })

  test('returns false when the member is absent', async () => {
    const removed = await removeTeammateFromTeamFile(TEAM, {
      name: 'ghost',
    })
    expect(removed).toBe(false)
  })
})

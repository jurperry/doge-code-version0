import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const TMP = mkdtempSync(join(tmpdir(), 'doge-teamhelpers-'))
process.env.CLAUDE_CONFIG_DIR = TMP

const {
  mutateTeamFileAsync,
  readTeamFile,
  removeMemberByAgentId,
  removeMemberFromTeam,
  removeTeammateFromTeamFile,
  setMemberActive,
  setMemberMode,
  setMultipleMemberModes,
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

describe('removeMemberFromTeam / removeMemberByAgentId — locked removals', () => {
  test('concurrent removals and spawn registrations do not lose each other', async () => {
    // Reproduces the unlocked-RMW class: TeamsDialog terminate racing a
    // concurrent spawn push used to erase one side's change.
    await Promise.all([
      removeMemberFromTeam(TEAM, 'pane-7'),
      removeMemberByAgentId(TEAM, 'agent-3@lock-test-team'),
      mutateTeamFileAsync(TEAM, tf => {
        tf.members.push({
          agentId: 'spawn-racer@lock-test-team',
          name: 'spawn-racer',
          joinedAt: Date.now(),
        })
      }),
    ])
    const tf = readTeamFile(TEAM)
    expect(tf?.members.some(m => m.name === 'spawn-racer')).toBe(true)
    expect(tf?.members.some(m => m.agentId === 'agent-3@lock-test-team')).toBe(false)
    expect(tf?.members.some(m => m.tmuxPaneId === 'pane-7')).toBe(false)
  })

  test('removeMemberByAgentId returns false for a missing team or member', async () => {
    expect(await removeMemberByAgentId('no-such-team', 'x@no-such-team')).toBe(false)
    expect(await removeMemberByAgentId(TEAM, 'ghost@lock-test-team')).toBe(false)
  })
})

describe('setMemberMode / setMultipleMemberModes — locked mode updates', () => {
  test('setMemberMode updates the member and returns true (unchanged → true too)', async () => {
    expect(await setMemberMode(TEAM, 'researcher-0', 'acceptEdits')).toBe(true)
    expect(readTeamFile(TEAM)?.members.find(m => m.name === 'researcher-0')?.mode).toBe('acceptEdits')
    // Same value again — still success, no write churn.
    expect(await setMemberMode(TEAM, 'researcher-0', 'acceptEdits')).toBe(true)
  })

  test('setMemberMode returns false for a missing member or team', async () => {
    expect(await setMemberMode(TEAM, 'ghost', 'default')).toBe(false)
    expect(await setMemberMode('no-such-team', 'researcher-0', 'default')).toBe(false)
  })

  test('setMultipleMemberModes updates all members atomically under the lock', async () => {
    const ok = await setMultipleMemberModes(TEAM, [
      { memberName: 'researcher-1', mode: 'plan' },
      { memberName: 'researcher-2', mode: 'plan' },
    ])
    expect(ok).toBe(true)
    const tf = readTeamFile(TEAM)
    expect(tf?.members.find(m => m.name === 'researcher-1')?.mode).toBe('plan')
    expect(tf?.members.find(m => m.name === 'researcher-2')?.mode).toBe('plan')
    expect(await setMultipleMemberModes('no-such-team', [])).toBe(false)
  })
})

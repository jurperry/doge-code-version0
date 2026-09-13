import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, test } from 'bun:test'
import { enrichLogs } from './sessionStorage.js'
import type { LogOption } from '../types/logs.js'

// Regression for the /resume bug where every /agent-teams conversation
// vanished from the picker: useLogMessages stamps teamName on the LEAD's
// messages once a team exists, and enrichLog filtered on teamName alone —
// hiding the user's own conversation. Only teammate worker sessions
// (teamName + agentName) should be filtered.
const tmp = mkdtempSync(join(tmpdir(), 'doge-resume-filter-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function sessionFile(name: string, lines: Array<Record<string, unknown>>) {
  const path = join(tmp, name)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n'), 'utf8')
  return path
}

function liteLog(sessionId: string, fullPath: string, size: number): LogOption {
  return {
    date: new Date().toISOString(),
    messages: [],
    isLite: true,
    fullPath,
    value: 0,
    created: new Date(),
    modified: new Date(),
    firstPrompt: '',
    messageCount: 0,
    fileSize: size,
    isSidechain: false,
    sessionId,
  } as LogOption
}

function fileSizeOf(path: string): number {
  return require('fs').statSync(path).size
}

describe('/resume session filtering (enrichLogs)', () => {
  test('lead session (teamName only) stays resumable', async () => {
    const path = sessionFile('lead.jsonl', [
      {
        type: 'user',
        isSidechain: false,
        cwd: 'E:\\proj',
        teamName: 'agent-teams-analysis',
        message: { role: 'user', content: '请分析 agent-teams 实现' },
      },
      {
        type: 'assistant',
        isSidechain: false,
        teamName: 'agent-teams-analysis',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
    ])
    const { logs } = await enrichLogs(
      [liteLog('lead-1', path, fileSizeOf(path))],
      0,
      10,
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]!.teamName).toBe('agent-teams-analysis')
    expect(logs[0]!.agentName).toBeUndefined()
  })

  test('teammate session (teamName + agentName) is filtered out', async () => {
    const path = sessionFile('teammate.jsonl', [
      {
        type: 'user',
        isSidechain: false,
        cwd: 'E:\\proj',
        teamName: 'agent-teams-analysis',
        agentName: 'tools-researcher',
        message: { role: 'user', content: 'research the tools layer' },
      },
    ])
    const { logs } = await enrichLogs(
      [liteLog('tm-1', path, fileSizeOf(path))],
      0,
      10,
    )
    expect(logs).toHaveLength(0)
  })

  test('normal session (no team) stays resumable', async () => {
    const path = sessionFile('plain.jsonl', [
      {
        type: 'user',
        isSidechain: false,
        cwd: 'E:\\proj',
        message: { role: 'user', content: 'hello' },
      },
    ])
    const { logs } = await enrichLogs(
      [liteLog('plain-1', path, fileSizeOf(path))],
      0,
      10,
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]!.teamName).toBeUndefined()
  })
})

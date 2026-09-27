/**
 * Regression tests for the per-turn snapshot race: the snapshot trigger
 * points used to fire-and-forget fileHistoryMakeSnapshot, so the turn's
 * first Edit/Write could land before the async backup IO finished — a
 * rewind to that message then restored mid-turn content instead of the
 * pre-turn state. The call sites now await the snapshot; these tests pin
 * the promise contract they rely on (the promise resolves only after the
 * backup is on disk) and the size short-circuit that must beat the mtime
 * shortcut in compareStatsAndContent.
 */
import { randomUUID } from 'crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, test } from 'bun:test'
import { getSessionId } from '../bootstrap/state.js'
import {
  fileHistoryMakeSnapshot,
  type FileHistoryState,
} from './fileHistory.js'

// Tests run non-interactive, so fileHistoryEnabled() takes the SDK path.
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
const savedSdkFlag = process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
const savedDisableFlag = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
const configDir = mkdtempSync(join(tmpdir(), 'doge-fh-config-'))
const workDir = mkdtempSync(join(tmpdir(), 'doge-fh-work-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (savedSdkFlag === undefined)
    delete process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
  else process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = savedSdkFlag
  if (savedDisableFlag === undefined)
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  else process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = savedDisableFlag
  rmSync(configDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

function backupContent(backupFileName: string): string {
  return readFileSync(
    join(configDir, 'file-history', getSessionId(), backupFileName),
    'utf8',
  )
}

function seedState(trackingPath: string): FileHistoryState {
  return {
    snapshots: [
      {
        messageId: randomUUID(),
        trackedFileBackups: {},
        timestamp: new Date(),
      },
    ],
    trackedFiles: new Set([trackingPath]),
    snapshotSequence: 1,
  }
}

function makeHarness(initial: FileHistoryState) {
  let state = initial
  return {
    get state() {
      return state
    },
    update(updater: (prev: FileHistoryState) => FileHistoryState) {
      state = updater(state)
    },
  }
}

describe('fileHistoryMakeSnapshot await contract', () => {
  test('resolved promise means the backup is on disk with pre-edit content', async () => {
    const file = join(workDir, 'tracked.txt')
    writeFileSync(file, 'before-turn', 'utf8')
    const h = makeHarness(seedState(file))

    await fileHistoryMakeSnapshot(h.update, randomUUID())

    const backup1 = h.state.snapshots.at(-1)!.trackedFileBackups[file]!
    expect(backup1.backupFileName).not.toBeNull()
    expect(backupContent(backup1.backupFileName!)).toBe('before-turn')

    // The turn's first write happens strictly after the await.
    writeFileSync(file, 'mid-turn-edit', 'utf8')
    await fileHistoryMakeSnapshot(h.update, randomUUID())

    const backup2 = h.state.snapshots.at(-1)!.trackedFileBackups[file]!
    expect(backup2.backupFileName).not.toBeNull()
    expect(backup2.backupFileName).not.toBe(backup1.backupFileName)
    // Rewinding to the first snapshot restores the pre-turn state.
    expect(backupContent(backup1.backupFileName!)).toBe('before-turn')
    expect(backupContent(backup2.backupFileName!)).toBe('mid-turn-edit')
  })

  test('size change forces a new backup even when mtime predates the backup', async () => {
    const file = join(workDir, 'sized.txt')
    writeFileSync(file, 'aaaa', 'utf8')
    const h = makeHarness(seedState(file))
    await fileHistoryMakeSnapshot(h.update, randomUUID())
    const backup1 = h.state.snapshots.at(-1)!.trackedFileBackups[file]!

    // Different size, but mtime backdated behind the backup so a pure-mtime
    // shortcut would wrongly report "unchanged" and reuse the stale backup.
    writeFileSync(file, 'bb', 'utf8')
    const past = new Date(Date.now() - 60_000)
    utimesSync(file, past, past)

    await fileHistoryMakeSnapshot(h.update, randomUUID())
    const backup2 = h.state.snapshots.at(-1)!.trackedFileBackups[file]!
    expect(backup2.backupFileName).not.toBeNull()
    expect(backup2.backupFileName).not.toBe(backup1.backupFileName)
    expect(backupContent(backup2.backupFileName!)).toBe('bb')
  })
})

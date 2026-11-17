// The marker's mtime is lastConsolidatedAt. A separate, expiring lease
// prevents simultaneous dreams and lets a crashed process be retried.
//
// Lives inside the memory dir (getAutoMemPath) so it keys on git-root
// like memory does, and so it's writable even when the memory path comes
// from an env/settings override whose parent may not be.

import { mkdir, open, stat } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { listCandidates } from '../../utils/listSessionsImpl.js'
import { lock } from '../../utils/lockfile.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { findProjectDir } from '../../utils/sessionStoragePortable.js'

const LOCK_FILE = '.consolidate-lock'

function markerPath(): string {
  return join(getAutoMemPath(), LOCK_FILE)
}

/**
 * mtime of the lock file = lastConsolidatedAt. 0 if absent.
 * Per-turn cost: one stat.
 */
export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const s = await stat(markerPath())
    return s.mtimeMs
  } catch {
    return 0
  }
}

/**
 * Acquire a lease for this project's memory directory. Recheck the marker
 * under the lease in case another process finished during the session scan.
 */
export async function tryAcquireConsolidationLock(
  observedMtime: number,
  abortController: AbortController,
): Promise<(() => Promise<void>) | null> {
  await mkdir(getAutoMemPath(), { recursive: true })
  let release: () => Promise<void>
  try {
    release = await lock(markerPath(), {
      realpath: false,
      onCompromised: error => abortController.abort(error),
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return null
    throw error
  }

  if (await readLastConsolidatedAt() === observedMtime) return release
  await release()
  return null
}

/**
 * Session IDs with mtime after sinceMs. listCandidates handles UUID
 * validation (excludes agent-*.jsonl) and parallel stat.
 *
 * Uses mtime (sessions TOUCHED since), not birthtime (0 on ext4).
 * Caller excludes the current session. Scans per-cwd transcripts — it's
 * a skip-gate, so undercounting worktree sessions is safe.
 */
export async function listSessionsTouchedSince(
  sinceMs: number,
): Promise<string[]> {
  // Read path: findProjectDir tolerates hash-suffix mismatches on long paths.
  const dir =
    (await findProjectDir(getOriginalCwd())) ?? getProjectDir(getOriginalCwd())
  const candidates = await listCandidates(dir, true)
  return candidates.filter(c => c.mtime > sinceMs).map(c => c.sessionId)
}

/**
 * Commit the transcript scan watermark after a successful background dream.
 */
export async function recordConsolidation(scannedAt: number): Promise<void> {
  const marker = await open(markerPath(), 'a')
  try {
    const timestamp = new Date(scannedAt)
    await marker.utimes(timestamp, timestamp)
  } finally {
    await marker.close()
  }
}

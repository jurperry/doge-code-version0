export type TurnStartTime = number

/**
 * Restored runtime constants. The reverse-engineered snapshot originally
 * shipped this file with types only, so the named-import of these values in
 * filePersistence.ts failed at ESM link time — every dynamic import of
 * cli/print.ts (which pulls this module) rejected, and headless `-p` hung on
 * Windows. Values are conservative re-derivations from usage (BYOC remote
 * file persistence only; runFilePersistence no-ops unless the environment is
 * byoc).
 */

/** Max parallel uploads to the Files API. */
export const DEFAULT_UPLOAD_CONCURRENCY = 5

/** Cap on modified files persisted per turn. */
export const FILE_COUNT_LIMIT = 100

/** Subdirectory (under the session dir) scanned for output files. */
export const OUTPUTS_SUBDIR = 'outputs'

export type PersistedFile = {
  filename: string
  file_id: string
}

export type FailedPersistence = {
  filename: string
  error: string
}

export type FilesPersistedEventData = {
  files: PersistedFile[]
  failed: FailedPersistence[]
}

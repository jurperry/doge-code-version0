import { getInitialSettings } from '../settings/settings.js'
import type { ShellType } from './shellProvider.js'

/**
 * Session-level shell override (in-process memory, module singleton).
 *
 * At process start the disk-effective value (settings.defaultShell ?? 'bash')
 * is snapshotted as THIS session's shell via initSessionShellSnapshot().
 * From then on, disk settings.json changes (changeDetector →
 * resetSettingsCache) no longer retarget the active shell of an
 * already-running session — concurrent sessions keep whatever shell they
 * started with, and only new processes snapshot the new value.
 *
 * /shell rewrites the override via setSessionShell() so the selection takes
 * effect on the next turn, alongside the persisted userSettings write.
 *
 * The resolution order itself lives in resolveDefaultShell.ts:
 *   session override → settings.defaultShell → 'bash'
 */

let sessionShell: ShellType | null = null

/**
 * Freeze the current disk-effective value as this session's shell.
 * Idempotent (first call wins) — called once from process init, before the
 * first resolveDefaultShell() consumer (setShellIfWindows).
 */
export function initSessionShellSnapshot(): void {
  if (sessionShell !== null) return
  sessionShell = getInitialSettings().defaultShell ?? 'bash'
}

/**
 * This session's shell override; null until snapshotted (resolveDefaultShell
 * then falls back to live settings, i.e. pre-init behavior).
 */
export function getSessionShell(): ShellType | null {
  return sessionShell
}

/**
 * /shell selection: override this session immediately. Persisting to
 * userSettings is the caller's job (applyShellSelection does both).
 */
export function setSessionShell(shell: ShellType): void {
  sessionShell = shell
}

/** Test-only reset. */
export function resetSessionShellForTests(): void {
  sessionShell = null
}

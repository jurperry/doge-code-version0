import { PROFILE_MANAGED_ENV_KEYS, type ProfileManagedEnvKey } from './profileEnvKeys.js'

export type ModelSwitchPhase = 'apply' | 'persist' | 'commit'

export class ModelSwitchError extends Error {
  readonly phase: ModelSwitchPhase
  constructor(phase: ModelSwitchPhase, cause: unknown) {
    super(
      `Model switch failed at ${phase}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'ModelSwitchError'
    this.phase = phase
  }
}

/**
 * Delete all profile-managed env vars unconditionally.
 *
 * MUST be called as step 2 of switchModelProfileAtomic (after snapshot,
 * before applyModelProfile). Safe to call repeatedly; `delete` on an
 * undefined key is a no-op.
 */
export function clearProfileEnvVars(): void {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    delete process.env[key]
  }
}

/**
 * Capture current values of all profile-managed env vars for rollback.
 */
export function captureEnvSnapshot(): Record<ProfileManagedEnvKey, string | undefined> {
  const snapshot = {} as Record<ProfileManagedEnvKey, string | undefined>
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    snapshot[key] = process.env[key]
  }
  return snapshot
}

/**
 * Restore env vars from a snapshot. Deletes keys that were undefined in
 * the snapshot rather than setting them to the string "undefined".
 */
export function restoreEnvSnapshot(snapshot: Record<ProfileManagedEnvKey, string | undefined>): void {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    const value = snapshot[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

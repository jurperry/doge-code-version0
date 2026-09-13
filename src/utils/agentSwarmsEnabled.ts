import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * Check if --agent-teams flag is provided via CLI.
 * Checks process.argv directly to avoid import cycles with bootstrap/state.
 * Note: The flag is only shown in help for ant users, but if external users
 * pass it anyway, it will work (subject to the killswitch).
 */
function isAgentTeamsFlagSet(): boolean {
  return process.argv.includes('--agent-teams')
}

/**
 * Opt-in check only (env var OR --agent-teams flag), without the ant or
 * killswitch layers. Callers that need "already opted in?" semantics — e.g.
 * the keyword trigger redirect, which must not re-hijack messages once the
 * session is opted in even if the killswitch later blocks the feature —
 * should use this instead of isAgentSwarmsEnabled().
 */
export function isAgentSwarmsOptedIn(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) ||
    isAgentTeamsFlagSet()
  )
}

/**
 * Opt this process into agent teams at runtime (via /agent-teams or the
 * keyword trigger). Sets the same env var the CLI flag and teammate child
 * processes use (spawnUtils forces it on children), so every
 * isAgentSwarmsEnabled() call site picks it up — the gate is evaluated
 * dynamically per call and the tool list is rebuilt per query. Deliberately
 * in-process only: parallel terminals are unaffected.
 */
export function enableAgentSwarmsForSession(): void {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
}

/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * Ant builds: always enabled.
 * External builds require both:
 * 1. Opt-in via CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var OR --agent-teams flag
 *    (runtime opt-in via enableAgentSwarmsForSession sets the env var)
 * 2. GrowthBook gate 'tengu_amber_flint' enabled (killswitch)
 */
export function isAgentSwarmsEnabled(): boolean {
  // Ant: always on
  if (process.env.USER_TYPE === 'ant') {
    return true
  }

  // External: require opt-in via env var or --agent-teams flag
  if (!isAgentSwarmsOptedIn()) {
    return false
  }

  // Killswitch — always respected for external users
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) {
    return false
  }

  return true
}

/**
 * Shared utilities for spawning teammates across different backends.
 */

import { getModelEnvironment } from '../model/runtimeModelContext.js'
import { quote } from '../bash/shellQuote.js'

/**
 * Environment variables that must be explicitly forwarded to tmux-spawned
 * teammates. Tmux may start a new login shell that doesn't inherit the
 * parent's env, so we forward any that are set in the current process.
 */
const TEAMMATE_ENV_VARS = [
  // API provider selection — without these, teammates default to firstParty
  // and send requests to the wrong endpoint (GitHub issue #23561)
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // Custom API endpoint
  'ANTHROPIC_BASE_URL',
  'DOGE_ACTIVE_MODEL_PROFILE',
  'ANTHROPIC_MODEL',
  // API protocol selection — without it a tmux teammate falls back to the
  // anthropic format while the lead talks openai/responses to the same URL
  'CLAUDE_CODE_COMPATIBLE_API_PROVIDER',
  // Tier model slots — teammates resolve opus/sonnet/haiku aliases and
  // subagent models through the same env chain the lead does; without these
  // an alias like `model: 'sonnet'` in a teammate expands to first-party
  // model ids and gets sent to a third-party endpoint
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_DISABLE_EFFORT',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
  // Config directory override
  'CLAUDE_CONFIG_DIR',
  // CCR marker — teammates need this for CCR-aware code paths. Auth finds
  // its own way via /home/claude/.claude/remote/.oauth_token regardless;
  // the FD env var wouldn't help (pipe FDs don't cross tmux).
  'CLAUDE_CODE_REMOTE',
  // Auto-memory gate (memdir/paths.ts) checks REMOTE && !MEMORY_DIR to
  // disable memory on ephemeral CCR filesystems. Forwarding REMOTE alone
  // would flip teammates to memory-off when the parent has it on.
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  // Upstream proxy — the parent's MITM relay is reachable from teammates
  // (same container network). Forward the proxy vars so teammates route
  // customer-configured upstream traffic through the relay for credential
  // injection. Without these, teammates bypass the proxy entirely.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const

/**
 * Builds the `env KEY=VALUE ...` string for teammate spawn commands.
 * Always includes CLAUDECODE=1 and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1,
 * plus any provider/config env vars that are set in the current process.
 */
export function buildInheritedEnvVars(): string {
  const envVars = ['CLAUDECODE=1', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1']

  for (const key of TEAMMATE_ENV_VARS) {
    const value = getModelEnvironment()[key]
    if (value !== undefined && value !== '') {
      envVars.push(`${key}=${quote([value])}`)
    }
  }

  return envVars.join(' ')
}

/**
 * SECURITY: this whitelist is embedded in the tmux spawn COMMAND STRING,
 * which is visible to every local user via `ps`. Secret-bearing vars
 * (DOGE_API_KEY / ANTHROPIC_AUTH_TOKEN / …) must NEVER be added here —
 * teammates get credentials from the shared CLAUDE_CONFIG_DIR disk storage,
 * not from the spawn command.
 *
 * Detects the config that whitelist can't serve: the key exists in THIS
 * process's env but was never persisted to storage (env-only start script
 * with no /provider entry). A tmux teammate then inherits the base URL but
 * no key and 401s on its first request — surfaced so spawn sites can warn.
 * Pure — takes the parsed storage so tests can inject.
 */
export function isEnvOnlyCredentialConfig(storage: {
  apiKey?: string
}): boolean {
  return (
    (!!process.env.DOGE_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN) &&
    !storage.apiKey
  )
}

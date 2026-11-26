import { isEnvTruthy } from './envUtils.js'

/**
 * Env vars to strip from subprocess environments when running inside GitHub
 * Actions. This prevents prompt-injection attacks from exfiltrating secrets
 * via shell expansion (e.g., ${DOGE_API_KEY}) in Bash tool commands.
 *
 * The parent claude process keeps these vars (needed for API calls, lazy
 * credential reads). Only child processes (bash, shell snapshot, MCP stdio, LSP, hooks) are scrubbed.
 *
 * GITHUB_TOKEN / GH_TOKEN are intentionally NOT scrubbed — wrapper scripts
 * (gh.sh) need them to call the GitHub API. That token is job-scoped and
 * expires when the workflow ends.
 */
const GHA_SUBPROCESS_SCRUB = [
  // Anthropic auth — claude re-reads these per-request, subprocesses don't need them
  'DOGE_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'DOGE_SSH_PROXY_TOKEN',
  'ANTHROPIC_UNIX_SOCKET',

  // OTLP exporter headers — documented to carry Authorization=Bearer tokens
  // for monitoring backends; read in-process by OTEL SDK, subprocesses never need them
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',

  // Cloud provider creds — same pattern (lazy SDK reads)
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',

  // GitHub Actions OIDC — consumed by the action's JS before claude spawns;
  // leaking these allows minting an App installation token → repo takeover
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',

  // GitHub Actions artifact/cache API — cache poisoning → supply-chain pivot
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',

  // claude-code-action-specific duplicates — action JS consumes these during
  // prepare, before spawning claude. ALL_INPUTS contains anthropic_api_key as JSON.
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
] as const

/**
 * Fork credentials stripped from subprocess environments BY DEFAULT. The
 * parent doge process re-reads these per request; child processes (Bash tool,
 * shell snapshot, MCP stdio, LSP, hooks) never need them. Without this scrub,
 * a prompt-injected `echo $DOGE_API_KEY` in any Bash command exfiltrates the
 * key — the fork's primary credential, since /auto sessions and the
 * always-on Computer Use gates make unattended tool runs a first-class path.
 *
 * Deliberately NARROWER than GHA_SUBPROCESS_SCRUB: cloud provider creds
 * (AWS, AZURE, …) are NOT stripped by default — on a dev machine, running
 * `aws`/`az` in the Bash tool with ambient creds is a legitimate workflow.
 * The full CI list remains available via CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1.
 */
const DEFAULT_SUBPROCESS_SCRUB = [
  'DOGE_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'DOGE_SSH_PROXY_TOKEN',
  'ANTHROPIC_UNIX_SOCKET',
] as const

/**
 * Returns a copy of process.env with sensitive secrets stripped, for use when
 * spawning subprocesses (Bash tool, shell snapshot, MCP stdio servers, LSP
 * servers, shell hooks).
 *
 * Modes (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB):
 *  - unset            → DEFAULT fork-credential scrub (DOGE_API_KEY etc.).
 *  - truthy ('1'/...) → full CI scrub list (claude-code-action sets this when
 *                       `allowed_non_write_users` exposes the workflow to
 *                       untrusted content; GHA/cloud/OIDC vars included).
 *  - falsy ('0'/...)  → no scrubbing at all (escape hatch for setups that
 *                       genuinely need credentials in child envs).
 */
// Registered by init.ts after the upstreamproxy module is dynamically imported
// in CCR sessions. Stays undefined in non-CCR startups so we never pull in the
// upstreamproxy module graph (upstreamproxy.ts + relay.ts) via a static import.
let _getUpstreamProxyEnv: (() => Record<string, string>) | undefined

/**
 * Called from init.ts to wire up the proxy env function after the upstreamproxy
 * module has been lazily loaded. Must be called before any subprocess is spawned.
 */
export function registerUpstreamProxyEnvFn(
  fn: () => Record<string, string>,
): void {
  _getUpstreamProxyEnv = fn
}

export function subprocessEnv(): NodeJS.ProcessEnv {
  // CCR upstreamproxy: inject HTTPS_PROXY + CA bundle vars so curl/gh/python
  // in agent subprocesses route through the local relay. Returns {} when the
  // proxy is disabled or not registered (non-CCR), so this is a no-op outside
  // CCR containers.
  const proxyEnv = _getUpstreamProxyEnv?.() ?? {}

  const scrubFlag = process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
  const fullScrub = isEnvTruthy(scrubFlag)
  // Explicit falsy value ('0'/'false'/...) = opt-out; unset/empty = default scrub.
  const scrubDisabled =
    scrubFlag !== undefined && scrubFlag !== '' && !fullScrub

  if (scrubDisabled) {
    return Object.keys(proxyEnv).length > 0
      ? { ...process.env, ...proxyEnv }
      : process.env
  }
  const env = { ...process.env, ...proxyEnv }
  const scrubList = fullScrub ? GHA_SUBPROCESS_SCRUB : DEFAULT_SUBPROCESS_SCRUB
  for (const k of scrubList) {
    delete env[k]
    // GitHub Actions auto-creates INPUT_<NAME> for `with:` inputs, duplicating
    // secrets like INPUT_DOGE_API_KEY. No-op for vars that aren't action inputs.
    delete env[`INPUT_${k}`]
  }
  return env
}

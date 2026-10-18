/**
 * Deterministic unit-test credentials.
 *
 * A handful of pre-existing suites (auth/branch lookups, agent-teams gating)
 * assume a credential is present and are order-sensitive without one. Provide
 * a dummy only when the caller has no key, so `bun test` is hermetic without
 * requiring real credentials. Never used outside the test runner (bunfig
 * `[test].preload`).
 */
if (
  !process.env.DOGE_API_KEY &&
  !process.env.ANTHROPIC_AUTH_TOKEN &&
  !process.env.ANTHROPIC_API_KEY
) {
  process.env.DOGE_API_KEY = 'sk-test-dummy'
}

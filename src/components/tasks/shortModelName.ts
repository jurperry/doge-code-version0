/**
 * Short model label for unified agent-panel rows: strip the local-only
 * [1m]/[2m] context suffix (never sent to the API) and trim. Empty →
 * fallback label. Shared by CoordinatorAgentStatus (main/local rows) and
 * TeammateAgentLine (teammate rows) so every row shows the model in the
 * same form — kept in its own module so the panel component (a React
 * Compiler artifact) and the teammate row (plain source) don't import
 * each other for one helper.
 */
export function shortModelName(
  model: string | undefined,
  fallback = 'default',
): string {
  const m = (model ?? '').trim()
  if (!m) return fallback
  return m.replace(/\[[12]m\]$/i, '')
}

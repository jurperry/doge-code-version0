/** Non-secret model identity captured at worker creation. Never used as API model text. */
export interface AgentModelSelection {
  requestedModel: string
  resolvedModel: string
  source: 'environment' | 'tool' | 'definition' | 'inherit' | 'default'
}

const ALIASES = new Set(['inherit', 'opus', 'sonnet', 'haiku'])
const shortName = (model: string): string => model.trim().replace(/\[[12]m\]$/i, '')

export function formatAgentModel(model?: string, selection?: AgentModelSelection): string {
  const requested = shortName(selection?.requestedModel ?? model ?? 'inherit')
  const resolved = shortName(selection?.resolvedModel ?? model ?? '')
  if (ALIASES.has(requested.toLowerCase())) {
    return `${requested}(${resolved && !ALIASES.has(resolved.toLowerCase()) ? resolved : '未解析'})`
  }
  return resolved || requested
}

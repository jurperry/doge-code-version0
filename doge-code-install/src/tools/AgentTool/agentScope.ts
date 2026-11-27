/** Nested agents can narrow the parent's permitted agent types, never widen them. */
import type { ToolUseContext } from '../../Tool.js'

type AgentDefinitions = ToolUseContext['options']['agentDefinitions']

export function scopedAgentDefinitions(definitions: AgentDefinitions, allowedTypes?: string[]): AgentDefinitions {
  if (!allowedTypes) return definitions
  const parentTypes = definitions.allowedAgentTypes
  return { ...definitions, allowedAgentTypes: parentTypes
    ? allowedTypes.filter(type => parentTypes.includes(type)) : allowedTypes }
}

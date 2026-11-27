import { getAgentModel, type AgentModelAlias } from './agent.js'
import type { AgentModelSelection } from './agentModelIdentity.js'
import { parseUserSpecifiedModel } from './model.js'
import { getModelEnvironment } from './runtimeModelContext.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'

/** Resolve once; the same identity drives execution, task records and UI. */
export function resolveAgentModelSelection(
  agentModel: string | undefined,
  parentModel: string,
  toolModel?: string,
  permissionMode?: PermissionMode,
): AgentModelSelection {
  const envModel = getModelEnvironment().CLAUDE_CODE_SUBAGENT_MODEL
  const fromEnvironment = Boolean(envModel && envModel.toLowerCase() !== 'inherit')
  const fromTool = Boolean(toolModel && toolModel !== 'inherit')
  const fromDefinition = Boolean(agentModel && agentModel !== 'inherit')
  return Object.freeze({
    requestedModel: toolModel ?? agentModel ?? 'inherit',
    resolvedModel: getAgentModel(agentModel, parseUserSpecifiedModel(parentModel), toolModel as AgentModelAlias | undefined, permissionMode),
    source: fromEnvironment ? 'environment' : fromTool ? 'tool' : fromDefinition ? 'definition' : 'inherit',
  })
}

import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getGlobalConfig } from '../config.js'
import { readCustomApiStorage } from '../customApiStorage.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES } from './aliases.js'
import { applyBedrockRegionPrefix, getBedrockRegionPrefix } from './bedrock.js'
import {
  getCanonicalName,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'
import { getAPIProvider } from './providers.js'

export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

export type AgentModelOption = {
  value: string
  label: string
  description: string
}

/**
 * Get the default subagent model. Returns 'inherit' so subagents inherit
 * the model from the parent thread.
 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * Get the effective model string for an agent.
 *
 * For Bedrock, if the parent model uses a cross-region inference prefix (e.g., "eu.", "us."),
 * that prefix is inherited by subagents using alias models (e.g., "sonnet", "haiku", "opus").
 * This ensures subagents use the same region as the parent, which is necessary when
 * IAM permissions are scoped to specific cross-region inference profiles.
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: AgentModelAlias,
  permissionMode?: PermissionMode,
): string {
  // 'inherit' in the env var means the same as the tool parameter of that
  // value — resolve from the agent definition/parent — not a literal model id
  // (parseUserSpecifiedModel passes unknown strings through unchanged, which
  // would send the literal "inherit" to the API and 404).
  const subagentModelEnv = process.env.CLAUDE_CODE_SUBAGENT_MODEL
  if (subagentModelEnv && subagentModelEnv.toLowerCase() !== 'inherit') {
    return parseUserSpecifiedModel(subagentModelEnv)
  }

  // Extract Bedrock region prefix from parent model to inherit for subagents.
  // This ensures subagents use the same cross-region inference profile (e.g., "eu.", "us.")
  // as the parent, which is required when IAM permissions only allow specific regions.
  const parentRegionPrefix = getBedrockRegionPrefix(parentModel)

  // Helper to apply parent region prefix for Bedrock models.
  // `originalSpec` is the raw model string before resolution (alias or full ID).
  // If the user explicitly specified a full model ID that already carries its own
  // region prefix (e.g., "eu.anthropic.…"), we preserve it instead of overwriting
  // with the parent's prefix. This prevents silent data-residency violations when
  // an agent config intentionally pins to a different region than the parent.
  const applyParentRegionPrefix = (
    resolvedModel: string,
    originalSpec: string,
  ): string => {
    if (parentRegionPrefix && getAPIProvider() === 'bedrock') {
      if (getBedrockRegionPrefix(originalSpec)) return resolvedModel
      return applyBedrockRegionPrefix(resolvedModel, parentRegionPrefix)
    }
    return resolvedModel
  }

  // Prioritize tool-specified model if provided. An explicit 'inherit' from
  // the Agent tool's model parameter means "use the agent definition's
  // model, falling back to the parent" — the same as omitting the parameter
  // — not a literal model id (parseUserSpecifiedModel passes it through
  // unchanged, which would 404 at the API; gh-31069 fixed the same alias
  // leaking to --model on the teammate path).
  if (toolSpecifiedModel && toolSpecifiedModel !== 'inherit') {
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    const model = parseUserSpecifiedModel(toolSpecifiedModel)
    return applyParentRegionPrefix(model, toolSpecifiedModel)
  }

  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    // Apply runtime model resolution for inherit to get the effective model
    // This ensures agents using 'inherit' get opusplan→Opus resolution in plan mode
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
    return parentModel
  }
  const model = parseUserSpecifiedModel(agentModelWithExp)
  return applyParentRegionPrefix(model, agentModelWithExp)
}

/**
 * Check if a bare family alias (opus/sonnet/haiku) matches the parent model's
 * tier. When it does, the subagent inherits the parent's exact model string
 * instead of resolving the alias to a provider default.
 *
 * Prevents surprising downgrades: a Vertex user on Opus 4.8 (via /model) who
 * spawns a subagent with `model: opus` should get Opus 4.8, not whatever
 * getDefaultOpusModel() returns for 3P.
 * See https://github.com/anthropics/claude-code/issues/30815.
 *
 * Only bare family aliases match. `opus[1m]`, `best`, `opusplan` fall through
 * since they carry semantics beyond "same tier as parent".
 */
function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  const canonical = getCanonicalName(parentModel)
  switch (alias.toLowerCase()) {
    case 'opus':
      return canonical.includes('opus')
    case 'sonnet':
      return canonical.includes('sonnet')
    case 'haiku':
      return canonical.includes('haiku')
    default:
      return false
  }
}

export function getAgentModelDisplay(model: string | undefined): string {
  // When model is omitted, getDefaultSubagentModel() returns 'inherit' at runtime
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return capitalize(model)
}

export type AgentModelProfileInput = {
  model?: unknown
  providerName?: unknown
  defaultOpusModel?: unknown
  defaultSonnetModel?: unknown
  defaultHaikuModel?: unknown
}

/**
 * Build the agent model option list from stored profiles and the legacy
 * savedModels index.
 *
 * The stored provider profiles (modelProfiles) are the source of truth:
 * every profile contributes its main model plus its three tier slots,
 * labelled with the provider name (the legacy flat savedModels index only
 * ever held main-model strings, so tier models were invisible here). The
 * legacy index still feeds entries that predate profiles. The three
 * standard aliases are ALWAYS listed alongside: getAgentModel resolves
 * them against the active provider's tier env at run time, so next to a
 * full model id they read as "follow the active tier" vs "pin this model".
 * Values are deduped by exact string — [1m]/[2m] variants stay distinct
 * choices (they select different context windows).
 */
export function buildAgentModelOptions(
  profiles: AgentModelProfileInput[],
  savedModels: unknown[],
): AgentModelOption[] {
  const options: AgentModelOption[] = []
  const seen = new Set<string>()
  const push = (model: unknown, description: string) => {
    if (typeof model !== 'string') return
    const value = model.trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    options.push({ value, label: value, description })
  }

  for (const profile of profiles) {
    const provider =
      typeof profile.providerName === 'string' && profile.providerName.trim()
        ? profile.providerName.trim()
        : 'provider'
    push(profile.model, `${provider} · main model`)
    push(profile.defaultOpusModel, `${provider} · Opus tier`)
    push(profile.defaultSonnetModel, `${provider} · Sonnet tier`)
    push(profile.defaultHaikuModel, `${provider} · Haiku tier`)
  }

  // Legacy flat list (pre-profiles entries) — kept so nothing disappears.
  for (const model of savedModels) {
    push(model, 'Custom model')
  }

  options.push(
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Balanced performance - follows the active Sonnet tier',
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Most capable - follows the active Opus tier',
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient - follows the active Haiku tier',
    },
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  )
  return options
}

/**
 * Get available model options for agents. Thin IO wrapper over
 * buildAgentModelOptions — secure storage first (authoritative), the
 * .claude.json mirror as fallback.
 */
export function getAgentModelOptions(): AgentModelOption[] {
  return buildAgentModelOptions(
    [
      ...(readCustomApiStorage().modelProfiles ?? []),
      ...((getGlobalConfig().customApiEndpoint?.modelProfiles ?? []) as AgentModelProfileInput[]),
    ],
    [
      ...(getGlobalConfig().customApiEndpoint?.savedModels ?? []),
      ...(readCustomApiStorage().savedModels ?? []),
    ],
  )
}

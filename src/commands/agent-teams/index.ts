/**
 * /agent-teams — run a requirement with a collaborating multi-agent team.
 *
 * Doge-code internalization of the agent-teams runtime switch: instead of
 * requiring `doge --agent-teams` or the env var at process start, this
 * command opts the session in at invocation time (enableAgentSwarmsForSession
 * sets the same env var the flag path uses, so every isAgentSwarmsEnabled()
 * call site — including the per-query tool list — picks it up) and expands
 * to a prompt that tells the model to build a team for the requirement.
 *
 * The keyword trigger in processUserInput.ts re-routes natural-language
 * "多agent协作 / agent teams / 智能体集群…" requests through this command.
 * source: 'builtin' keeps it out of the SkillTool surface so the model
 * cannot invoke it recursively.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../../commands.js'
import { enableAgentSwarmsForSession } from '../../utils/agentSwarmsEnabled.js'
import { imRemote } from '../../utils/imRemote/client.js'

function buildAgentTeamsPrompt(requirement: string): string {
  const requirementBlock = requirement
    ? `## Requirement\n\n${requirement}`
    : `## Requirement\n\nNo requirement was provided. Ask the user what the team should accomplish before creating anything.`

  return `
You are coordinating this work as a team lead using agent teams. Agent teams are now ENABLED in this session: the TeamCreate tool and the Agent tool's teammate parameters (team_name + name) are available to you.

Work through these steps:

1. Read the requirement below. If it is missing or too vague to decompose, ask the user for specifics and stop.
2. Create a team with TeamCreate — pick a short kebab-case team_name related to the work.
3. Decompose the requirement into teammate-sized assignments using the team-lead discipline: Research → Synthesis → Implementation → Verification. Fan out read-only research in parallel; keep at most one writer per set of files; run verification alongside implementation on different areas.
4. Spawn each teammate with the Agent tool, passing team_name, name, and a self-contained prompt (teammates cannot see this conversation — include file paths and exact expectations). Choose each teammate's model deliberately via the model parameter:
   - "opus" for complex reasoning, architecture, or tricky debugging
   - "sonnet" for general implementation work
   - "haiku" for simple lookups, formatting, or mechanical edits
   - "inherit" to run on the main conversation's model
5. After spawning, briefly tell the user what was launched and end your turn — teammates report back automatically via messages, and idle notifications arrive on their own.

${requirementBlock}
`.trim()
}

const agentTeams: Command = {
  type: 'prompt',
  name: 'agent-teams',
  description: 'Run a requirement with a collaborating multi-agent team',
  argumentHint: '[requirement]',
  progressMessage: 'assembling an agent team',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    enableAgentSwarmsForSession()
    // IM remote-control: tell the paired user agent-teams went live.
    imRemote.agentEvent('teams_on')
    return [{ type: 'text', text: buildAgentTeamsPrompt(args.trim()) }]
  },
}

export default agentTeams

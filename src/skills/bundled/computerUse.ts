import { getMcpPrefix, getToolNameForPermissionCheck } from '../../services/mcp/mcpStringUtils.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from '../../utils/computerUse/common.js'
import { registerBundledSkill } from '../bundledSkills.js'
import skillMd from './computer-use/SKILL.md' with { type: 'text' }

const toolPrefix = getMcpPrefix(COMPUTER_USE_MCP_SERVER_NAME)
const skillBody = skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
const prompt = `<computer-use-skill>\n${skillBody}\n</computer-use-skill>`

export function windowsComputerUsePrompt(
  tools: ReadonlyArray<Parameters<typeof getToolNameForPermissionCheck>[0]>,
): string | undefined {
  if (process.platform === 'win32' && tools.some(tool => getToolNameForPermissionCheck(tool).startsWith(toolPrefix))) {
    return prompt
  }
}

export function registerComputerUseSkill(): void {
  registerBundledSkill({
    name: COMPUTER_USE_MCP_SERVER_NAME,
    description: 'Operate authorized Windows desktop windows using the built-in Computer Use MCP.',
    // The main query loads this automatically. Keep manual invocation for /computer-use.
    disableModelInvocation: true,
    async getPromptForCommand(args) {
      const instruction = 'Use Computer Use MCP for the requested Windows desktop task. If the MCP tools are unavailable, report that to the user.'
      return [{ type: 'text', text: args ? `${instruction}\n\n${args}` : instruction }]
    },
  })
}

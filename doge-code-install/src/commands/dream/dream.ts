import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { startManualDream } from '../../services/autoDream/autoDream.js'
import type { LocalCommandCall } from '../../types/command.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'

export const call: LocalCommandCall = async (args, context) => {
  const value = await startManualDream(context, args.trim(), async () => {
    const { tools, mainLoopModel, mcpClients, customSystemPrompt, appendSystemPrompt } = context.options
    const additionalDirs = context.getAppState().toolPermissionContext.additionalWorkingDirectories
    const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
      getSystemPrompt(tools, mainLoopModel, [...additionalDirs.keys()], mcpClients),
      getUserContext(),
      getSystemContext(),
    ])
    return {
      messages: context.messages,
      systemPrompt: buildEffectiveSystemPrompt({
        mainThreadAgentDefinition: undefined,
        toolUseContext: context,
        customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt,
      }),
      userContext,
      systemContext,
      toolUseContext: context,
    }
  })
  return { type: 'text', value }
}

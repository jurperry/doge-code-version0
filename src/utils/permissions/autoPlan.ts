import { resolve } from 'node:path'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { getCwd } from '../cwd.js'
import { getPlanFilePath } from '../plans.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js'

/** Plan boundaries are independent of configured allow rules and hook decisions. */
export function isAutoPlanOperationAllowed(
  tool: Tool,
  input: Record<string, unknown>,
  agentId: ToolUseContext['agentId'],
): boolean {
  if (tool.name === EXIT_PLAN_MODE_V2_TOOL_NAME || tool.isReadOnly?.(input)) return true
  if ((tool.name !== 'Write' && tool.name !== 'Edit') || typeof input.file_path !== 'string') return false
  const target = resolve(getCwd(), input.file_path)
  const plan = resolve(getPlanFilePath(agentId))
  return process.platform === 'win32' ? target.toLowerCase() === plan.toLowerCase() : target === plan
}

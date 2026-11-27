/**
 * 工作流步骤子进程的身份标记（headlessStep.ts 写入 → print.ts 读取）。
 *
 * 跨 API 步骤以独立 `doge -p` 子进程运行，引擎（engine.ts 的
 * spawnHeadlessStep）只在子进程退出时才算步骤结束。子进程复用的
 * headless 收尾逻辑（等后台任务清零再退出、押后 result）对步骤语境
 * 是错误语义：模型答完即步骤产出定格，遗留的后台命令不可能再被
 * 任何模型轮次消费，等它只会把整个工作流扣死在一条跑飞的命令上
 * （2026-10-06 用户实测：步骤内 2 分钟超时自动后台化的死循环脚本
 * 把子进程无限挂住，工作流卡死不前进）。
 *
 * 本模块刻意零依赖：print.ts 在模块图上游，不能反向拉入
 * WorkflowTool 的重量模块（引擎懒加载契约见 createWorkflowCommand.ts）。
 */

export const WORKFLOW_STEP_CHILD_ENV = 'DOGE_WORKFLOW_STEP_CHILD'

/** 当前进程是否为工作流步骤子进程（仅 spawnHeadlessStep 注入）。 */
export function isWorkflowStepChild(): boolean {
  return process.env[WORKFLOW_STEP_CHILD_ENV] === '1'
}

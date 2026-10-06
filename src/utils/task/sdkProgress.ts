import type { SdkWorkflowProgress } from '../../types/tools.js'
import type { SystemAPIErrorMessage } from '../../types/message.js'
import { retryErrorClass } from '../../services/api/withRetry.js'
import { enqueueSdkEvent } from '../sdkEventQueue.js'

/**
 * Emit a `task_progress` SDK event. Shared by background agents (per tool_use
 * in runAsyncAgentLifecycle) and workflows (per flushProgress batch). Accepts
 * already-computed primitives so callers can derive them from their own state
 * shapes (ProgressTracker for agents, LocalWorkflowTaskState for workflows).
 */
export function emitTaskProgress(params: {
  taskId: string
  toolUseId: string | undefined
  description: string
  startTime: number
  totalTokens: number
  toolUses: number
  lastToolName?: string
  summary?: string
  workflowProgress?: SdkWorkflowProgress[]
  /** 长驻任务（in-process 队友）的空闲标记：true=空闲待命、false=开工。
   *  壳侧据此区分「队友活着但没在干活」与「任务在跑」——占用锁只认后者。 */
  isIdle?: boolean
}): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: params.taskId,
    tool_use_id: params.toolUseId,
    description: params.description,
    usage: {
      total_tokens: params.totalTokens,
      tool_uses: params.toolUses,
      duration_ms: Date.now() - params.startTime,
    },
    last_tool_name: params.lastToolName,
    summary: params.summary,
    workflow_progress: params.workflowProgress,
    is_idle: params.isIdle,
  })
}

/** 窄化：withRetry 的 system/api_error 帧（runAgent 透传，不落 sidechain）。 */
export function isAgentApiRetryMessage(
  message: unknown,
): message is SystemAPIErrorMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'system' &&
    (message as { subtype?: unknown }).subtype === 'api_error'
  )
}

/**
 * 把重试轮次写成任务行的活动摘要——网络类沿用「断线重连中」（10 轮），
 * 其余 API 错误统一「API Error, 第 x/5 次重试…」。同步子代理、后台代理、
 * in-process 队友、工作流步骤共用，保证所有 agent 形态的重试都可见。
 */
export function emitTaskApiRetryProgress(params: {
  taskId: string
  toolUseId: string | undefined
  description: string
  startTime: number
  totalTokens: number
  toolUses: number
  message: SystemAPIErrorMessage
}): void {
  const { message } = params
  // 分类单点：services/api/withRetry.retryErrorClass（与 TUI/壳展示同口径）
  const network = retryErrorClass(message.error) === 'network'
  const attempt = message.retryAttempt
  const max = message.maxRetries
  const summary = network
    ? `🛜 断线重连中，第 ${attempt}/${max} 轮次…`
    : `API Error, 第 ${attempt}/${max} 次重试…`
  emitTaskProgress({
    taskId: params.taskId,
    toolUseId: params.toolUseId,
    description: params.description,
    startTime: params.startTime,
    totalTokens: params.totalTokens,
    toolUses: params.toolUses,
    summary,
  })
}

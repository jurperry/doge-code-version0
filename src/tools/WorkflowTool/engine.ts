/**
 * Workflow engine (CLI 2.1.282) — drives a parsed WorkflowSpec to completion
 * as a background `local_workflow` task.
 *
 * Execution model (mirrors the async-agent paths so all UI comes free):
 *  - startWorkflowTask() registers the umbrella LocalWorkflowTaskState and
 *    returns immediately; the command layer reports "已启动" to the user.
 *    print.ts holds the turn result back while background tasks run, and
 *    drains task_* SDK events per message — so the desktop shell sees every
 *    step live and receives the final result after the workflow settles.
 *  - In-process steps (no `profile:`) run via registerAsyncAgent +
 *    runAsyncAgentLifecycle over runAgent(): each step is a real local_agent
 *    task — task_started/task_progress/task_notification, the P2 model badge
 *    and the TUI background-tasks panel all apply unchanged. Step
 *    transcripts group under subagents/workflows/<workflowName>/.
 *  - Cross-API steps (`profile: <providerName>`) spawn a short-lived headless
 *    `doge -p --output-format stream-json` subprocess with an isolated env
 *    patch (modelProfileEnvPatch — the parent's provider env is untouched).
 *    Each is a registered local_agent with a provider-resolved model. Child
 *    records and nested task events are namespaced under the parent session.
 *  - On settle, the summary is appended to the task output file and the
 *    standard <task-notification> XML re-enters the conversation so the main
 *    model presents the result (same interaction as background agents).
 *
 * Failure policy: first failed step stops the workflow (remaining steps are
 * marked skipped) unless that step sets continue-on-error. Killing the
 * umbrella task aborts the in-flight step (child abort controllers are linked
 * via parentAbortController) and skips the rest.
 */

import { createChildAbortController } from '../../utils/abortController.js'
import { mcpProgressSummary } from '../AgentTool/mcpProgress.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import {
  isLocalAgentTask,
  registerAsyncAgent,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type {
  LocalWorkflowTaskState,
  WorkflowStepRun,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { extractResultText } from '../../utils/forkedAgent.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { createUserMessage, SYNTHETIC_MODEL } from '../../utils/messages.js'
import { recordSidechainTranscript, flushSessionStorage, setAgentTranscriptSubdir, clearAgentTranscriptSubdir, removeTranscriptMessage, recordNetworkRetryUsage } from '../../utils/sessionStorage.js'
import { spawnHeadlessStep, profileStepModel, type StepOutcome } from './headlessStep.js'
import { StepTranscriptChain, StepTranscriptRelay } from './stepTranscript.js'
import { AgentUsageTracker } from '../../utils/agentUsage.js'
import { appendWorkflowTranscript } from './workflowTranscript.js'
import {
  emitTaskTerminatedSdk,
  enqueueSdkEvent,
} from '../../utils/sdkEventQueue.js'
import { appendTaskOutput } from '../../utils/task/diskOutput.js'
import {
  enqueueTaskNotification,
  evictTerminalTask,
  PANEL_GRACE_MS,
  registerTask,
  updateTaskState,
} from '../../utils/task/framework.js'
import { createAgentId } from '../../utils/uuid.js'
import { runAsyncAgentLifecycle } from '../AgentTool/agentToolUtils.js'
import {
  isBuiltInAgent,
  type AgentDefinition,
} from '../AgentTool/loadAgentsDir.js'
import { runAgent } from '../AgentTool/runAgent.js'
import { findWorkflowProfile } from './profiles.js'
import {
  interpolate,
  type InterpolationContext,
  type WorkflowSpec,
  type WorkflowStep,
} from './spec.js'

type SetAppState = LocalJSXCommandContext['setAppState']

export interface WorkflowRunHandle {
  taskId: string
}

/** Resolve a step agent definition by name with the standard fallback chain. */
export function resolveStepAgent(
  context: Pick<LocalJSXCommandContext, 'options'>,
  agentName?: string,
): AgentDefinition | undefined {
  const agents = context.options.agentDefinitions.activeAgents
  const wanted = agentName ?? 'general-purpose'
  return (
    agents.find(a => a.agentType === wanted) ??
    agents.find(a => a.agentType === 'general-purpose') ??
    agents[0]
  )
}

/** Register the umbrella task and kick off the detached engine loop. */
export function startWorkflowTask(opts: {
  spec: WorkflowSpec
  argsString: string
  argValues: Record<string, string>
  context: LocalJSXCommandContext
}): WorkflowRunHandle {
  const { spec, argsString, argValues, context } = opts
  const taskId = generateTaskId('local_workflow')
  const abortController = createChildAbortController(context.abortController)
  const description = `工作流 ${spec.name}`

  const taskState: LocalWorkflowTaskState = {
    ...createTaskStateBase(taskId, 'local_workflow', description, undefined),
    type: 'local_workflow',
    status: 'running',
    workflowName: spec.name,
    args: argsString,
    abortController,
    steps: spec.steps.map(s => ({ stepId: s.id, title: s.title, status: 'pending' })),
  }
  const unregisterCleanup = registerCleanup(async () => {
    abortController.abort()
  })
  taskState.unregisterCleanup = unregisterCleanup

  registerTask(taskState, context.setAppState as SetAppState)

  void runWorkflowSteps({
    spec,
    taskId,
    description,
    argValues,
    context,
    abortController,
  }).catch(err => {
    logForDebugging(
      `[workflow ${spec.name}] engine crashed: ${errorMessage(err)}`,
      { level: 'error' },
    )
    settleWorkflow(
      context.setAppState as SetAppState,
      taskId,
      description,
      spec,
      'failed',
      spec.steps.map(s => ({ stepId: s.id, title: s.title, status: 'skipped' })),
      `引擎异常：${errorMessage(err)}`,
    )
  })

  return { taskId }
}

async function runWorkflowSteps(opts: {
  spec: WorkflowSpec
  taskId: string
  description: string
  argValues: Record<string, string>
  context: LocalJSXCommandContext
  abortController: AbortController
}): Promise<void> {
  const { spec, taskId, description, argValues, context, abortController } = opts
  const setAppState = context.setAppState as SetAppState
  const stepsRun: WorkflowStepRun[] = spec.steps.map(s => ({
    stepId: s.id,
    title: s.title,
    status: 'pending',
  }))
  const interp: InterpolationContext = { args: argValues, steps: {} }

  let workflowStatus: 'completed' | 'failed' | 'killed' = 'completed'
  let failReason: string | undefined

  for (let i = 0; i < spec.steps.length; i++) {
    if (abortController.signal.aborted) {
      for (const s of stepsRun.slice(i)) s.status = 'skipped'
      workflowStatus = 'killed'
      break
    }
    const step = spec.steps[i]!
    const run = stepsRun[i]!
    run.status = 'running'
    run.startedAt = Date.now()
    updateStepState(setAppState, taskId, stepsRun)

    let outcome: StepOutcome
    try {
      outcome =
        step.profile !== undefined
          ? await runSubprocessStep({ step, spec, interp, context, abortController })
          : await runInProcessStep({ step, spec, interp, context, abortController })
    } catch (err) {
      const msg = errorMessage(err)
      outcome = { status: 'failed', output: '', error: msg }
    }

    run.durationMs = Date.now() - (run.startedAt ?? Date.now())
    if (abortController.signal.aborted || outcome.status === 'stopped') {
      outcome.status = 'stopped'
      workflowStatus = 'killed'
      for (const pending of stepsRun.slice(i + 1)) pending.status = 'skipped'
    }
    run.status = outcome.status
    run.summary = outcome.error ?? firstLine(outcome.output)
    interp.steps[step.id] = { status: outcome.status, output: outcome.output }
    updateStepState(setAppState, taskId, stepsRun)
    await feedbackStep(context, spec.name, taskId, step, outcome)
    if (workflowStatus === 'killed') break

    if (outcome.status === 'failed') {
      workflowStatus = 'failed'
      failReason = `步骤 ${step.id} 失败：${outcome.error ?? outcome.output}`
      if (!step.continueOnError) {
        for (const s of stepsRun.slice(i + 1)) s.status = 'skipped'
        break
      }
    }
  }

  settleWorkflow(
    setAppState,
    taskId,
    description,
    spec,
    workflowStatus,
    stepsRun,
    failReason,
    Object.entries(interp.steps).map(([id, result]) => `## ${id}\n${result.output}`).join('\n\n'),
  )
}

function updateStepState(
  setAppState: SetAppState,
  taskId: string,
  steps: WorkflowStepRun[],
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    steps: steps.map(s => ({ ...s })),
  }))
}

/** In-process step: a real async local_agent over runAgent (task events free). */
async function runInProcessStep(opts: {
  step: WorkflowStep
  spec: WorkflowSpec
  interp: InterpolationContext
  context: LocalJSXCommandContext
  abortController: AbortController
}): Promise<StepOutcome> {
  const { step, spec, interp, context, abortController } = opts
  const agentDef = resolveStepAgent(context, step.agent)
  if (!agentDef) throw new Error('没有可用的 agent 定义（缺少 general-purpose）')
  const canUseTool = context.canUseTool
  if (!canUseTool) throw new Error('权限回调不可用，无法执行进程内步骤')

  const appState = context.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  const prompt = interpolate(step.prompt, interp)
  const resolvedModel = getAgentModel(
    agentDef.model,
    context.options.mainLoopModel,
    step.model,
    permissionMode,
    { ignoreEnvironmentOverride: true },
  )
  const agentTaskId = createAgentId()
  const description = `${spec.name}/${step.id} · ${step.title}`

  setAgentTranscriptSubdir(agentTaskId, `workflows/${spec.name}`)
  const registration = registerAsyncAgent({
    agentId: agentTaskId,
    description,
    prompt,
    selectedAgent: agentDef,
    setAppState: (context.setAppStateForTasks ?? context.setAppState) as SetAppState,
    parentAbortController: abortController,
    model: resolvedModel,
    workflowName: spec.name,
  })

  const agentMessages: Message[] = []
  const stepStart = Date.now()
  // Liveness for the task panel: an in-process step emits nothing between
  // complete messages, so a slow or stalled first model response looks like
  // the agent never started (subprocess steps get the same visibility from
  // their stepProgressSummary relays). Tick a waiting line until the first
  // message arrives, then the normal per-message progress takes over.
  let firstMessageAt: number | undefined
  // withRetry 重试轮次（system/api_error 透传后可读）：ticker 据此显示
  //「网络波动，自动重试第 N 轮」——SSE 停滞被 gap 回收后每轮 90-180s 的
  // 等待不再呈现为纯空转（0.2.126，用户实测「等待模型响应 150s」复发反馈）
  let lastRetryAttempt = 0
  const liveness = setInterval(() => {
    if (firstMessageAt !== undefined || abortController.signal.aborted) return
    const waited = Math.round((Date.now() - stepStart) / 1000)
    // 前缀「等待模型响应」是 verify-workflow-cli 的活性契约，重试信息以
    // 后缀追加（勿整句替换）
    const suffix = lastRetryAttempt > 0 ? ` · 网络重试第 ${lastRetryAttempt} 轮` : ''
    enqueueSdkEvent({ type: 'system', subtype: 'task_progress', task_id: agentTaskId, description,
      summary: `等待模型响应 ${waited}s${suffix}`,
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: Date.now() - stepStart } })
  }, 10_000)
  let timedOut = false
  const timeout = step.timeoutSec ? setTimeout(() => {
    timedOut = true
    registration.abortController!.abort(new DOMException(`步骤超时（> ${step.timeoutSec}s）`, 'TimeoutError'))
  }, step.timeoutSec * 1000) : undefined
  try {
    await runAsyncAgentLifecycle({
      taskId: agentTaskId,
      abortController: registration.abortController!,
      makeStream: (_onCacheSafeParams, resumeMessages) => {
        const iterator = runAgent({
          agentDefinition: agentDef,
          // API 错误续跑（agentToolUtils）：以剥离错误尾巴后的既有对话续跑
          // 同一代理而非从原始 prompt 重来——小时级步骤不重付。query 只
          // yield 新消息，续跑列表不含初始 user，须前置原始 prompt 还原
          // 完整对话（否则模型丢任务、首消息成了 assistant）
          promptMessages: resumeMessages
            ? [createUserMessage({ content: prompt }), ...resumeMessages]
            : [createUserMessage({ content: prompt })],
          toolUseContext: context,
          canUseTool,
          isAsync: true,
          canShowPermissionPrompts: true,
          allowNestedAgents: true,
          querySource: 'agent:custom',
          availableTools: context.options.tools,
          description,
          override: { agentId: agentTaskId, abortController: registration.abortController!, resolvedModel },
          transcriptSubdir: `workflows/${spec.name}`,
        })
        return (async function* () {
          for await (const message of iterator) {
            agentMessages.push(message)
            // system 帧不算首条模型消息（api_error=重试信号、compact_boundary
            // =步骤内压缩标记）：ticker 继续走并按 retryAttempt 换文案
            if (message.type === 'system') {
              const attemptNo = (message as { retryAttempt?: number }).retryAttempt
              if (typeof attemptNo === 'number' && attemptNo > lastRetryAttempt) {
                lastRetryAttempt = attemptNo
              }
            } else if (firstMessageAt === undefined) {
              firstMessageAt = Date.now()
            }
            yield message
          }
        })()
      },
      metadata: {
        prompt,
        resolvedAgentModel: resolvedModel,
        isBuiltInAgent: isBuiltInAgent(agentDef),
        startTime: Date.now(),
        agentType: agentDef.agentType,
        isAsync: true,
      },
      description,
      toolUseContext: context,
      rootSetAppState: (context.setAppStateForTasks ?? context.setAppState) as SetAppState,
      agentIdForCleanup: agentTaskId,
      enableSummarization: false,
      notificationMode: 'sdk-only',
      getWorktreeResult: async () => ({}),
    })
    // A step owns its background agents; commands retain their own lifecycle.
    while (Object.values(context.getAppState().tasks).some(task =>
      isLocalAgentTask(task) && task.workflowRootAgentId === agentTaskId && task.id !== agentTaskId && task.status === 'running')) {
      if (abortController.signal.aborted || timedOut) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } finally {
    clearInterval(liveness)
    if (timeout) clearTimeout(timeout)
    await flushSessionStorage()
    clearAgentTranscriptSubdir(agentTaskId)
  }

  const output = extractResultText(agentMessages, '')
  if (timedOut) return { status: 'failed', output, error: `步骤超时（> ${step.timeoutSec}s）` }
  const finalState = context.getAppState().tasks?.[agentTaskId]
  if (finalState && isLocalAgentTask(finalState)) {
    if (finalState.status === 'completed') {
      return { status: 'completed', output }
    }
    if (finalState.status === 'killed') {
      return { status: 'stopped', output, error: '步骤被用户停止' }
    }
    return { status: 'failed', output, error: firstLine(output) || '步骤失败' }
  }
  return { status: 'completed', output }
}

/** Cross-API steps are actual local_agent tasks, recorded under the parent. */
export async function runSubprocessStep(opts: {
  step: WorkflowStep; spec: WorkflowSpec; interp: InterpolationContext
  context: LocalJSXCommandContext; abortController: AbortController
}): Promise<StepOutcome> {
  const { step, spec, interp, context, abortController } = opts
  const profile = findWorkflowProfile(step.profile!)
  if (!profile) return { status: 'failed', output: '', error: '未找到 provider 配置 ' + step.profile }
  const agentDef = resolveStepAgent(context, step.agent)
  if (!agentDef) throw new Error('没有可用的 agent 定义')
  const requested = step.model ?? (step.agent ? agentDef.model : undefined)
  const model = profileStepModel(profile, requested)
  const prompt = interpolate(step.prompt, interp)
  const description = spec.name + '/' + step.id + ' · ' + step.title + ' @' + step.profile
  const agentId = createAgentId()
  const setAppState = (context.setAppStateForTasks ?? context.setAppState) as SetAppState
  setAgentTranscriptSubdir(agentId, 'workflows/' + spec.name)
  const registration = registerAsyncAgent({ agentId, description, prompt, selectedAgent: agentDef,
    setAppState, parentAbortController: abortController, model, workflowName: spec.name })
  const startedAt = Date.now()
  let toolUses = 0
  const initial = createUserMessage({ content: prompt })
  const chain = new StepTranscriptChain()
  chain.append(agentId, initial.uuid)
  const transcriptIds = new Set<string>([agentId])
  const relay = new StepTranscriptRelay(agentId, spec.name)
  const ids = new Set<string>()
  const usage = new AgentUsageTracker()
  let outcome: StepOutcome
  try {
    await recordSidechainTranscript([initial], agentId)
    outcome = await spawnHeadlessStep({ prompt, model, profile, agent: step.agent,
      permissionMode: context.getAppState().toolPermissionContext.mode,
      cwd: process.cwd(), signal: registration.abortController!.signal, timeoutSec: step.timeoutSec,
      onMessage: async wire => {
        usage.observe(wire as Parameters<AgentUsageTracker['observe']>[0])
        if (wire.type === 'system' && wire.subtype === 'network_retry_usage') {
          await recordNetworkRetryUsage(wire.model, wire.usage, wire.source)
        }
        const { record, event, discard } = relay.consume(wire)
        if (event) enqueueSdkEvent(event)
        for (const target of discard ?? []) {
          await removeTranscriptMessage(target.uuid, target.agentId)
          chain.discard(target.agentId, target.uuid)
        }
        if (record) {
          if (!transcriptIds.has(record.agentId)) {
            setAgentTranscriptSubdir(record.agentId, 'workflows/' + spec.name)
            transcriptIds.add(record.agentId)
          }
          await recordSidechainTranscript([record.message], record.agentId, chain.parent(record.agentId))
          chain.append(record.agentId, record.message.uuid)
        }
        const usageDelta = wire.type === 'stream_event' && wire.event?.type === 'message_delta'
        const mcpActivity = mcpProgressSummary(wire)
        if (mcpActivity && !wire.parent_tool_use_id) {
          enqueueSdkEvent({ type: 'system', subtype: 'task_progress', task_id: agentId, description,
            summary: mcpActivity.summary, last_tool_name: mcpActivity.toolName,
            usage: { total_tokens: usage.totalTokens(), tool_uses: toolUses, duration_ms: Date.now() - startedAt } })
        }
        if ((wire.type === 'assistant' || usageDelta) && !wire.parent_tool_use_id) {
          for (const block of wire.message?.content ?? []) if (block.type === 'tool_use' && !ids.has(block.id)) { ids.add(block.id); toolUses++ }
          enqueueSdkEvent({ type: 'system', subtype: 'task_progress', task_id: agentId, description,
            summary: stepProgressSummary(JSON.stringify(wire)),
            model: wire.message?.model === SYNTHETIC_MODEL ? undefined : wire.message?.model,
            last_tool_name: wire.message?.content?.filter(b => b.type === 'tool_use').at(-1)?.name,
            usage: { total_tokens: usage.totalTokens(), tool_uses: toolUses, duration_ms: Date.now() - startedAt } })
        }
      },
    })
    await flushSessionStorage()
  } catch (error) {
    outcome = { status: abortController.signal.aborted ? 'stopped' : 'failed', output: '', error: errorMessage(error) }
  } finally {
    await flushSessionStorage()
    for (const id of transcriptIds) clearAgentTranscriptSubdir(id)
  }
  for (const event of relay.finish(outcome.status)) enqueueSdkEvent(event)
  updateTaskState<LocalAgentTaskState>(agentId, setAppState, task => {
    task.unregisterCleanup?.()
    return { ...task, status: outcome.status === 'stopped' ? 'killed' : outcome.status,
      notified: true, endTime: Date.now(), evictAfter: Date.now() + PANEL_GRACE_MS,
      abortController: undefined, unregisterCleanup: undefined }
  })
  emitTaskTerminatedSdk(agentId, outcome.status, { summary: description,
    usage: { total_tokens: outcome.tokens ?? 0, tool_uses: toolUses, duration_ms: Date.now() - startedAt } })
  return outcome
}

async function feedbackStep(context: LocalJSXCommandContext, workflowName: string, taskId: string, step: WorkflowStep, outcome: StepOutcome): Promise<void> {
  const state = outcome.status === 'completed' ? '完成' : outcome.status === 'stopped' ? '已停止' : '失败'
  const summary = '工作流 ' + workflowName + ' · ' + step.title + '：' + state + (outcome.error ? ' — ' + firstLine(outcome.error) : '')
  enqueueSdkEvent({ type: 'system', subtype: 'workflow_step_feedback', task_id: taskId,
    workflow_name: workflowName, step_id: step.id, status: outcome.status, summary })
  const message = createUserMessage({ content: '<local-command-stdout>' + summary + '</local-command-stdout>', isVisibleInTranscriptOnly: true })
  await appendWorkflowTranscript(context, message)
}

/**
 * 从子进程 stdout 的 assistant 消息行提取一行实时进度摘要（纯函数）。
 * 优先级：正文首行 > 最后一个工具调用「名称 + 入参要点」 > thinking 首行
 * （截断）；空消息返回空串（不上报）。只做字符串截取，不解析语义。
 */
export function stepProgressSummary(assistantLine: string): string {
  let msg: {
    message?: { content?: Array<{ type?: string; text?: string; thinking?: string; name?: string; input?: unknown }> }
  }
  try {
    msg = JSON.parse(assistantLine)
  } catch {
    return ''
  }
  const blocks = msg.message?.content ?? []
  const text = blocks.find(b => b.type === 'text' && b.text?.trim())
  if (text?.text) return firstLine(text.text)
  const tool = blocks.filter(b => b.type === 'tool_use').at(-1)
  if (tool?.name) {
    const input = tool.input as Record<string, unknown> | undefined
    const arg = input?.file_path ?? input?.command ?? input?.path ?? input?.pattern
    return `调用 ${tool.name}${typeof arg === 'string' && arg ? `：${arg.slice(0, 70)}` : ''}`
  }
  const think = blocks.find(b => b.type === 'thinking' && b.thinking?.trim())
  if (think?.thinking) {
    const t = think.thinking.replace(/\s+/g, ' ').trim()
    return `思考：${t.slice(0, 80)}${t.length > 80 ? '…' : ''}`
  }
  return ''
}

function settleWorkflow(
  setAppState: SetAppState,
  taskId: string,
  description: string,
  spec: WorkflowSpec,
  status: 'completed' | 'failed' | 'killed',
  steps: WorkflowStepRun[],
  failReason?: string,
  outputs?: string,
): void {
  const totalMs = steps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0)
  const statusText =
    status === 'completed' ? '完成' : status === 'failed' ? '失败' : '已停止'
  const lines: string[] = [
    `# 工作流 ${spec.name} — ${statusText}`,
    '',
    ...steps.map(s => {
      const mark =
        s.status === 'completed'
          ? '✓'
          : s.status === 'failed'
            ? '✗'
            : s.status === 'running'
              ? '…'
              : '-'
      const dur =
        s.durationMs !== undefined ? `（${Math.round(s.durationMs / 1000)}s）` : ''
      const summary = s.summary ? `：${s.summary}` : ''
      return `- [${mark}] ${s.stepId} · ${s.title}${dur}${summary}`
    }),
  ]
  if (outputs) lines.push('', outputs)
  if (failReason) lines.push('', `失败原因：${failReason}`)
  lines.push('', `总耗时 ${Math.round(totalMs / 1000)}s · 共 ${steps.length} 步`)

  try {
    appendTaskOutput(taskId, lines.join('\n') + '\n')
  } catch (err) {
    logForDebugging(
      `[workflow ${spec.name}] append summary failed: ${errorMessage(err)}`,
    )
  }

  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.unregisterCleanup?.()
    return { ...task,
    status:
      status === 'completed'
        ? 'completed'
        : status === 'killed'
          ? 'killed'
          : 'failed',
    notified: true,
    endTime: Date.now(),
    unregisterCleanup: undefined,
    }
  })

  enqueueTaskNotification({
    type: 'task_status',
    taskId,
    taskType: 'local_workflow',
    status:
      status === 'completed'
        ? 'completed'
        : status === 'killed'
          ? 'killed'
          : 'failed',
    description,
    deltaSummary: lines.join('\n'),
  })

  // Panel grace mirrors the in-process teammate kill path: keep the terminal
  // row visible briefly, then evict.
  setTimeout(() => evictTerminalTask(taskId, setAppState), PANEL_GRACE_MS)
}

function firstLine(text: string): string {
  const t = text.trim()
  if (!t) return ''
  const idx = t.indexOf('\n')
  return (idx === -1 ? t : t.slice(0, idx)).slice(0, 200)
}

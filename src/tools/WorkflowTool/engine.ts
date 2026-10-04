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
 *    Those emit raw headless task_* events with synthesized ids; in the TUI
 *    they are visible only through the umbrella row (documented MVP limit).
 *  - On settle, the summary is appended to the task output file and the
 *    standard <task-notification> XML re-enters the conversation so the main
 *    model presents the result (same interaction as background agents).
 *
 * Failure policy: first failed step stops the workflow (remaining steps are
 * marked skipped) unless that step sets continue-on-error. Killing the
 * umbrella task aborts the in-flight step (child abort controllers are linked
 * via parentAbortController) and skips the rest.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import {
  isLocalAgentTask,
  registerAsyncAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type {
  LocalWorkflowTaskState,
  WorkflowStepRun,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import {
  type ModelProfile,
  modelProfileEnvPatch,
} from '../../utils/customApiStorage.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { extractResultText } from '../../utils/forkedAgent.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import { createUserMessage } from '../../utils/messages.js'
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

interface StepOutcome {
  status: 'completed' | 'failed'
  output: string
  error?: string
  tokens?: number
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
  const abortController = new AbortController()
  const description = `工作流 ${spec.name}${argsString.trim() ? ` ${argsString.trim()}` : ''}`

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
      // User stops surface as AbortError/killed states — treat as kill.
      if (/stop|abort|取消/i.test(msg) && abortController.signal.aborted) {
        for (const s of stepsRun.slice(i)) s.status = 'skipped'
        run.status = 'skipped'
        run.durationMs = Date.now() - (run.startedAt ?? Date.now())
        workflowStatus = 'killed'
        break
      }
    }

    run.durationMs = Date.now() - (run.startedAt ?? Date.now())
    run.status = outcome.status
    run.summary = outcome.error ?? firstLine(outcome.output)
    interp.steps[step.id] = { status: outcome.status, output: outcome.output }
    updateStepState(setAppState, taskId, stepsRun)

    if (outcome.status === 'failed' && !step.continueOnError) {
      for (const s of stepsRun.slice(i + 1)) s.status = 'skipped'
      workflowStatus = 'failed'
      failReason = `步骤 ${step.id} 失败：${outcome.error ?? outcome.output}`
      break
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
  )
  const agentTaskId = createAgentId()
  const description = `${spec.name}/${step.id} · ${step.title}`

  const registration = registerAsyncAgent({
    agentId: agentTaskId,
    description,
    prompt,
    selectedAgent: agentDef,
    setAppState: (context.setAppStateForTasks ?? context.setAppState) as SetAppState,
    parentAbortController: abortController,
    model: resolvedModel,
  })

  const agentMessages: Message[] = []
  await runAsyncAgentLifecycle({
    taskId: agentTaskId,
    abortController: registration.abortController!,
    makeStream: () => {
      const iterator = runAgent({
        agentDefinition: agentDef,
        promptMessages: [createUserMessage({ content: prompt })],
        toolUseContext: context,
        canUseTool,
        isAsync: true,
        canShowPermissionPrompts: true,
        querySource: 'agent:custom',
        model: step.model as ModelAlias | undefined,
        availableTools: context.options.tools,
        description,
        transcriptSubdir: `workflows/${spec.name}`,
      })
      return (async function* () {
        for await (const message of iterator) {
          agentMessages.push(message)
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
    getWorktreeResult: async () => ({}),
  })

  const output = extractResultText(agentMessages, '')
  const finalState = context.getAppState().tasks?.[agentTaskId]
  if (finalState && isLocalAgentTask(finalState)) {
    if (finalState.status === 'completed') {
      return { status: 'completed', output }
    }
    if (finalState.status === 'killed') {
      throw new Error('步骤被用户停止')
    }
    return { status: 'failed', output, error: firstLine(output) || '步骤失败' }
  }
  return { status: 'completed', output }
}

/** Cross-API step: short-lived headless doge subprocess with profile env. */
export async function runSubprocessStep(opts: {
  step: WorkflowStep
  spec: WorkflowSpec
  interp: InterpolationContext
  context: LocalJSXCommandContext
  abortController: AbortController
}): Promise<StepOutcome> {
  const { step, spec, interp, context, abortController } = opts
  const profile = findWorkflowProfile(step.profile!)
  if (!profile) {
    return {
      status: 'failed',
      output: '',
      error: `未找到 provider 配置 "${step.profile}"（provider 在 /provider 管理）`,
    }
  }
  const model = step.model?.trim() || profile.model
  const prompt = interpolate(step.prompt, interp)
  const description = `${spec.name}/${step.id} · ${step.title} @${step.profile}`

  // Raw headless-only events so the desktop shell gets a live row for the
  // subprocess step (same shapes the async-agent path emits).
  const subTaskId = `wfsub_${randomUUID().slice(0, 8)}`
  const startedAt = Date.now()
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: subTaskId,
    description,
    task_type: 'workflow_step',
    workflow_name: spec.name,
    prompt,
    model,
  })

  const outcome = await spawnHeadlessStep({
    prompt,
    model,
    profile,
    permissionMode: context.getAppState().toolPermissionContext.mode,
    cwd: process.cwd(),
    signal: abortController.signal,
    timeoutSec: step.timeoutSec,
  })

  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_progress',
    task_id: subTaskId,
    description,
    usage: {
      total_tokens: outcome.tokens ?? 0,
      tool_uses: 0,
      duration_ms: Date.now() - startedAt,
    },
    summary: outcome.error ?? firstLine(outcome.output),
  })
  emitTaskTerminatedSdk(
    subTaskId,
    outcome.status === 'completed' ? 'completed' : 'failed',
    { summary: description },
  )

  return outcome
}

function spawnHeadlessStep(opts: {
  prompt: string
  model: string
  profile: ModelProfile
  permissionMode: string
  cwd: string
  signal: AbortSignal
  timeoutSec?: number
}): Promise<StepOutcome> {
  const { prompt, model, profile, permissionMode, cwd, signal, timeoutSec } = opts
  return new Promise(resolve => {
    const exe = process.env.DOGE_WORKFLOW_EXECUTABLE ?? process.execPath
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--model',
      model,
      '--permission-mode',
      permissionMode,
    ]

    const env: Record<string, string> = {
      ...process.env,
    } as Record<string, string>
    for (const [name, value] of Object.entries(modelProfileEnvPatch(profile))) {
      if (value !== undefined && value !== '') env[name] = value
      else delete env[name]
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      resolve({
        status: 'failed',
        output: '',
        error: `无法启动子进程 ${exe}：${errorMessage(err)}`,
      })
      return
    }

    let stdoutBuf = ''
    let stderrTail = ''
    let settled = false
    let resultText = ''
    let isErr = false
    let timedOut = false
    let tokens: number | undefined

    const timer = timeoutSec
      ? setTimeout(() => {
          timedOut = true
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, timeoutSec * 1000)
      : undefined

    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const finish = (status: 'completed' | 'failed', error?: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ status, output: resultText, error, tokens })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as {
            type?: string
            result?: string
            is_error?: boolean
            usage?: {
              total_tokens?: number
              input_tokens?: number
              output_tokens?: number
            }
          }
          if (msg.type === 'result') {
            resultText = typeof msg.result === 'string' ? msg.result : ''
            isErr = msg.is_error === true
            if (msg.usage) {
              tokens =
                msg.usage.total_tokens ??
                (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0)
            }
          }
        } catch {
          // non-JSON line (banner etc.) — ignore
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096)
    })

    child.on('error', err => {
      finish('failed', `子进程错误：${errorMessage(err)}`)
    })

    child.on('close', code => {
      if (signal.aborted) {
        finish('failed', '步骤被用户停止')
        return
      }
      if (timedOut) {
        finish('failed', `步骤超时（> ${timeoutSec}s）`)
        return
      }
      if (isErr) {
        finish('failed', firstLine(resultText) || `子进程失败（exit ${code}）`)
        return
      }
      if (code !== 0 && !resultText) {
        finish(
          'failed',
          `子进程退出码 ${code}：${firstLine(stderrTail) || '无输出'}`,
        )
        return
      }
      finish('completed')
    })
  })
}

function settleWorkflow(
  setAppState: SetAppState,
  taskId: string,
  description: string,
  spec: WorkflowSpec,
  status: 'completed' | 'failed' | 'killed',
  steps: WorkflowStepRun[],
  failReason?: string,
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
  if (failReason) lines.push('', `失败原因：${failReason}`)
  lines.push('', `总耗时 ${Math.round(totalMs / 1000)}s · 共 ${steps.length} 步`)

  try {
    appendTaskOutput(taskId, lines.join('\n') + '\n')
  } catch (err) {
    logForDebugging(
      `[workflow ${spec.name}] append summary failed: ${errorMessage(err)}`,
    )
  }

  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    status:
      status === 'completed'
        ? 'completed'
        : status === 'killed'
          ? 'killed'
          : 'failed',
    notified: true,
    endTime: Date.now(),
    unregisterCleanup: undefined,
  }))

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

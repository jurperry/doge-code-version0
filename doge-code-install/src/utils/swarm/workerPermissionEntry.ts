import type { Tool } from '../../Tool.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import { createResolveOnce } from '../../hooks/toolPermission/PermissionContext.js'
import { createAssistantMessage } from '../messages.js'
import { AUTO_QUESTION_TIMEOUT_MS, buildAutoQuestionDecision } from '../permissions/autoQuestion.js'
import { createAutoQuestionWait } from '../permissions/autoQuestionWait.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import type { PermissionRequestMessage } from '../teammateMailbox.js'
import type { SetToolUseConfirmQueueFn } from './leaderPermissionBridge.js'
import { sendPermissionResponseViaMailbox } from './permissionSync.js'

const pendingWorkerQuestions = new Map<string, () => void>()
export function cancelWorkerPermissionRequest(requestId: string): void { pendingWorkerQuestions.get(requestId)?.() }

/** The leader CLI owns the mailbox question's clock while its card is active. */
export function createWorkerPermissionEntry(options: {
  request: PermissionRequestMessage
  tool: Tool
  teamName?: string
  setQueue: SetToolUseConfirmQueueFn
  sendResponse?: typeof sendPermissionResponseViaMailbox
  scheduler?: Parameters<typeof createAutoQuestionWait>[0]['scheduler']
}): ToolUseConfirm {
  const { request, tool, teamName, setQueue } = options
  const send = options.sendResponse ?? sendPermissionResponseViaMailbox
  const entryId = `worker-permission:${request.request_id}`
  const { claim, isResolved } = createResolveOnce(() => {})
  const controller = new AbortController()
  let wait: ReturnType<typeof createAutoQuestionWait> | undefined
  const remove = () => setQueue(queue => queue.filter(item => item.toolUseID !== entryId))
  const finish = (resolution: Parameters<typeof send>[1]) => {
    if (!claim()) return
    pendingWorkerQuestions.delete(request.request_id)
    wait?.dispose()
    remove()
    void send(request.agent_id, resolution, request.request_id, teamName)
  }
  const automatic = request.auto_question === true && tool.name === ASK_USER_QUESTION_TOOL_NAME
  const entry: ToolUseConfirm = {
    assistantMessage: createAssistantMessage({ content: '' }), tool, description: request.description,
    input: request.input, toolUseContext: {} as ToolUseConfirm['toolUseContext'], toolUseID: entryId,
    permissionResult: { behavior: 'ask', message: request.description }, permissionPromptStartTimeMs: Date.now(),
    workerBadge: { name: request.agent_id, color: 'cyan' }, onUserInteraction() {},
    onBecomeActive: automatic ? () => {
      if (wait || isResolved()) return
      const deadline = (options.scheduler?.now() ?? Date.now()) + AUTO_QUESTION_TIMEOUT_MS
      entry.autoQuestionDeadlineMs = deadline
      setQueue(queue => queue.map(item => item.toolUseID === entryId ? { ...item, autoQuestionDeadlineMs: deadline } : item))
      wait = createAutoQuestionWait({ deadlineMs: deadline, signal: controller.signal, scheduler: options.scheduler, onTimeout: () => {
        const decision = buildAutoQuestionDecision(request.input)
        finish(decision.behavior === 'allow'
          ? { decision: 'approved', resolvedBy: 'leader', updatedInput: decision.updatedInput }
          : { decision: 'rejected', resolvedBy: 'leader', feedback: decision.message })
      } })
    } : undefined,
    onAbort() { finish({ decision: 'rejected', resolvedBy: 'leader' }) },
    onAllow(updatedInput, permissionUpdates) { finish({ decision: 'approved', resolvedBy: 'leader', updatedInput, permissionUpdates }) },
    onReject(feedback) { finish({ decision: 'rejected', resolvedBy: 'leader', feedback }) },
    async recheckPermission() {},
  }
  if (!pendingWorkerQuestions.has(request.request_id)) pendingWorkerQuestions.set(request.request_id, entry.onAbort)
  return entry
}

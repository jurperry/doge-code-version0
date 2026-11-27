import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { PendingClassifierCheck } from '../../../types/permissions.js'
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js'
import { toError } from '../../../utils/errors.js'
import { logError } from '../../../utils/log.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import {
  createPermissionRequest,
  isSwarmWorker,
  sendPermissionRequestViaMailbox,
  sendPermissionCancellationViaMailbox,
} from '../../../utils/swarm/permissionSync.js'
import { registerPermissionCallback, unregisterPermissionCallback } from '../../useSwarmPermissionPoller.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../../tools/AskUserQuestionTool/prompt.js'
import { getAutoQuestionDeadline } from '../../../utils/permissions/autoQuestion.js'
import type { PermissionContext } from '../PermissionContext.js'
import { createResolveOnce } from '../PermissionContext.js'

type SwarmWorkerPermissionParams = {
  ctx: PermissionContext
  description: string
  pendingClassifierCheck?: PendingClassifierCheck | undefined
  updatedInput: Record<string, unknown> | undefined
  suggestions: PermissionUpdate[] | undefined
}

/**
 * Handles the swarm worker permission flow.
 *
 * When running as a swarm worker:
 * 1. Tries classifier auto-approval for bash commands
 * 2. Forwards the permission request to the leader via mailbox
 * 3. Registers callbacks for when the leader responds
 * 4. Sets the pending indicator while waiting
 *
 * Returns a PermissionDecision if the classifier auto-approves,
 * or a Promise that resolves when the leader responds.
 * Returns null if swarms are not enabled or this is not a swarm worker,
 * so the caller can fall through to interactive handling.
 */
async function handleSwarmWorkerPermission(
  params: SwarmWorkerPermissionParams,
): Promise<PermissionDecision | null> {
  if (!isAgentSwarmsEnabled() || !isSwarmWorker()) {
    return null
  }

  const { ctx, description, updatedInput, suggestions } = params

  // For bash commands, try classifier auto-approval before forwarding to
  // the leader. Agents await the classifier result (rather than racing it
  // against user interaction like the main agent).
  const classifierResult = feature('BASH_CLASSIFIER')
    ? await ctx.tryClassifier?.(params.pendingClassifierCheck, updatedInput)
    : null
  if (classifierResult) {
    return classifierResult
  }

  // Forward permission request to the leader via mailbox
  try {
    const clearPendingRequest = (): void =>
      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingWorkerRequest: null,
      }))

    const decision = await new Promise<PermissionDecision | null>(resolve => {
      const { resolve: resolveOnce, claim: claimOnce } = createResolveOnce(resolve)
      const signal = ctx.toolUseContext.abortController.signal

      // Create the permission request
      const request = createPermissionRequest({
        toolName: ctx.tool.name,
        toolUseId: ctx.toolUseID,
        input: updatedInput ?? ctx.input,
        description,
        permissionSuggestions: suggestions,
        autoQuestion: ctx.tool.name === ASK_USER_QUESTION_TOOL_NAME && getAutoQuestionDeadline(ctx.toolUseContext.getAppState().toolPermissionContext) !== undefined,
      })
      const claim = () => {
        if (!claimOnce()) return false
        unregisterPermissionCallback(request.id)
        signal.removeEventListener('abort', onAbort)
        clearPendingRequest()
        return true
      }
      let sent: Promise<boolean>
      const onAbort = () => {
        if (!claim()) return
        if (sent) void sent.then(ok => ok ? sendPermissionCancellationViaMailbox(request) : undefined).catch(error => logError(toError(error)))
        ctx.logCancelled()
        resolveOnce(ctx.cancelAndAbort(undefined, true))
      }

      // Register callback BEFORE sending the request to avoid race condition
      // where leader responds before callback is registered
      registerPermissionCallback({
        requestId: request.id,
        toolUseId: ctx.toolUseID,
        async onAllow(
          allowedInput: Record<string, unknown> | undefined,
          permissionUpdates: PermissionUpdate[],
          feedback?: string,
          contentBlocks?: ContentBlockParam[],
        ) {
          if (!claim()) return // atomic check-and-mark before await

          // Merge the updated input with the original input
          const finalInput =
            allowedInput && Object.keys(allowedInput).length > 0
              ? allowedInput
              : updatedInput ?? ctx.input

          resolveOnce(
            await ctx.handleUserAllow(
              finalInput,
              permissionUpdates,
              feedback,
              undefined,
              contentBlocks,
            ),
          )
        },
        onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
          if (!claim()) return

          ctx.logDecision({
            decision: 'reject',
            source: { type: 'user_reject', hasFeedback: !!feedback },
          })

          resolveOnce(ctx.cancelAndAbort(feedback, undefined, contentBlocks))
        },
      })

      // Now that callback is registered, send the request to the leader
      sent = sendPermissionRequestViaMailbox(request)
      void sent.then(ok => { if (!ok && claim()) resolveOnce(null) })

      // Show visual indicator that we're waiting for leader approval
      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingWorkerRequest: {
          toolName: ctx.tool.name,
          toolUseId: ctx.toolUseID,
          description,
        },
      }))

      // If the abort signal fires while waiting for the leader response,
      // resolve the promise with a cancel decision so it does not hang.
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })

    return decision
  } catch (error) {
    // If swarm permission submission fails, fall back to local handling
    logError(toError(error))
    // Continue to local UI handling below
    return null
  }
}

export { handleSwarmWorkerPermission }
export type { SwarmWorkerPermissionParams }

/**
 * REPL integration hook for `claude ssh` sessions.
 *
 * Sibling to useDirectConnect — same shape (isRemoteMode/sendMessage/
 * cancelRequest/disconnect), same REPL wiring, but drives an SSH child
 * process instead of a WebSocket. Kept separate rather than generalizing
 * useDirectConnect because the lifecycle differs: the ssh process and auth
 * proxy are created BEFORE this hook runs (during startup, in main.tsx) and
 * handed in; useDirectConnect creates its WebSocket inside the effect.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../remote/remotePermissionBridge.js'
import {
  convertSDKMessage,
  isSessionEndMessage,
} from '../remote/sdkMessageAdapter.js'
import type { SSHSession } from '../ssh/createSSHSession.js'
import type { SSHSessionManager } from '../ssh/SSHSessionManager.js'
import { remoteModelEnvironment } from '../ssh/sshCommand.js'
import { useAppStateStore } from '../state/AppState.js'
import type { Tool } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import type { Message as MessageType } from '../types/message.js'
import type { PermissionAskDecision } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { createSystemMessage } from '../utils/messages.js'
import { isAutoModeActive } from '../utils/permissions/autoModeState.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

type UseSSHSessionResult = {
  isRemoteMode: boolean
  sendMessage: (content: RemoteMessageContent, opts?: { uuid?: string }) => Promise<boolean>
  cancelRequest: () => void
  disconnect: () => void
}

type UseSSHSessionProps = {
  session: SSHSession | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
}

/** The model a prompt will use: the session override, else the process base. */
function sessionModelOf(state: { mainLoopModelForSession: string | null; mainLoopModel: string | null }): string | undefined {
  return state.mainLoopModelForSession ?? state.mainLoopModel ?? undefined
}

export function useSSHSession({
  session,
  setMessages,
  setIsLoading,
  setToolUseConfirmQueue,
  tools,
}: UseSSHSessionProps): UseSSHSessionResult {
  const isRemoteMode = !!session
  const store = useAppStateStore()

  const managerRef = useRef<SSHSessionManager | null>(null)
  const hasReceivedInitRef = useRef(false)
  const isConnectedRef = useRef(false)

  const toolsRef = useRef(tools)
  useEffect(() => {
    toolsRef.current = tools
  }, [tools])

  useEffect(() => {
    if (!session) return

    hasReceivedInitRef.current = false
    logForDebugging('[useSSHSession] wiring SSH session manager')
    let displayedMode = store.getState().toolPermissionContext.mode

    const manager = session.createManager({
      onMessage: sdkMessage => {
        if (isSessionEndMessage(sdkMessage)) {
          setIsLoading(false)
        }

        // Skip duplicate init messages (one per turn from stream-json mode).
        if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
          if (hasReceivedInitRef.current) return
          hasReceivedInitRef.current = true
        }

        const converted = convertSDKMessage(sdkMessage, {
          convertToolResults: true,
        })
        if (converted.type === 'message') {
          setMessages(prev => [...prev, converted.message])
        }
      },
      onPermissionRequest: (request, requestId) => {
        logForDebugging(
          `[useSSHSession] permission request: ${request.tool_name}`,
        )

        const tool =
          findToolByName(toolsRef.current, request.tool_name) ??
          createToolStub(request.tool_name)

        const syntheticMessage = createSyntheticAssistantMessage(
          request,
          requestId,
        )

        const permissionResult: PermissionAskDecision = {
          behavior: 'ask',
          message:
            request.description ?? `${request.tool_name} requires permission`,
          suggestions: request.permission_suggestions,
          blockedPath: request.blocked_path,
        }

        const toolUseConfirm: ToolUseConfirm = {
          assistantMessage: syntheticMessage,
          tool,
          description:
            request.description ?? `${request.tool_name} requires permission`,
          input: request.input,
          toolUseContext: {} as ToolUseConfirm['toolUseContext'],
          toolUseID: request.tool_use_id,
          permissionResult,
          permissionPromptStartTimeMs: Date.now(),
          onUserInteraction() {},
          onAbort() {
            manager.respondToPermissionRequest(requestId, {
              behavior: 'deny',
              message: 'User aborted',
            })
            setToolUseConfirmQueue(q =>
              q.filter(i => i.toolUseID !== request.tool_use_id),
            )
          },
          onAllow(updatedInput) {
            manager.respondToPermissionRequest(requestId, {
              behavior: 'allow',
              updatedInput,
            })
            setToolUseConfirmQueue(q =>
              q.filter(i => i.toolUseID !== request.tool_use_id),
            )
            setIsLoading(true)
          },
          onReject(feedback) {
            manager.respondToPermissionRequest(requestId, {
              behavior: 'deny',
              message: feedback ?? 'User denied permission',
            })
            setToolUseConfirmQueue(q =>
              q.filter(i => i.toolUseID !== request.tool_use_id),
            )
          },
          async recheckPermission() {},
        }

        setToolUseConfirmQueue(q => [...q, toolUseConfirm])
        setIsLoading(false)
      },
      onPermissionCancelled: (_requestId, toolUseId) => {
        if (toolUseId) setToolUseConfirmQueue(q => q.filter(i => i.toolUseID !== toolUseId))
        setIsLoading(true)
      },
      onPermissionMode: mode => {
        const bypassAccepted = mode === 'bypassPermissions' &&
          store.getState().toolPermissionContext.isRemoteBypassPermissionsDisabled
        if (mode === displayedMode && !bypassAccepted) return
        displayedMode = mode
        store.setState(prev => ({
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode,
            ...(bypassAccepted ? { isRemoteBypassPermissionsDisabled: false } : {}),
          },
        }))
      },
      onPermissionModeError: (mode, error) => {
        if (mode === 'bypassPermissions') {
          store.setState(prev => ({
            ...prev,
            toolPermissionContext: { ...prev.toolPermissionContext, isRemoteBypassPermissionsDisabled: true },
          }))
        }
        setMessages(prev => [...prev, createSystemMessage(`SSH: ${error}`, 'warning')])
      },
      onConnected: () => {
        logForDebugging('[useSSHSession] connected')
        isConnectedRef.current = true
      },
      onDisconnected: () => {
        logForDebugging('[useSSHSession] ssh process exited (giving up)')
        const stderr = session.getStderrTail().trim()
        const connected = isConnectedRef.current
        const exitCode = session.proc.exitCode
        isConnectedRef.current = false
        setIsLoading(false)

        let msg = connected
          ? 'Remote session ended.'
          : 'SSH session failed before connecting.'
        // Surface remote stderr if it looks like an error (pre-connect always,
        // post-connect only on nonzero exit — normal --verbose noise otherwise).
        if (stderr && (!connected || exitCode !== 0)) {
          msg += `\nRemote stderr (exit ${exitCode ?? 'signal ' + session.proc.signalCode}):\n${stderr}`
        }
        void gracefulShutdown(1, 'other', { finalMessage: msg })
      },
      onError: error => {
        logForDebugging(`[useSSHSession] error: ${error.message}`)
        setIsLoading(false)
        setMessages(prev => [...prev, createSystemMessage(`SSH error: ${error.message}`, 'warning')])
      },
    })

    managerRef.current = manager
    // Subscribe directly so a Shift+Tab change is sent before the next input
    // even when React batches the display update with submission. A /model
    // switch rewrites this process's env (the auth proxy reads it live) but
    // leaves the remote on its startup model — forward both sides together.
    const currentEffort = (): string =>
      process.env.CLAUDE_CODE_EFFORT_LEVEL ?? String(store.getState().effortValue ?? 'unset')
    let displayedModel = sessionModelOf(store.getState())
    let displayedConnection = process.env.DOGE_ACTIVE_CONNECTION_ID
    let displayedEffort = currentEffort()
    manager.setEffort(displayedEffort)
    const unsubscribe = store.subscribe(() => {
      const state = store.getState()
      const mode = state.toolPermissionContext.mode
      if (mode !== displayedMode) {
        // The classifier opt-in dialog previews its label before activation.
        if (mode === 'auto' && !isAutoModeActive()) return
        displayedMode = mode
        manager.setPermissionMode(mode)
      }
      const model = sessionModelOf(state)
      const connection = process.env.DOGE_ACTIVE_CONNECTION_ID
      const effort = currentEffort()
      if (model !== displayedModel || connection !== displayedConnection) {
        displayedModel = model
        displayedConnection = connection
        manager.setModel(model ?? 'default', {
          ...remoteModelEnvironment(process.env, true),
          CLAUDE_CODE_EFFORT_LEVEL: effort,
        })
      } else if (effort !== displayedEffort) {
        manager.setEffort(effort)
      }
      displayedEffort = effort
    })
    manager.connect()

    return () => {
      logForDebugging('[useSSHSession] cleanup')
      unsubscribe()
      manager.disconnect()
      session.proxy.stop()
      managerRef.current = null
    }
  }, [session, setMessages, setIsLoading, setToolUseConfirmQueue, store])

  const sendMessage = useCallback(
    async (content: RemoteMessageContent, opts?: { uuid?: string }): Promise<boolean> => {
      const m = managerRef.current
      if (!m) return false
      setIsLoading(true)
      const sent = await m.sendMessage(content, opts)
      if (!sent) setIsLoading(false)
      return sent
    },
    [setIsLoading],
  )

  const cancelRequest = useCallback(() => {
    managerRef.current?.sendInterrupt()
    setIsLoading(false)
  }, [setIsLoading])

  const disconnect = useCallback(() => {
    managerRef.current?.disconnect()
    managerRef.current = null
    isConnectedRef.current = false
  }, [])

  return useMemo(
    () => ({ isRemoteMode, sendMessage, cancelRequest, disconnect }),
    [isRemoteMode, sendMessage, cancelRequest, disconnect],
  )
}

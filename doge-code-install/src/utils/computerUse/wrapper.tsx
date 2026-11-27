/**
 * The `.call()` override — thin adapter between `ToolUseContext` and
 * `bindSessionContext`. Spread into the MCP tool object in `client.ts`
 * (same pattern as Chrome's rendering overrides, plus `.call()`).
 *
 * The wrapper-closure logic (build overrides fresh, lock gate, permission
 * merge, screenshot stash) lives in `@ant/computer-use-mcp`'s
 * `bindSessionContext`. This file binds it once per process,
 * caches the dispatcher, and updates a per-call ref for the pieces of
 * `ToolUseContext` that vary per-call (`abortController`, `setToolJSX`,
 * `sendOSNotification`). AppState accessors are read through the ref too —
 * they're likely stable but we don't depend on that.
 *
 * External callers reach this via the lazy require thunk in `client.ts`, gated
 * on `feature('CHICAGO_MCP')`. Runtime enablement is controlled by the
 * GrowthBook gate `tengu_malort_pedway` (see gates.ts).
 */

import { bindSessionContext, type ComputerUseSessionContext, type CuCallToolResult, type CuPermissionRequest, type CuPermissionResponse, type CuToolProgress, DEFAULT_GRANT_FLAGS, type ScreenshotDims } from '@ant/computer-use-mcp';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { getSessionId } from '../../bootstrap/state.js';
import { ComputerUseApproval } from '../../components/permissions/ComputerUseApproval/ComputerUseApproval.js';
import { mcpToolCallLimits, McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, runMcpToolCall, type McpCallLimits } from '../../services/mcp/toolCallLifecycle.js';
import type { AssistantMessage } from '../../types/message.js';
import type { Tool, ToolCallProgress, ToolUseContext } from '../../Tool.js';
import { logForDebugging } from '../debug.js';
import { createSystemMessage } from '../messages.js';
import { isAutoBypassActive } from '../permissions/autoBypass.js';
import { buildAutoGrantResponse } from './autoGrant.js';
import { cleanupComputerUseAfterTurn } from './cleanup.js';
import { checkComputerUseLock, isLockHeldLocally, tryAcquireComputerUseLock } from './computerUseLock.js';
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js';
import { ensureEscHotkey } from './escHotkey.js';
import { getChicagoCoordinateMode } from './gates.js';
import { getComputerUseHostAdapter } from './hostAdapter.js';
import { getComputerUseMCPRenderingOverrides } from './toolRendering.js';
import { windowsActionSignal } from './win32/powerShell.js';
import { getTurnUacGuard, runWithUacGuard, UAC_FRESH_SCREENSHOT, UAC_WAIT_MESSAGE, UacTimeoutError } from './win32/uacWait.js';
type CallOverride = Pick<Tool, 'call'>['call'];
type Binding = {
  ctx: ComputerUseSessionContext;
  dispatch: ReturnType<typeof bindSessionContext>;
};
type DispatchComputerUse = (
    name: string,
    args: unknown,
    requestSignal?: AbortSignal,
    reportProgress?: (progress: CuToolProgress) => void,
    beforeAction?: (action: string) => Promise<void>,
  ) => Promise<CuCallToolResult>;

/**
 * Cached binding — built on first `.call()`, reused for process lifetime.
 * The dispatcher's closure-held screenshot blob persists across calls.
 *
 * `currentToolUseContext` is updated on every call. Every getter/callback in
 * `ctx` reads through it, so the per-call pieces (`abortController`,
 * `setToolJSX`, `sendOSNotification`) are always current.
 *
 * Module-level `let` is a deliberate exception to the no-module-scope-state
 * rule (src/CLAUDE.md): the dispatcher closure must persist across calls so
 * its internal screenshot blob survives, but `ToolUseContext` is per-call.
 * Tests will need to either inject the cache or run serially.
 */
let binding: Binding | undefined;
let currentToolUseContext: ToolUseContext | undefined;
type WindowsComputerUseTurn = {
  stop: AbortController;
  dispatchTail?: Promise<void>;
  cleanup?: Promise<void>;
};
const windowsTurns = new WeakMap<AbortSignal, WindowsComputerUseTurn>();
const STOPPED_BY_ESCAPE = 'The user stopped Computer Use with Esc. Continue the conversation without computer actions in this turn. Computer Use can resume after the next user message.';

function getWindowsComputerUseTurn(context: ToolUseContext): WindowsComputerUseTurn {
  const signal = (context.mainTurnAbortController ?? context.abortController).signal;
  let turn = windowsTurns.get(signal);
  if (!turn) {
    turn = { stop: new AbortController() };
    windowsTurns.set(signal, turn);
  }
  return turn;
}

function stopWindowsComputerUse(context: ToolUseContext): void {
  const turn = getWindowsComputerUseTurn(context);
  if (turn.stop.signal.aborted) return;
  turn.stop.abort(new DOMException(STOPPED_BY_ESCAPE, 'AbortError'));
  // Wait for a dispatched action to unwind before releasing its input and lock.
  turn.cleanup = windowsActionSignal.exit(() => (turn.dispatchTail ?? Promise.resolve()).then(async () => {
    await cleanupComputerUseAfterTurn(context);
    const { clearWindowsTargetAfterStop } = await import('./platforms/win32.js');
    clearWindowsTargetAfterStop();
    binding?.dispatch.clearScreenshot();
  })).catch(error => logForDebugging(`[cu-esc] cleanup failed: ${error}`, { level: 'warn' }));
}
// The dispatcher keeps its screenshot across turn boundaries. UAC invalidates
// those coordinates until a new standalone screenshot has finished.
let needsScreenshotAfterUac = false;
function tuc(): ToolUseContext {
  // Safe: `binding` is only populated when `currentToolUseContext` is set.
  // Called only from within `ctx` callbacks, which only fire during dispatch.
  return currentToolUseContext!;
}
/** Shared by the acquire-time registration and the per-action re-check. */
function handleUserEscape(): void {
  // A stale helper can outlive its lock by a few milliseconds during cleanup;
  // never abort a later non-CU turn from that signal.
  if (!isLockHeldLocally()) return;
  if (process.platform === 'win32') {
    stopWindowsComputerUse(tuc());
    return;
  }
  tuc().abortController.abort();
}
function formatLockHeld(holder: string): string {
  return `Computer use is in use by another Claude session (${holder.slice(0, 8)}…). Wait for that session to finish or run /exit there.`;
}
export function buildSessionContext(): ComputerUseSessionContext {
  return {
    // ── Read state fresh via the per-call ref ─────────────────────────────
    getAllowedApps: () => tuc().getAppState().computerUseMcpState?.allowedApps ?? [],
    getGrantFlags: () => tuc().getAppState().computerUseMcpState?.grantFlags ?? DEFAULT_GRANT_FLAGS,
    getClipboardStash: () => tuc().getAppState().computerUseMcpState?.clipboardStash,
    onClipboardStashChanged: stash => tuc().setAppState(prev => ({
      ...prev,
      computerUseMcpState: {
        ...prev.computerUseMcpState,
        clipboardStash: stash,
      },
    })),
    // cc-2 has no Settings page for user-denied apps yet.
    getUserDeniedBundleIds: () => [],
    isAborted: () => tuc().abortController.signal.aborted,
    getSelectedDisplayId: () => tuc().getAppState().computerUseMcpState?.selectedDisplayId,
    getDisplayPinnedByModel: () => tuc().getAppState().computerUseMcpState?.displayPinnedByModel ?? false,
    getDisplayResolvedForApps: () => tuc().getAppState().computerUseMcpState?.displayResolvedForApps,
    getLastScreenshotDims: (): ScreenshotDims | undefined => {
      const d = tuc().getAppState().computerUseMcpState?.lastScreenshotDims;
      return d ? {
        ...d,
        displayId: d.displayId ?? 0,
        originX: d.originX ?? 0,
        originY: d.originY ?? 0
      } : undefined;
    },
    // ── Write-backs ────────────────────────────────────────────────────────
    // `setToolJSX` is guaranteed present — the gate in `main.tsx` excludes
    // non-interactive sessions. The package's `_dialogSignal` (tool-finished
    // dismissal) is irrelevant here: `setToolJSX` blocks the tool call, so
    // the dialog can't outlive it. Ctrl+C is what matters, and
    // `runPermissionDialog` wires that from the per-call ref's abortController.
    onPermissionRequest: (req, dialogSignal) => runPermissionDialog(req, dialogSignal),
    // Package does the merge (dedupe + truthy-only flags). We just persist.
    onAllowedAppsChanged: (apps, flags) => tuc().setAppState(prev => {
      const cu = prev.computerUseMcpState;
      const prevApps = cu?.allowedApps;
      const prevFlags = cu?.grantFlags;
      const sameApps = prevApps?.length === apps.length && apps.every((a, i) => prevApps[i]?.bundleId === a.bundleId);
      const sameFlags = prevFlags?.clipboardRead === flags.clipboardRead && prevFlags?.clipboardWrite === flags.clipboardWrite && prevFlags?.systemKeyCombos === flags.systemKeyCombos;
      return sameApps && sameFlags ? prev : {
        ...prev,
        computerUseMcpState: {
          ...cu,
          allowedApps: [...apps],
          grantFlags: flags
        }
      };
    }),
    onAppsHidden: ids => {
      if (ids.length === 0) return;
      tuc().setAppState(prev => {
        const cu = prev.computerUseMcpState;
        const existing = cu?.hiddenDuringTurn;
        if (existing && ids.every(id => existing.has(id))) return prev;
        return {
          ...prev,
          computerUseMcpState: {
            ...cu,
            hiddenDuringTurn: new Set([...(existing ?? []), ...ids])
          }
        };
      });
    },
    // Resolver writeback only fires under a pin when Swift fell back to main
    // (pinned display unplugged) — the pin is semantically dead, so clear it
    // and the app-set key so the chase chain runs next time. When autoResolve
    // was true, onDisplayResolvedForApps re-sets the key in the same tick.
    onResolvedDisplayUpdated: id => tuc().setAppState(prev => {
      const cu = prev.computerUseMcpState;
      if (cu?.selectedDisplayId === id && !cu.displayPinnedByModel && cu.displayResolvedForApps === undefined) {
        return prev;
      }
      return {
        ...prev,
        computerUseMcpState: {
          ...cu,
          selectedDisplayId: id,
          displayPinnedByModel: false,
          displayResolvedForApps: undefined
        }
      };
    }),
    // switch_display(name) pins; switch_display("auto") unpins and clears the
    // app-set key so the next screenshot auto-resolves fresh.
    onDisplayPinned: id => tuc().setAppState(prev => {
      const cu = prev.computerUseMcpState;
      const pinned = id !== undefined;
      const nextResolvedFor = pinned ? cu?.displayResolvedForApps : undefined;
      if (cu?.selectedDisplayId === id && cu?.displayPinnedByModel === pinned && cu?.displayResolvedForApps === nextResolvedFor) {
        return prev;
      }
      return {
        ...prev,
        computerUseMcpState: {
          ...cu,
          selectedDisplayId: id,
          displayPinnedByModel: pinned,
          displayResolvedForApps: nextResolvedFor
        }
      };
    }),
    onDisplayResolvedForApps: key => tuc().setAppState(prev => {
      const cu = prev.computerUseMcpState;
      if (cu?.displayResolvedForApps === key) return prev;
      return {
        ...prev,
        computerUseMcpState: {
          ...cu,
          displayResolvedForApps: key
        }
      };
    }),
    onScreenshotCaptured: dims => tuc().setAppState(prev => {
      const cu = prev.computerUseMcpState;
      const p = cu?.lastScreenshotDims as ScreenshotDims | undefined;
      return p?.width === dims.width && p?.height === dims.height && p?.displayWidth === dims.displayWidth && p?.displayHeight === dims.displayHeight && p?.displayId === dims.displayId && p?.displayCount === dims.displayCount && p?.originX === dims.originX && p?.originY === dims.originY ? prev : {
        ...prev,
        computerUseMcpState: {
          ...cu,
          lastScreenshotDims: dims
        }
      };
    }),
    onScreenshotCleared: () => tuc().setAppState(prev => {
      if (prev.computerUseMcpState?.lastScreenshotDims === undefined) return prev;
      return {
        ...prev,
        computerUseMcpState: {
          ...prev.computerUseMcpState,
          lastScreenshotDims: undefined,
        },
      };
    }),
    // ── Lock — async, direct file-lock calls ───────────────────────────────
    // No `lockHolderForGate` dance: the package's gate is async now. It
    // awaits `checkCuLock`, and on `holder: undefined` + non-deferring tool
    // awaits `acquireCuLock`. `defersLockAcquire` is the PACKAGE's set —
    // the local copy is gone.
    checkCuLock: async () => {
      const c = await checkComputerUseLock();
      switch (c.kind) {
        case 'free':
          return {
            holder: undefined,
            isSelf: false
          };
        case 'held_by_self':
          return {
            holder: getSessionId(),
            isSelf: true
          };
        case 'blocked':
          return {
            holder: c.by,
            isSelf: false
          };
      }
    },
    // Called only when checkCuLock returned `holder: undefined`. The O_EXCL
    // acquire is atomic — if another process grabbed it in the gap (rare),
    // throw so the tool fails instead of proceeding without the lock.
    // `fresh: false` (re-entrant) shouldn't happen given check said free,
    // but is possible under parallel tool-use interleaving — don't spam the
    // notification in that case.
    acquireCuLock: async () => {
      const r = await tryAcquireComputerUseLock();
      if (r.kind === 'blocked') {
        throw new Error(formatLockHeld(r.by));
      }
      if (r.fresh) {
        // Global Escape → abort. The CGEventTap's CFRunLoopSource is
        // processed by the drainRunLoop pump on macOS; the Windows hook lives
        // in a PowerShell helper. Either way the registration is held until
        // unregisterEscHotkey() in cleanup.ts.
        const escRegistered = await windowsActionSignal.exit(() => ensureEscHotkey(handleUserEscape));
        tuc().sendOSNotification?.({
          message: escRegistered ? 'Claude is using your computer · press Esc to stop' : 'Claude is using your computer · press Ctrl+C to stop',
          notificationType: 'computer_use_enter'
        });
      }
    },
    formatLockHeldMessage: formatLockHeld
  };
}
function getOrBind(): Binding {
  if (binding) return binding;
  const ctx = buildSessionContext();
  binding = {
    ctx,
    dispatch: bindSessionContext(getComputerUseHostAdapter(), getChicagoCoordinateMode(), ctx)
  };
  return binding;
}

/**
 * Returns the full override object for a single `mcp__computer-use__{toolName}`
 * tool: rendering overrides from `toolRendering.tsx` plus a `.call()` that
 * dispatches through the cached binder.
 */
type ComputerUseMCPToolOverrides = ReturnType<typeof getComputerUseMCPRenderingOverrides> & {
  call: CallOverride;
};
type CallComputerUseToolOptions = {
  dispatch: DispatchComputerUse;
  toolName: string;
  args: Record<string, unknown>;
  context: ToolUseContext;
  parentMessage?: AssistantMessage;
  onProgress?: ToolCallProgress;
  limits?: McpCallLimits;
  uacGuard?: Parameters<typeof runWithUacGuard>[3];
};

function extractToolUseId(message: AssistantMessage | undefined): string | undefined {
  return message?.message.content[0]?.type === 'tool_use'
    ? message.message.content[0].id
    : undefined;
}

async function callComputerUseTool({
  dispatch,
  toolName,
  args,
  context,
  parentMessage,
  onProgress,
  limits,
  uacGuard,
}: CallComputerUseToolOptions) {
  const windowsTurn = process.platform === 'win32' ? getWindowsComputerUseTurn(context) : undefined;
  const signal = windowsTurn
    ? AbortSignal.any([context.abortController.signal, windowsTurn.stop.signal])
    : context.abortController.signal;
  // The lock is process-wide and the hook is registered once at acquire time.
  // Re-check before each action so a helper that died (PowerShell crash,
  // antivirus kill, secure-desktop switch) is re-registered instead of
  // silently leaving the user without Esc for the rest of the session.
  if (!signal.aborted && isLockHeldLocally()) {
    void ensureEscHotkey(handleUserEscape).catch(error => {
      logForDebugging(`[cu-esc] re-register failed: ${error}`, { level: 'warn' });
    });
  }
  const toolUseID = extractToolUseId(parentMessage);
  const emit = (data: Record<string, unknown>): void => {
    if (toolUseID) onProgress?.({ toolUseID, data });
  };
  const showUacWaiting = (waiting: boolean) => {
    context.setSDKStatus?.(waiting ? 'computer_use_uac' : 'computer_use_uac_done');
    if (waiting) {
      needsScreenshotAfterUac = true;
      context.appendSystemMessage?.(createSystemMessage(UAC_WAIT_MESSAGE, 'info'));
    }
  };
  try {
    const { telemetry, ...result } = await runMcpToolCall({
      signal,
      serverName: COMPUTER_USE_MCP_SERVER_NAME,
      toolName,
      limits,
      invoke: (requestSignal, reportProgress) => {
        const run = async () => {
          requestSignal.throwIfAborted();
          currentToolUseContext = context;
          return invokeComputerUse(requestSignal, reportProgress);
        };
        if (!windowsTurn) return run();
        const start = () => windowsActionSignal.run(requestSignal, run);
        const operation = windowsTurn.dispatchTail ? windowsTurn.dispatchTail.then(start) : start();
        const tail = operation.then(() => undefined, () => undefined);
        windowsTurn.dispatchTail = tail;
        void tail.then(() => { if (windowsTurn.dispatchTail === tail) windowsTurn.dispatchTail = undefined; });
        return operation;
      },
      onProgress: progress => emit({
        type: 'mcp_progress',
        status: 'progress',
        serverName: COMPUTER_USE_MCP_SERVER_NAME,
        toolName,
        progress: progress.progress,
        total: progress.total,
        progressMessage: progress.message,
      }),
      onWait: wait => {
        logForDebugging(`[Computer Use MCP] ${toolName} waiting ${wait.elapsedMs}ms (${wait.idleMs}ms idle)`);
        emit({
          type: 'mcp_progress',
          status: 'progress',
          serverName: COMPUTER_USE_MCP_SERVER_NAME,
          toolName,
          elapsedTimeMs: wait.elapsedMs,
          progressMessage: `等待 Computer Use ${toolName} 返回结果 · ${Math.floor(wait.elapsedMs / 1000)}s（无新进展 ${Math.floor(wait.idleMs / 1000)}s）`,
        });
      },
    });
    async function invokeComputerUse(requestSignal: AbortSignal, reportProgress: (progress: CuToolProgress) => void) {
        if (!uacGuard) return dispatch(toolName, args, requestSignal, reportProgress);
        const turn = context.mainTurnAbortController;
        if (!turn) {
          return runWithUacGuard(requestSignal, showUacWaiting,
            (beforeAction, signal) => dispatch(toolName, args, signal, reportProgress, beforeAction), uacGuard);
        }
        const guard = getTurnUacGuard(turn, showUacWaiting, uacGuard);
        let captureGeneration: number | undefined;
        let result: CuCallToolResult;
        try {
          result = await dispatch(toolName, args, requestSignal, reportProgress, async action => {
            const canRunBeforeRefresh = action === 'screenshot' || action === 'open_application' || action === 'switch_display' ||
              action === 'list_windows' || action === 'get_window' || action === 'list_granted_applications';
            await guard.beforeAction(requestSignal);
            if (process.platform === 'win32') {
              const { releaseWindowsInputBeforeAction } = await import('./platforms/win32.js');
              await releaseWindowsInputBeforeAction(needsScreenshotAfterUac);
            }
            if (needsScreenshotAfterUac && !canRunBeforeRefresh) {
              throw new Error(UAC_FRESH_SCREENSHOT);
            }
            if (action === 'screenshot' || action === 'open_application') captureGeneration = guard.generation;
          });
        } finally {
          await guard.afterAction(requestSignal);
        }
        if (captureGeneration !== undefined && captureGeneration === guard.generation && result.screenshot && !result.isError) {
          needsScreenshotAfterUac = false;
        }
        return result;
    }
    if (telemetry?.error_kind) {
      logForDebugging(`[Computer Use MCP] ${toolName} error_kind=${telemetry.error_kind}`);
    }
    // MCP content blocks → Anthropic API blocks. Preserve the full payload for
    // both success and structured partial-failure results.
    const data = Array.isArray(result.content) ? result.content.map(item => item.type === 'image' ? {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: item.mimeType ?? 'image/jpeg',
        data: item.data
      }
    } : {
      type: 'text' as const,
      text: item.type === 'text' ? item.text : ''
    }) : result.content;
    if (result.isError) {
      const first = Array.isArray(result.content)
        ? result.content.find(item => item.type === 'text')
        : undefined;
      const message = first && first.type === 'text' ? first.text : 'Unknown error';
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
        message,
        'MCP tool returned error',
        result._meta ? { _meta: result._meta } : undefined,
        data as ToolResultBlockParam['content'],
      );
    }

    return { data };
  } catch (error) {
    if (windowsTurn?.stop.signal.aborted && !context.abortController.signal.aborted) {
      await windowsTurn.cleanup;
      throw new McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(STOPPED_BY_ESCAPE, 'Computer Use stopped by user');
    }
    if (error instanceof UacTimeoutError) {
      context.abortController.abort(error);
      return { data: undefined };
    }
    if (context.abortController.signal.aborted && error instanceof Error && error.name === 'AbortError') {
      return { data: undefined };
    }
    throw error;
  }
}

export function getComputerUseMCPToolOverrides(toolName: string): ComputerUseMCPToolOverrides {
  const call: CallOverride = async (args, context, _canUseTool, parentMessage, onProgress) => {
    // The lock and Esc callback are process-wide. Keep background agents out of
    // CU instead of letting their cleanup release the main session's lock.
    if (context.agentId) {
      throw new Error('Computer Use is available only in the main session. Ask the main agent to perform this action.')
    }
    const { dispatch } = getOrBind();
    return callComputerUseTool({
      dispatch,
      toolName,
      args,
      context,
      parentMessage,
      onProgress,
      uacGuard: process.platform === 'win32'
        ? { probe: (await import('./win32/uacProbe.js')).desktopState }
        : undefined,
    });
  };
  return {
    ...getComputerUseMCPRenderingOverrides(toolName),
    call
  };
}

/**
 * Render the approval dialog mid-call via `setToolJSX` + `Promise`, wait for
 * the user. Mirrors `spawnMultiAgent.ts:419-436` (the `It2SetupPrompt` pattern).
 *
 * The merge-into-AppState that used to live here (dedupe + truthy-only flags)
 * is now in the package's `bindSessionContext` → `onAllowedAppsChanged`.
 */
async function runPermissionDialog(req: CuPermissionRequest, dialogSignal: AbortSignal): Promise<CuPermissionResponse> {
  const context = tuc();
  // doge fork: auto mode (/auto → bypassPermissions) skips the consent
  // dialog — the session is already fully released. Plan mode entered from
  // /auto is the zero-ask plan interlude (isAutoBypassActive excludes it):
  // CU calls are denied by the permission pipeline before reaching here.
  // tccState (macOS OS-level permissions missing) must still show:
  // auto-granting the app list is meaningless while the OS gate is closed.
  if (isAutoBypassActive(context.getAppState().toolPermissionContext) && !req.tccState) {
    const response = buildAutoGrantResponse(req);
    logForDebugging(`[Computer Use MCP] auto mode auto-granted request_access: ${response.granted.map(g => g.displayName).join(', ') || '(none)'}`);
    return response;
  }
  const setToolJSX = context.setToolJSX;
  if (!setToolJSX) {
    // Shouldn't happen — main.tsx gate excludes non-interactive. Fail safe.
    return {
      granted: [],
      denied: [],
      flags: DEFAULT_GRANT_FLAGS,
      userConsented: false,
      permissionUIUnavailable: true,
    };
  }
  try {
    return await new Promise<CuPermissionResponse>((resolve, reject) => {
      const signals = [dialogSignal, context.abortController.signal];
      const cleanup = (): void => {
        for (const signal of signals) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException('Computer Use permission dialog aborted', 'AbortError'));
      };
      if (signals.some(signal => signal.aborted)) {
        onAbort();
        return;
      }
      for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
      setToolJSX({
        jsx: React.createElement(ComputerUseApproval, {
          request: req,
          onDone: (resp: CuPermissionResponse) => {
            cleanup();
            resolve(resp);
          }
        }),
        shouldHidePromptInput: true
      });
    });
  } finally {
    setToolJSX(null);
  }
}

export const _test = {
  callComputerUseTool,
  runPermissionDialog,
};

// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
// Background memory consolidation. Fires the /dream prompt as a forked
// subagent when time-gate passes AND enough sessions have accumulated.
//
// Gate order (cheapest first):
//   1. Time: hours since lastConsolidatedAt >= minHours (one stat)
//   2. Sessions: transcript count with mtime > lastConsolidatedAt >= minSessions
//   3. Lock: no other process mid-consolidation
//
// State is closure-scoped inside initAutoDream() rather than module-level
// (tests call initAutoDream() in beforeEach for a fresh closure).

import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import {
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import {
  createUserMessage,
  createMemorySavedMessage,
} from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ToolUseContext } from '../../Tool.js'
import { logEvent } from '../analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { isAutoMemoryEnabled, getAutoMemPath } from '../../memdir/paths.js'
import { isAutoDreamEnabled } from './config.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { findProjectDir } from '../../utils/sessionStoragePortable.js'
import {
  getOriginalCwd,
  getKairosActive,
  getIsRemoteMode,
  getSessionId,
} from '../../bootstrap/state.js'
import { createAutoMemCanUseTool, drainPendingExtraction } from '../extractMemories/extractMemories.js'
import { buildConsolidationPrompt } from './consolidationPrompt.js'
import {
  readLastConsolidatedAt,
  listSessionsTouchedSince,
  tryAcquireConsolidationLock,
  recordConsolidation,
} from './consolidationLock.js'
import {
  registerDreamTask,
  addDreamTurn,
  finishDreamTask,
  isDreamTask,
} from '../../tasks/DreamTask/DreamTask.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'

// Scan throttle: when time-gate passes but session-gate doesn't, the lock
// mtime doesn't advance, so the time-gate keeps passing every turn.
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000

type AutoDreamConfig = {
  minHours: number
  minSessions: number
}

const DEFAULTS: AutoDreamConfig = {
  minHours: 24,
  minSessions: 5,
}

/**
 * Thresholds from tengu_onyx_plover. The enabled gate lives in config.ts
 * (isAutoDreamEnabled); this returns only the scheduling knobs. Defensive
 * per-field validation since GB cache can return stale wrong-type values.
 */
function getConfig(): AutoDreamConfig {
  const raw =
    getFeatureValue_CACHED_MAY_BE_STALE<Partial<AutoDreamConfig> | null>(
      'tengu_onyx_plover',
      null,
    )
  return {
    minHours:
      typeof raw?.minHours === 'number' &&
      Number.isFinite(raw.minHours) &&
      raw.minHours > 0
        ? raw.minHours
        : DEFAULTS.minHours,
    minSessions:
      typeof raw?.minSessions === 'number' &&
      Number.isFinite(raw.minSessions) &&
      raw.minSessions > 0
        ? raw.minSessions
        : DEFAULTS.minSessions,
  }
}

function isGateOpen(): boolean {
  if (getKairosActive()) return false // KAIROS mode uses disk-skill dream
  if (getIsRemoteMode()) return false
  if (!isAutoMemoryEnabled()) return false
  return isAutoDreamEnabled()
}

type AppendSystemMessageFn = NonNullable<ToolUseContext['appendSystemMessage']>

let runner:
  | ((
      context: REPLHookContext,
      appendSystemMessage?: AppendSystemMessageFn,
      extraction?: Promise<void>,
    ) => Promise<void>)
  | null = null

/**
 * Call once at startup (from backgroundHousekeeping alongside
 * initExtractMemories), or per-test in beforeEach for a fresh closure.
 */
export function initAutoDream(): void {
  let lastSessionScanAt = 0

  runner = async function scheduleDream(context, appendSystemMessage, extraction) {
    if (!isGateOpen()) return
    const cfg = getConfig()

    // --- Time gate ---
    let lastAt: number
    try {
      lastAt = await readLastConsolidatedAt()
    } catch (e: unknown) {
      logForDebugging(
        `[autoDream] readLastConsolidatedAt failed: ${(e as Error).message}`,
      )
      return
    }
    const hoursSince = (Date.now() - lastAt) / 3_600_000
    if (hoursSince < cfg.minHours) return

    // --- Scan throttle ---
    const sinceScanMs = Date.now() - lastSessionScanAt
    if (sinceScanMs < SESSION_SCAN_INTERVAL_MS) {
      logForDebugging(
        `[autoDream] scan throttle — time-gate passed but last scan was ${Math.round(sinceScanMs / 1000)}s ago`,
      )
      return
    }
    // --- Session gate ---
    const scannedAt = Date.now()
    let sessionIds: string[]
    try {
      sessionIds = await listSessionsTouchedSince(lastAt)
    } catch (e: unknown) {
      logForDebugging(
        `[autoDream] listSessionsTouchedSince failed: ${(e as Error).message}`,
      )
      return
    }
    // Exclude the current session (its mtime is always recent).
    const currentSession = getSessionId()
    sessionIds = sessionIds.filter(id => id !== currentSession)
    if (sessionIds.length < cfg.minSessions) {
      lastSessionScanAt = Date.now()
      logForDebugging(
        `[autoDream] skip — ${sessionIds.length} sessions since last consolidation, need ${cfg.minSessions}`,
      )
      return
    }

    // --- Lock ---
    const abortController = new AbortController()
    const signal = abortController.signal
    let release: (() => Promise<void>) | null
    try {
      release = await tryAcquireConsolidationLock(lastAt, abortController)
    } catch (e: unknown) {
      logForDebugging(
        `[autoDream] lock acquire failed: ${(e as Error).message}`,
      )
      return
    }
    if (!release) return
    const releaseLease = release
    if (context.toolUseContext.abortController.signal.aborted) {
      await releaseLease()
      return
    }
    lastSessionScanAt = Date.now()

    logForDebugging(
      `[autoDream] firing — ${hoursSince.toFixed(1)}h since last, ${sessionIds.length} sessions to review`,
    )
    logEvent('tengu_auto_dream_fired', {
      hours_since: Math.round(hoursSince),
      sessions_since: sessionIds.length,
    })

    const setAppState =
      context.toolUseContext.setAppStateForTasks ??
      context.toolUseContext.setAppState
    const taskId = registerDreamTask(setAppState, {
      sessionsReviewing: sessionIds.length,
      stop: async () => {
        abortController.abort()
        await job
      },
    })
    const job = runDream()

    async function runDream(): Promise<void> {
      let status: 'completed' | 'failed' = 'failed'
      try {
        const cacheSafeParams = createCacheSafeParams(context)
        // Same-turn extraction can update the index. Let it finish before the
        // dream takes inventory. The main response need not wait for either job.
        signal.throwIfAborted()
        if (extraction) {
          await Promise.race([
            extraction.then(() => drainPendingExtraction()),
            new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
          ])
        }
        signal.throwIfAborted()
        const memoryRoot = getAutoMemPath()
        // Read path: findProjectDir tolerates hash-suffix mismatches on long paths.
        const transcriptDir =
          (await findProjectDir(getOriginalCwd())) ??
          getProjectDir(getOriginalCwd())
        // Tool constraints note goes in `extra`, not the shared prompt body —
        // manual /dream runs in the main loop with normal permissions and this
        // would be misleading there.
        const extra = `

**Tool constraints for this run:** Bash is restricted to read-only commands (\`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, \`tail\`, and similar). Anything that writes, redirects to a file, or modifies state will be denied. Plan your exploration with this in mind — no need to probe.

Sessions since last consolidation (${sessionIds.length}):
${sessionIds.map(id => `- ${id}`).join('\n')}`
        const prompt = buildConsolidationPrompt(memoryRoot, transcriptDir, extra)

        const result = await runForkedAgent({
          promptMessages: [createUserMessage({ content: prompt })],
          cacheSafeParams,
          canUseTool: createAutoMemCanUseTool(memoryRoot),
          querySource: 'auto_dream',
          forkLabel: 'auto_dream',
          skipTranscript: true,
          overrides: { abortController, requireCanUseTool: true },
          onMessage: makeDreamProgressWatcher(taskId, setAppState),
        })

        signal.throwIfAborted()
        if (result.messages.some(msg => msg.type === 'assistant' && msg.isApiErrorMessage)) {
          throw new Error('Dream model request failed')
        }
        // Sessions touched while the model runs stay eligible next time.
        await recordConsolidation(scannedAt)
        status = 'completed'
        // Inline completion summary in the main transcript (same surface as
        // extractMemories's "Saved N memories" message).
        const dreamState = context.toolUseContext.getAppState().tasks?.[taskId]
        if (
          appendSystemMessage &&
          isDreamTask(dreamState) &&
          dreamState.filesTouched.length > 0
        ) {
          appendSystemMessage({
            ...createMemorySavedMessage(dreamState.filesTouched),
            verb: 'Improved',
          })
        }
        logForDebugging(
          `[autoDream] completed — cache: read=${result.totalUsage.cache_read_input_tokens} created=${result.totalUsage.cache_creation_input_tokens}`,
        )
        logEvent('tengu_auto_dream_completed', {
          cache_read: result.totalUsage.cache_read_input_tokens,
          cache_created: result.totalUsage.cache_creation_input_tokens,
          output: result.totalUsage.output_tokens,
          sessions_reviewed: sessionIds.length,
        })
      } catch (e: unknown) {
        if (!signal.aborted) {
          logForDebugging(`[autoDream] fork failed: ${(e as Error).message}`)
          logEvent('tengu_auto_dream_failed', {})
        }
      } finally {
        await releaseLease().catch(error => {
          logForDebugging(`[autoDream] lock release failed: ${error.message}`)
        })
        finishDreamTask(taskId, signal.aborted && status !== 'completed' ? 'stopped' : status, setAppState)
      }
    }
  }
}

/**
 * Watch the forked agent's messages. For each assistant turn, extracts any
 * text blocks (the agent's reasoning/summary — what the user wants to see)
 * and collapses tool_use blocks to a count. Edit/Write file_paths are
 * collected for phase-flip + the inline completion message.
 */
function makeDreamProgressWatcher(
  taskId: string,
  setAppState: import('../../Task.js').SetAppState,
): (msg: Message) => void {
  return msg => {
    if (msg.type !== 'assistant') return
    let text = ''
    let toolUseCount = 0
    const touchedPaths: string[] = []
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        text += block.text
      } else if (block.type === 'tool_use') {
        toolUseCount++
        if (
          block.name === FILE_EDIT_TOOL_NAME ||
          block.name === FILE_WRITE_TOOL_NAME
        ) {
          const input = block.input as { file_path?: unknown }
          if (typeof input.file_path === 'string') {
            touchedPaths.push(input.file_path)
          }
        }
      }
    }
    addDreamTurn(
      taskId,
      { text: text.trim(), toolUseCount },
      touchedPaths,
      setAppState,
    )
  }
}

/**
 * Entry point from stopHooks. No-op until initAutoDream() has been called.
 * Resolves when the scheduling decision is made. The registered task runs
 * independently so stream-json can deliver the main result before the dream.
 */
export async function scheduleAutoDream(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn,
  extraction?: Promise<void>,
): Promise<void> {
  await runner?.(context, appendSystemMessage, extraction)
}

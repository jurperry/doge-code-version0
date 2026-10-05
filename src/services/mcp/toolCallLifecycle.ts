/** Request-scoped deadlines; a silent MCP must give control back to the agent. */
export interface McpCallLimits { idleMs: number; totalMs: number; waitIntervalMs: number }
export interface McpCallProgress { progress: number; total?: number; message?: string }
export interface McpCallWait { elapsedMs: number; idleMs: number; lastProgress?: McpCallProgress }

function positiveTimeout(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 && number <= 2_147_483_647 ? number : fallback
}

export function mcpToolCallLimits(env: Record<string, string | undefined> = process.env): McpCallLimits {
  const totalMs = positiveTimeout(env.MCP_TOOL_TIMEOUT, 600_000)
  return { totalMs, idleMs: Math.min(totalMs, positiveTimeout(env.MCP_TOOL_IDLE_TIMEOUT, 120_000)), waitIntervalMs: 30_000 }
}

export class McpToolTimeoutError extends Error {
  readonly name = 'McpToolTimeoutError'
  constructor(readonly kind: 'idle' | 'total', server: string, tool: string, ms: number) {
    super(`MCP server "${server}" tool "${tool}" timed out: ${kind === 'idle' ? 'no advancing progress for' : 'maximum call duration'} ${ms / 1000}s. ` +
      'The request was cancelled; its remote outcome is unknown. Check tool/input suitability, choose an appropriate alternative or report the blocker. Do not blindly repeat operations with side effects.')
  }
}

export async function runMcpToolCall<T>(opts: {
  signal: AbortSignal
  serverName: string
  toolName: string
  invoke: (signal: AbortSignal, progress: (update: McpCallProgress) => void) => Promise<T>
  onProgress?: (update: McpCallProgress) => void
  onWait?: (update: McpCallWait) => void
  limits?: McpCallLimits
}): Promise<T> {
  const { signal, serverName, toolName } = opts
  signal.throwIfAborted()
  const limits = opts.limits ?? mcpToolCallLimits()
  const request = new AbortController()
  const start = Date.now()
  let lastProgressAt = start, lastProgress: McpCallProgress | undefined, settled = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let totalTimer: ReturnType<typeof setTimeout> | undefined
  let waitTimer: ReturnType<typeof setInterval> | undefined
  let rejectAbort: (error: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const stop = (reason: unknown) => {
    if (settled) return
    // Reject first: SDK listeners may synchronously reject with a generic AbortError.
    rejectAbort(reason)
    request.abort(reason)
  }
  const userAbort = () => stop(signal.reason ?? new DOMException('MCP request cancelled', 'AbortError'))
  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => stop(new McpToolTimeoutError('idle', serverName, toolName, limits.idleMs)), limits.idleMs)
  }
  signal.addEventListener('abort', userAbort, { once: true })
  try {
    totalTimer = setTimeout(() => stop(new McpToolTimeoutError('total', serverName, toolName, limits.totalMs)), limits.totalMs)
    scheduleIdle()
    waitTimer = setInterval(() => {
      if (!settled) opts.onWait?.({ elapsedMs: Date.now() - start, idleMs: Date.now() - lastProgressAt, lastProgress })
    }, limits.waitIntervalMs)
    const progress = (update: McpCallProgress) => {
      if (settled || request.signal.aborted || !Number.isFinite(update.progress) || update.progress < 0 ||
        (lastProgress && update.progress <= lastProgress.progress)) return
      lastProgress = update
      lastProgressAt = Date.now()
      scheduleIdle()
      opts.onProgress?.(update)
    }
    return await Promise.race([opts.invoke(request.signal, progress), aborted])
  } finally {
    settled = true
    signal.removeEventListener('abort', userAbort)
    if (idleTimer) clearTimeout(idleTimer)
    if (totalTimer) clearTimeout(totalTimer)
    if (waitTimer) clearInterval(waitTimer)
  }
}

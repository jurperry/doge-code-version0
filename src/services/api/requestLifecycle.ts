import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk'

const DEFAULT_TIMEOUT_MS = 90_000
export function validateModelEndpoint(input: Parameters<typeof fetch>[0]): void {
  let endpoint: URL
  try { endpoint = new URL(input instanceof Request ? input.url : String(input)) }
  catch { throw new Error('Invalid model API endpoint URL') }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('Model API endpoint must use HTTP or HTTPS')
}
export function validatedTimeout(value: string | undefined, fallback = DEFAULT_TIMEOUT_MS): number {
  const parsed = Number(value)
  return value?.trim() && Number.isInteger(parsed) && parsed >= 10 && parsed <= 600_000
    ? parsed : fallback
}
export function requestTimeouts(): { headerMs: number; idleMs: number } {
  return {
    headerMs: validatedTimeout(process.env.API_TIMEOUT_MS),
    idleMs: validatedTimeout(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS),
  }
}

/** Bound both response headers and raw body reads; heartbeats count as activity. */
export async function requestFetch(
  inner: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeouts = requestTimeouts(),
): Promise<Response> {
  validateModelEndpoint(input)
  const controller = new AbortController()
  const parentSignal = init.signal ?? (input instanceof Request ? input.signal : undefined)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let finished = false
  const cancel = () => {
    controller.abort()
    const activeReader = reader
    void activeReader?.cancel().catch(() => {}).finally(() => {
      try { activeReader.releaseLock() } catch {}
    })
  }
  const cleanup = () => {
    finished = true
    parentSignal?.removeEventListener('abort', cancel)
  }
  if (parentSignal?.aborted) throw new APIUserAbortError()
  parentSignal?.addEventListener('abort', cancel, { once: true })

  async function bounded<T>(operation: Promise<T>, ms: number, phase: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      const value = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new APIUserAbortError())
          if (parentSignal?.aborted) return onAbort()
          parentSignal?.addEventListener('abort', onAbort, { once: true })
          timer = setTimeout(() => {
            reject(new APIConnectionTimeoutError({ message: `${phase} timeout after ${ms}ms` }))
            cancel()
          }, ms)
        }),
      ])
      if (parentSignal?.aborted) throw new APIUserAbortError()
      return value
    } catch (error) {
      if (parentSignal?.aborted) throw new APIUserAbortError()
      if (error instanceof APIConnectionError) throw error
      throw new APIConnectionError({ message: `${phase} connection failed: ${error instanceof Error ? error.message : String(error)}`, cause: error })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort) parentSignal?.removeEventListener('abort', onAbort)
    }
  }

  try {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    const method = init.method ?? (input instanceof Request ? input.method : 'GET')
    // Bun 1.3.11 may silently resend a POST after a reused socket resets.
    // Both options are required to prevent a resend outside the retry budget.
    // https://github.com/oven-sh/bun/issues/28706
    if (typeof Bun !== 'undefined' && method.toUpperCase() === 'POST') headers.set('Connection', 'close')
    const response = await bounded(Promise.resolve().then(() => inner(input, { ...init, headers, ...(method.toUpperCase() === 'POST' ? { keepalive: false } : {}), signal: controller.signal })), timeouts.headerMs, 'Response headers')
    if (!response.body) { cleanup(); return response }
    reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(output) {
        if (finished) return
        try {
          const next = await bounded(reader!.read(), timeouts.idleMs, 'Response body idle')
          if (next.done) { cleanup(); reader!.releaseLock(); output.close() }
          else output.enqueue(next.value)
        } catch (error) {
          cancel(); cleanup(); output.error(error)
        }
      },
      cancel() { cancel(); cleanup() },
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch (error) {
    cancel(); cleanup(); throw error
  }
}

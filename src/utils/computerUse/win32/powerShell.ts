import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { join } from 'node:path'

// Scope the cancellable helpers to one Windows Computer Use dispatch.
export const windowsActionSignal = new AsyncLocalStorage<AbortSignal>()

function powershellPath(): string {
  if (process.platform !== 'win32') return 'powershell'
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

let observeSpawn: (() => void) | undefined

type PowerShellResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export const POWER_SHELL_PREFIX = "$ErrorActionPreference = 'Stop'\n[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"

function summarize(value: string): string {
  const text = value.trim()
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

export class PowerShellTimeoutError extends Error {}

function assertPowerShellSuccess(result: PowerShellResult, timedOut = false): string {
  if (timedOut || result.exitCode !== 0) {
    const detail = summarize(result.stderr) || summarize(result.stdout) || 'no diagnostic output'
    const reason = timedOut
      ? 'PowerShell timed out'
      : `PowerShell exited with code ${result.exitCode ?? 'unknown'}`
    const message = `${reason}: ${detail}. The action outcome is unknown; do not blindly retry operations with side effects.`
    if (timedOut) throw new PowerShellTimeoutError(message)
    throw new Error(message)
  }
  return result.stdout.trim()
}

export function runPowerShellSync(script: string, timeoutMs = 10_000, stdin?: string): string {
  let result: PowerShellResult
  let timedOut = false
  try {
    observeSpawn?.()
    const completed = nodeSpawnSync(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', `${POWER_SHELL_PREFIX}${script}`],
      { encoding: 'utf8', input: stdin, timeout: timeoutMs, killSignal: 'SIGTERM', windowsHide: true },
    )
    if (completed.error) {
      timedOut = (completed.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      if (!timedOut) throw completed.error
    }
    result = {
      exitCode: completed.status,
      stdout: completed.stdout ?? '',
      stderr: completed.stderr ?? '',
    }
  } catch (error) {
    throw new Error(`PowerShell could not start or be awaited: ${error instanceof Error ? error.message : String(error)}. The action outcome is unknown; do not blindly retry operations with side effects.`)
  }
  return assertPowerShellSuccess(result, timedOut)
}

export async function runPowerShell(script: string, timeoutMs = 15_000, stdin?: string, signal?: AbortSignal): Promise<string> {
  signal ??= windowsActionSignal.getStore()
  signal?.throwIfAborted()
  observeSpawn?.()
  const proc = Bun.spawn(
    [powershellPath(), '-NoProfile', '-NonInteractive', '-Command', `${POWER_SHELL_PREFIX}${script}`],
    // Same visibility rule as the sync runner: helper/client PowerShell must
    // never flash or steal the foreground from the bound app.
    { stdin: stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  )
  let timedOut = false
  let completed = false
  const stop = () => { try { proc.kill() } catch {} }
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, timeoutMs)
  try {
    if (stdin !== undefined) {
      signal?.throwIfAborted()
      proc.stdin.write(stdin)
      await proc.stdin.end()
    }
    signal?.throwIfAborted()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    completed = true
    signal?.throwIfAborted()
    return assertPowerShellSuccess({ exitCode, stdout, stderr }, timedOut)
  } finally {
    if (!completed) stop()
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

export const _test = {
  assertPowerShellSuccess,
  observeSpawns(observer?: () => void) { observeSpawn = observer },
}

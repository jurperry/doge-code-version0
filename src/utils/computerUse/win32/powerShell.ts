import { spawnSync as nodeSpawnSync } from 'node:child_process'

type PowerShellResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

function summarize(value: string): string {
  const text = value.trim()
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

function assertPowerShellSuccess(result: PowerShellResult, timedOut = false): string {
  if (timedOut || result.exitCode !== 0) {
    const detail = summarize(result.stderr) || summarize(result.stdout) || 'no diagnostic output'
    const reason = timedOut
      ? 'PowerShell timed out'
      : `PowerShell exited with code ${result.exitCode ?? 'unknown'}`
    throw new Error(`${reason}: ${detail}. The action outcome is unknown; do not blindly retry operations with side effects.`)
  }
  return result.stdout.trim()
}

export function runPowerShellSync(script: string, timeoutMs = 10_000): string {
  let result: PowerShellResult
  let timedOut = false
  try {
    const completed = nodeSpawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'\n${script}`],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        windowsHide: true,
      },
    )
    timedOut = (completed.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
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

export async function runPowerShell(script: string, timeoutMs = 15_000, stdin?: string): Promise<string> {
  const proc = Bun.spawn(
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'\n${script}`],
    { stdin: stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' },
  )
  if (stdin !== undefined) {
    proc.stdin.write(stdin)
    await proc.stdin.end()
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill() } catch {}
  }, timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return assertPowerShellSuccess({ exitCode, stdout, stderr }, timedOut)
  } finally {
    clearTimeout(timer)
  }
}

export const _test = { assertPowerShellSuccess }

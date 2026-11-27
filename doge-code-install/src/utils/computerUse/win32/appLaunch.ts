import { setTimeout as delay } from 'node:timers/promises'
import { win32 as windowsPath } from 'node:path'
import { runPowerShell } from './powerShell.js'
import { listWindows, type WindowInfo } from './windowEnum.js'

export function comparableExePath(path: string): string {
  return windowsPath.normalize(path).toLowerCase()
}

export async function launchExactExecutable(file: string, signal?: AbortSignal): Promise<WindowInfo> {
  const encoded = Buffer.from(file, 'utf8').toString('base64')
  const status = await runPowerShell(`
${START_CU_APPLICATION}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
${buildPortableAppLaunchBlock()}
if ($proc) { $proc.Id }
`, 35_000, undefined, signal)
  const pid = Number(status)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Windows could not start "${file}".`)

  const identity = comparableExePath(file)
  const deadline = performance.now() + 10_000
  do {
    signal?.throwIfAborted()
    const candidates = listWindows(true).filter(window => window.path && comparableExePath(window.path) === identity)
    const selected = candidates.find(window => window.pid === pid) ?? candidates[0]
    if (selected) return selected
    await delay(100, undefined, { signal })
  } while (performance.now() < deadline)
  throw new Error(`Launched "${file}" but no window belonging to that executable appeared within 10s. If it opened another application, request access to that application's executable before binding its window.`)
}

export function buildPortableAppLaunchBlock(pathExpression = '$target'): string {
  return `$cuLaunchExe = (Resolve-Path -LiteralPath ${pathExpression}).Path
$proc = Start-CuApplication $cuLaunchExe (Split-Path -Parent $cuLaunchExe)
$launchPath = $cuLaunchExe`
}
export const START_CU_APPLICATION = `
function Start-CuApplication($file, $directory) {
    try {
        $startOptions = @{ FilePath = $file; PassThru = $true; ErrorAction = 'Stop' }
        if ($directory) { $startOptions.WorkingDirectory = $directory }
        Start-Process @startOptions
    } catch {
        for ($cause = $_.Exception; $cause; $cause = $cause.InnerException) {
            if ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) {
                throw 'Windows cancelled the launch. The user may have declined the UAC prompt. Ask before retrying.'
            }
        }
    }
}
`

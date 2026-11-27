import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getDogeConfigDir } from '../../dogeConfigDir.js'
import { buildBrokerServerScript } from './brokerScript.js'
import { currentUserSid, processStartTicks } from './nativeWindows.js'
import { runPowerShell, runPowerShellSync } from './powerShell.js'

const TASK_PREFIX = 'Doge Code Computer Use Elevation'
const PIPE_PROTOCOL = 'doge-cu-admin-v1'
const BROKER_IDLE_TIMEOUT_MS = 15 * 60 * 1000

export type PermanentElevationStatus = {
  supported: boolean
  enabled: boolean
  running: boolean
  needsRepair: boolean
}

type WindowsOwnerIdentity = {
  callerSid: string
  ownerStartTicks: string
}

export type PermanentElevationDescriptor = {
  callerSid: string
  taskName: string
  pipeName: string
  scriptPath: string
  logPath: string
  pidPath: string
  revocationPath: string
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

let cachedIdentity: WindowsOwnerIdentity | undefined

export function getWindowsOwnerIdentity(): WindowsOwnerIdentity {
  if (cachedIdentity) return cachedIdentity
  if (process.platform === 'win32') {
    cachedIdentity = { callerSid: currentUserSid(), ownerStartTicks: processStartTicks(process.pid) }
  } else {
    const identity = runPowerShellSync(`[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value + '|' + (Get-Process -Id ${process.pid}).StartTime.Ticks`, 5000).trim()
    const [callerSid, ownerStartTicks] = identity.split('|')
    cachedIdentity = { callerSid, ownerStartTicks }
  }
  if (!cachedIdentity.callerSid || !/^[1-9]\d*$/.test(cachedIdentity.ownerStartTicks ?? '')) {
    cachedIdentity = undefined
    throw new Error('Could not identify the Windows user or owner process for the Computer Use helper.')
  }
  return cachedIdentity
}

export function createPermanentElevationDescriptor(configDir: string, callerSid: string): Omit<PermanentElevationDescriptor, 'callerSid'> {
  const normalizedConfig = resolve(configDir).replace(/[\\/]+$/, '').toLowerCase()
  const scope = createHash('sha256').update(normalizedConfig, 'utf8').digest('hex').slice(0, 16)
  const scriptPath = resolve(configDir, 'computer-use', 'elevated-broker-v1.ps1')
  return {
    taskName: `${TASK_PREFIX} ${callerSid} ${scope}`,
    pipeName: `${PIPE_PROTOCOL}-${callerSid}-${scope}`,
    scriptPath,
    logPath: `${scriptPath}.log`,
    pidPath: `${scriptPath}.pid.json`,
    revocationPath: resolve(configDir, 'computer-use', 'elevated-broker-v1.revoking'),
  }
}

export function getPermanentElevationDescriptor(): PermanentElevationDescriptor {
  const { callerSid } = getWindowsOwnerIdentity()
  return { callerSid, ...createPermanentElevationDescriptor(getDogeConfigDir(), callerSid) }
}

function statusScript(descriptor: PermanentElevationDescriptor): string {
  const taskName = psLiteral(descriptor.taskName)
  const scriptPath = psLiteral(descriptor.scriptPath)
  const sid = psLiteral(descriptor.callerSid)
  return `
$task = Get-ScheduledTask -TaskName ${taskName} -ErrorAction SilentlyContinue
if ($null -eq $task) {
    [pscustomobject]@{ enabled = $false; running = $false; needsRepair = $false } | ConvertTo-Json -Compress
    exit 0
}
$action = @($task.Actions)[0]
$expectedExe = Join-Path $PSHOME 'powershell.exe'
$expectedArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f ${scriptPath}
$taskUser = [string]$task.Principal.UserId
$currentName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$userMatches = $taskUser -eq ${sid} -or $taskUser -ieq $currentName -or $taskUser -ieq $env:USERNAME
$valid = @($task.Actions).Count -eq 1 -and
    $action.Execute -ieq $expectedExe -and
    $null -ne $action.Arguments -and
    $action.Arguments -ieq $expectedArguments -and
    $task.Settings.Enabled -eq $true -and
    (Test-Path -LiteralPath ${scriptPath} -PathType Leaf) -and
    $userMatches -and
    [int]$task.Principal.LogonType -eq 3 -and
    [int]$task.Principal.RunLevel -eq 1
[pscustomobject]@{
    enabled = [bool]$valid
    running = [bool]$valid -and $task.State -eq 'Running'
    needsRepair = -not [bool]$valid
} | ConvertTo-Json -Compress
`
}

export function getPermanentElevationStatus(): PermanentElevationStatus {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, running: false, needsRepair: false }
  }
  const output = runPowerShellSync(statusScript(getPermanentElevationDescriptor()), 10_000)
  const parsed = JSON.parse(output) as Omit<PermanentElevationStatus, 'supported'>
  return {
    supported: true,
    enabled: parsed.enabled === true,
    running: parsed.running === true,
    needsRepair: parsed.needsRepair === true,
  }
}

export function assertPermanentElevationNotRevoking(): void {
  if (existsSync(getPermanentElevationDescriptor().revocationPath)) {
    throw new Error('Permanent Computer Use authorization is being revoked. No elevated action was started.')
  }
}

export async function startPermanentElevationTask(): Promise<PermanentElevationStatus> {
  assertPermanentElevationNotRevoking()
  const status = getPermanentElevationStatus()
  if (status.needsRepair) throw new Error('The permanent Computer Use authorization is invalid. Enable it again from Settings.')
  if (!status.supported || !status.enabled) return status
  if (!status.running) {
    const { taskName } = getPermanentElevationDescriptor()
    await runPowerShell(`Start-ScheduledTask -TaskName ${psLiteral(taskName)} -ErrorAction Stop`, 15_000)
    assertPermanentElevationNotRevoking()
  }
  return getPermanentElevationStatus()
}

async function runElevatedScript(script: string, errorPath: string): Promise<void> {
  rmSync(errorPath, { force: true })
  const wrapped = `$ErrorActionPreference = 'Stop'\ntry {\n${script}\n} catch {\n[System.IO.File]::WriteAllText(${psLiteral(errorPath)}, ($_ | Out-String), [System.Text.Encoding]::UTF8)\nexit 1\n}`
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  try {
    await runPowerShell(`
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $PSHOME 'powershell.exe'
$start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}'
$start.UseShellExecute = $true
$start.Verb = 'RunAs'
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
try {
    $process = [System.Diagnostics.Process]::Start($start)
    $process.WaitForExit()
    exit $process.ExitCode
} catch {
    for ($cause = $_.Exception; $cause; $cause = $cause.InnerException) {
        if ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) {
            [Console]::Error.WriteLine('[CU_PERMANENT_ELEVATION_CANCELLED] The user declined or dismissed the Windows elevation request.')
            exit 10
        }
    }
    throw
}
`, 300_000)
  } catch (error) {
    let detail = ''
    try { detail = readFileSync(errorPath, 'utf8').trim() } catch {}
    if (detail) throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`)
    throw error
  }
}

export function buildPermanentBrokerScript(descriptor: PermanentElevationDescriptor): string {
  const server = buildBrokerServerScript({
    pipeName: descriptor.pipeName,
    ownerPid: 0,
    ownerStartTicks: '0',
    callerSid: descriptor.callerSid,
    idleTimeoutMs: BROKER_IDLE_TIMEOUT_MS,
    revocationFile: descriptor.revocationPath,
  })
  return `try {\n$brokerProcess = Get-Process -Id $PID\n[System.IO.File]::WriteAllText(${psLiteral(descriptor.pidPath)}, ([pscustomobject]@{ pid = $brokerProcess.Id; startTicks = [string]$brokerProcess.StartTime.Ticks } | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)\n${server}\n} catch {\n[System.IO.File]::WriteAllText(${psLiteral(descriptor.logPath)}, ($_ | Out-String), [System.Text.Encoding]::UTF8)\nexit 1\n} finally {\nRemove-Item -LiteralPath ${psLiteral(descriptor.pidPath)} -Force -ErrorAction SilentlyContinue\n}`
}

export async function enablePermanentElevation(): Promise<PermanentElevationStatus> {
  if (process.platform !== 'win32') return getPermanentElevationStatus()
  const descriptor = getPermanentElevationDescriptor()
  if (existsSync(descriptor.revocationPath)) {
    const status = getPermanentElevationStatus()
    if (status.enabled || status.needsRepair) assertPermanentElevationNotRevoking()
    rmSync(descriptor.revocationPath, { force: true })
  }
  const groups = runPowerShellSync(`& (Join-Path $env:WINDIR 'System32\\whoami.exe') /groups /fo csv /nh`, 5000)
  if (!groups.includes('S-1-5-32-544')) {
    throw new Error('Permanent Computer Use authorization requires an administrator account. Use the existing per-session UAC prompt and enter administrator credentials instead.')
  }
  mkdirSync(dirname(descriptor.scriptPath), { recursive: true })
  writeFileSync(descriptor.scriptPath, `\uFEFF${buildPermanentBrokerScript(descriptor)}`, 'utf8')

  const registration = `
$ErrorActionPreference = 'Stop'
$existing = Get-ScheduledTask -TaskName ${psLiteral(descriptor.taskName)} -ErrorAction SilentlyContinue
if ($null -ne $existing) { Stop-ScheduledTask -TaskName ${psLiteral(descriptor.taskName)} -ErrorAction SilentlyContinue }
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f ${psLiteral(descriptor.scriptPath)})
$principal = New-ScheduledTaskPrincipal -UserId ${psLiteral(descriptor.callerSid)} -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$settings.Hidden = $true
Register-ScheduledTask -TaskName ${psLiteral(descriptor.taskName)} -Action $action -Principal $principal -Settings $settings -Force | Out-Null
`
  try {
    await runElevatedScript(registration, descriptor.logPath)
    await runPowerShell(`Start-ScheduledTask -TaskName ${psLiteral(descriptor.taskName)} -ErrorAction Stop`, 15_000)
    return getPermanentElevationStatus()
  } catch (error) {
    const status = getPermanentElevationStatus()
    if (!status.enabled && !status.needsRepair) {
      rmSync(descriptor.scriptPath, { force: true })
      rmSync(descriptor.logPath, { force: true })
      rmSync(descriptor.pidPath, { force: true })
    }
    throw error
  }
}

export async function disablePermanentElevation(): Promise<PermanentElevationStatus> {
  if (process.platform !== 'win32') return getPermanentElevationStatus()
  const descriptor = getPermanentElevationDescriptor()
  const pipePath = `\\\\.\\pipe\\${descriptor.pipeName}`
  mkdirSync(dirname(descriptor.revocationPath), { recursive: true })
  writeFileSync(descriptor.revocationPath, `${process.pid}\n`, 'utf8')
  try {
    await runElevatedScript(`
$metadata = $null
$broker = $null
if (Test-Path -LiteralPath ${psLiteral(descriptor.pidPath)} -PathType Leaf) {
    $metadata = Get-Content -LiteralPath ${psLiteral(descriptor.pidPath)} -Raw -Encoding UTF8 | ConvertFrom-Json
    $broker = Get-Process -Id ([int]$metadata.pid) -ErrorAction SilentlyContinue
}
if ($null -ne $broker) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($broker.Id)"
    $expectedExe = Join-Path $PSHOME 'powershell.exe'
    $identityMatches = [string]$broker.StartTime.Ticks -eq [string]$metadata.startTicks -and
        $broker.Path -ieq $expectedExe -and
        $null -ne $processInfo.CommandLine -and
        $processInfo.CommandLine.IndexOf(${psLiteral(descriptor.scriptPath)}, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $identityMatches) { throw 'The permanent Computer Use broker identity could not be verified.' }
    $gracefulDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while (Get-Process -Id $broker.Id -ErrorAction SilentlyContinue) {
        if ([DateTime]::UtcNow -ge $gracefulDeadline) { break }
        Start-Sleep -Milliseconds 100
    }
}
$task = Get-ScheduledTask -TaskName ${psLiteral(descriptor.taskName)} -ErrorAction SilentlyContinue
if ($null -ne $task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName ${psLiteral(descriptor.taskName)} -ErrorAction Stop
}
$confirmedGone = $false
if ($null -ne $metadata) {
    $broker = Get-Process -Id ([int]$metadata.pid) -ErrorAction SilentlyContinue
    if ($null -ne $broker) {
        Stop-Process -Id $broker.Id -Force -ErrorAction Stop
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while (Get-Process -Id $broker.Id -ErrorAction SilentlyContinue) {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'The permanent Computer Use broker did not stop.' }
            Start-Sleep -Milliseconds 100
        }
    }
    $confirmedGone = $true
}
if (-not $confirmedGone) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CuPermanentRevokeProbe {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool WaitForNamedPipe(string name, uint timeout);
}
'@
    $available = [CuPermanentRevokeProbe]::WaitForNamedPipe(${psLiteral(pipePath)}, 2000)
    $pipeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($available -or $pipeError -ne 2) {
        throw 'The permanent Computer Use broker is still running or busy. Authorization was not revoked.'
    }
}
if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName ${psLiteral(descriptor.taskName)} -Confirm:$false -ErrorAction Stop
}
`, descriptor.logPath)
  } catch (error) {
    rmSync(descriptor.revocationPath, { force: true })
    throw error
  }
  rmSync(descriptor.scriptPath, { force: true })
  rmSync(descriptor.logPath, { force: true })
  rmSync(descriptor.pidPath, { force: true })
  rmSync(descriptor.revocationPath, { force: true })
  return getPermanentElevationStatus()
}

import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBrokerServerScript } from './brokerScript.js'
import { runPowerShell, runPowerShellSync } from './powerShell.js'
import {
  assertPermanentElevationNotRevoking,
  getPermanentElevationDescriptor,
  getPermanentElevationStatus,
  getWindowsOwnerIdentity,
  startPermanentElevationTask,
} from './permanentElevation.js'

type Broker = {
  pipeName: string
  pid: number
  ownerPid: number
  ownerStartTicks: string
  permanent: boolean
  localProcess?: ReturnType<typeof Bun.spawn>
}
type Command = 'execute' | 'ping' | 'stop'

const CLIENT_SCRIPT = `
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', [string]$request.pipe, [System.IO.Pipes.PipeDirection]::InOut)
$exitCode = 1
$stage = 'connect'
try {
    $pipe.Connect(15000)
    $stage = 'exchange'
    $writer = [System.IO.BinaryWriter]::new($pipe, [System.Text.Encoding]::UTF8, $true)
    $reader = [System.IO.BinaryReader]::new($pipe, [System.Text.Encoding]::UTF8, $true)
    $writer.Write([string]$request.command)
    $writer.Write([string]$request.script)
    $writer.Write([string]$request.stdin)
    $writer.Write([int]$request.ownerPid)
    $writer.Write([long]$request.ownerStartTicks)
    $writer.Flush()
    $stdout = $reader.ReadString()
    $stderr = $reader.ReadString()
    $exitCode = $reader.ReadInt32()
    [Console]::Out.Write($stdout)
    [Console]::Error.Write($stderr)
} catch {
    [Console]::Error.WriteLine('[CU_HELPER_' + $stage.ToUpperInvariant() + '] ' + $_.Exception.Message)
    if ($stage -eq 'connect') { exit 11 }
    exit 12
} finally {
    $pipe.Dispose()
}
if ($exitCode -ne 0) { exit $exitCode }
`

function payload(broker: Broker, command: Command, script = '', stdin = ''): string {
  return JSON.stringify({
    pipe: broker.pipeName,
    command,
    script: Buffer.from(script, 'utf8').toString('base64'),
    stdin: Buffer.from(stdin, 'utf8').toString('base64'),
    ownerPid: broker.ownerPid,
    ownerStartTicks: broker.ownerStartTicks,
  })
}

function transactSync(broker: Broker, command: Command, timeoutMs: number, script = '', stdin = ''): string {
  if (transactionCount > 0) throw new Error('Another Computer Use action is still in progress. No new input was sent.')
  return runPowerShellSync(CLIENT_SCRIPT, timeoutMs, payload(broker, command, script, stdin))
}

function transact(broker: Broker, command: Command, timeoutMs: number, script = '', stdin = '', signal?: AbortSignal): Promise<string> {
  transactionCount++
  const result = transactionTail.then(() => {
    signal?.throwIfAborted()
    return runPowerShell(CLIENT_SCRIPT, timeoutMs, payload(broker, command, script, stdin), signal)
  })
  transactionTail = result.then(() => undefined, () => undefined).finally(() => { transactionCount-- })
  return result
}

let active: Broker | undefined
let starting: Promise<void> | undefined
let targetElevated = false
let transactionTail: Promise<void> = Promise.resolve()
let transactionCount = 0

async function startBroker(elevated: boolean, signal?: AbortSignal, permanent = false): Promise<void> {
  if (active) return
  if (starting) return starting
  const operation = (async () => {
    signal?.throwIfAborted()
    const pipeName = `doge-cu-${process.pid}-${randomUUID()}`
    const { callerSid, ownerStartTicks } = getWindowsOwnerIdentity()
    const server = buildBrokerServerScript({
      pipeName,
      ownerPid: permanent ? 0 : process.pid,
      ownerStartTicks: permanent ? '0' : ownerStartTicks,
      callerSid,
    })
    const scriptPath = join(tmpdir(), `doge-cu-broker-${randomUUID()}.ps1`)
    const logPath = `${scriptPath}.log`
    const scriptLiteral = scriptPath.replace(/'/g, "''")
    const logLiteral = logPath.replace(/'/g, "''")
    writeFileSync(scriptPath, `\uFEFFtry {\n${server}\n} catch {\n[System.IO.File]::WriteAllText('${logLiteral}', ($_ | Out-String), [System.Text.Encoding]::UTF8)\nexit 1\n}`, 'utf8')
    const broker: Broker = {
      pipeName,
      pid: 0,
      ownerPid: process.pid,
      ownerStartTicks,
      permanent,
    }
    try {
      if (elevated) {
        const rawPid = await runPowerShell(`
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = "$PSHOME\\powershell.exe"
$start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptLiteral}"'
$start.UseShellExecute = $true
$start.Verb = 'RunAs'
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
try {
    $process = [System.Diagnostics.Process]::Start($start)
    $process.Id
} catch {
    for ($cause = $_.Exception; $cause; $cause = $cause.InnerException) {
        if ($cause -is [System.ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) {
            [Console]::Error.WriteLine('[CU_HELPER_UAC_CANCELLED] The user declined or dismissed the Windows elevation request.')
            exit 10
        }
    }
    throw
}
`, 35_000, undefined, signal)
        broker.pid = Number(rawPid.trim())
      } else {
        broker.localProcess = Bun.spawn([
          'powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true })
        broker.pid = broker.localProcess.pid
      }
      if (!Number.isInteger(broker.pid) || broker.pid <= 0) throw new Error('The Windows Computer Use helper did not return a process ID.')
      active = broker
      if (await transact(broker, 'ping', 20_000, '', '', signal) !== 'ready') {
        throw new Error('The Windows Computer Use helper failed its readiness check.')
      }
    } catch (error) {
      if (active === broker) active = undefined
      if (broker.pid > 0) {
        try { await transact(broker, 'stop', 1500) } catch {}
      }
      let detail = ''
      if (broker.localProcess) {
        const exitCode = await Promise.race([broker.localProcess.exited, Bun.sleep(50).then(() => null)])
        if (exitCode !== null) detail = (await new Response(broker.localProcess.stderr).text()).trim()
      }
      if (!detail) {
        try { detail = readFileSync(logPath, 'utf8').trim() } catch {}
      }
      const stage = broker.pid > 0 ? 'READINESS' : 'LAUNCH'
      throw new Error(`[CU_HELPER_${stage}] Windows Computer Use helper failed. ${error instanceof Error ? error.message : String(error)}${detail ? ` Helper: ${detail}` : ''}`)
    } finally {
      try { unlinkSync(scriptPath) } catch {}
      try { unlinkSync(logPath) } catch {}
    }
  })()
  starting = operation
  try { await operation } finally { if (starting === operation) starting = undefined }
}

async function attachPermanentBroker(signal?: AbortSignal): Promise<boolean> {
  if (active) return true
  if (starting) return starting.then(() => active?.permanent === true)
  const operation = (async () => {
    signal?.throwIfAborted()
    assertPermanentElevationNotRevoking()
    const status = getPermanentElevationStatus()
    if (status.needsRepair) throw new Error('The permanent Computer Use authorization needs repair. Enable it again from Settings.')
    if (!status.enabled) return
    const descriptor = getPermanentElevationDescriptor()
    const { ownerStartTicks } = getWindowsOwnerIdentity()
    const broker: Broker = {
      pipeName: descriptor.pipeName,
      pid: 0,
      ownerPid: process.pid,
      ownerStartTicks,
      permanent: true,
    }
    active = broker
    try {
      if (!status.running) await startPermanentElevationTask()
      if (await transact(broker, 'ping', 20_000, '', '', signal) !== 'ready') {
        throw new Error('The permanent Windows Computer Use helper failed its readiness check.')
      }
    } catch (error) {
      if (active === broker) active = undefined
      throw new Error(`The permanent Windows Computer Use helper is unavailable. No input was sent. Enable it again from Settings if this persists. ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  starting = operation
  try {
    await operation
    return active?.permanent === true
  } finally {
    if (starting === operation) starting = undefined
  }
}

export async function ensureElevatedPowerShell(signal?: AbortSignal): Promise<void> {
  const broker = active
  if (broker) {
    try {
      await transact(broker, 'ping', 5000, '', '', signal)
      return
    } catch (error) {
      if (signal?.aborted) throw error
      forgetBroker(broker)
      if (!broker.permanent) {
        throw new Error(`The Windows Computer Use helper is unavailable. No input was sent; retry only after inspecting the target. ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (await attachPermanentBroker(signal)) return
  await startBroker(true, signal)
}

function forgetBroker(broker: Broker): void {
  if (active !== broker) return
  active = undefined
  targetElevated = false
}

/** Recover stale routing for cleanup without opening a new UAC prompt. */
export async function prepareComputerUseRelease(): Promise<void> {
  if (!targetElevated) return
  const broker = active
  if (!broker) {
    targetElevated = false
    return
  }
  try {
    await transact(broker, 'ping', 2000)
  } catch {
    forgetBroker(broker)
  }
}

export function setComputerUseTargetElevated(elevated: boolean): void {
  targetElevated = elevated
}

export function isElevatedPowerShellActive(): boolean {
  return active !== undefined
}

export function getElevatedPowerShellPid(): number | null {
  const pid = active?.pid
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : null
  }
}

export function runComputerUsePowerShellSync(script: string, timeoutMs = 10_000): string {
  const broker = active
  if (!targetElevated) return runPowerShellSync(script, timeoutMs)
  if (!broker) throw new Error('The required Windows Computer Use helper is unavailable. No action was sent.')
  return transactSync(broker, 'execute', timeoutMs, script)
}

export async function runComputerUsePowerShell(script: string, timeoutMs = 15_000, stdin?: string, signal?: AbortSignal): Promise<string> {
  const broker = active
  if (!targetElevated) return runPowerShell(script, timeoutMs, stdin, signal)
  if (!broker) throw new Error('The required Windows Computer Use helper is unavailable. No action was sent.')
  return transact(broker, 'execute', timeoutMs, script, stdin, signal)
}

export async function stopElevatedPowerShell(): Promise<void> {
  const broker = active
  active = undefined
  targetElevated = false
  if (!broker || broker.permanent) return
  try { await transact(broker, 'stop', 1500) } catch {}
}

export async function verifyPermanentElevation(): Promise<void> {
  if (!await attachPermanentBroker()) throw new Error('Permanent Computer Use authorization was not registered.')
  if (active?.permanent) active = undefined
}

export async function stopPermanentElevationBroker(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  let stopped = false
  try {
    const descriptor = getPermanentElevationDescriptor()
    const { ownerStartTicks } = getWindowsOwnerIdentity()
    const broker: Broker = {
      pipeName: descriptor.pipeName,
      pid: 0,
      ownerPid: process.pid,
      ownerStartTicks,
      permanent: true,
    }
    await transact(broker, 'stop', 2000)
    stopped = true
  } catch {}
  if (active?.permanent) active = undefined
  return stopped
}

process.once('exit', () => {
  const broker = active
  active = undefined
  targetElevated = false
  if (!broker || broker.permanent) return
  try { transactSync(broker, 'stop', 1500) } catch {}
})

export const _test = {
  activePid: () => active?.pid,
  startLocal: async () => {
    await startBroker(false)
    targetElevated = true
  },
  startPersistentLocal: async () => {
    await startBroker(false, undefined, true)
    targetElevated = true
    return active!.pipeName
  },
  attachPersistentLocal: async (pipeName: string) => {
    const { ownerStartTicks } = getWindowsOwnerIdentity()
    const broker: Broker = { pipeName, pid: 0, ownerPid: process.pid, ownerStartTicks, permanent: true }
    active = broker
    targetElevated = true
    await transact(broker, 'ping', 5000)
  },
  stopPipe: async (pipeName: string) => {
    const broker = active?.pipeName === pipeName ? active : undefined
    if (!broker) return
    active = undefined
    targetElevated = false
    await transact(broker, 'stop', 2000)
  },
  stop: stopElevatedPowerShell,
}

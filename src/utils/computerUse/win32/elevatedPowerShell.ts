import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POWER_SHELL_PREFIX, runPowerShell, runPowerShellSync } from './powerShell.js'

type Broker = { pipeName: string; pid: number; localProcess?: ReturnType<typeof Bun.spawn> }
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

// The bootstrap reads one framed script line and leaves the remaining input
// available to the action through the same console reader.
const ACTION_BOOTSTRAP = Buffer.from(`${POWER_SHELL_PREFIX}
$encoded = [Console]::In.ReadLine()
$script = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
try {
    & ([ScriptBlock]::Create($script))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`, 'utf16le').toString('base64')

const BROKER_CS = `
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class CuElevatedBroker {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern SafeWaitHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
    const uint Synchronize = 0x00100000;
    const uint WaitTimeout = 258;

    class Result {
        public string Stdout = "";
        public string Stderr = "";
        public int ExitCode = 1;
    }

    static bool OwnerAlive(int pid, long startTicks) {
        try {
            using (var process = Process.GetProcessById(pid)) return !process.HasExited && process.StartTime.Ticks == startTicks;
        } catch { return false; }
    }

    static NamedPipeServerStream CreatePipe(string name, string callerSid) {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(callerSid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        var current = WindowsIdentity.GetCurrent().User;
        if (current != null && current.Value != callerSid) {
            security.AddAccessRule(new PipeAccessRule(current, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        }
        try {
            return new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security);
        } catch (Exception error) {
            int allowRules = security.GetAccessRules(true, false, typeof(SecurityIdentifier)).Count;
            throw new InvalidOperationException("[CU_HELPER_PIPE_ACL] Could not create the named pipe (" + allowRules + " explicit access rules).", error);
        }
    }

    static Result Execute(NamedPipeServerStream pipe, int ownerPid, long ownerStartTicks, string script, string input) {
        uint clientPid;
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid)) {
            throw new InvalidOperationException("Could not identify the Computer Use action client.");
        }
        using (var client = OpenProcess(Synchronize, false, clientPid)) {
            if (client.IsInvalid || WaitForSingleObject(client, 0) != WaitTimeout) {
                throw new InvalidOperationException("The Computer Use action client is no longer running.");
            }
            return RunAction(client, ownerPid, ownerStartTicks, script, input);
        }
    }

    static Result RunAction(SafeWaitHandle client, int ownerPid, long ownerStartTicks, string script, string input) {
        var start = new ProcessStartInfo {
            FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\\v1.0\\powershell.exe"),
            Arguments = "-NoProfile -NonInteractive -EncodedCommand ${ACTION_BOOTSTRAP}",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        using (var process = new Process()) {
            process.StartInfo = start;
            if (!process.Start()) throw new InvalidOperationException("Could not start the elevated Computer Use action.");
            Task<string> stdout = process.StandardOutput.ReadToEndAsync();
            Task<string> stderr = process.StandardError.ReadToEndAsync();
            try {
                var frame = Encoding.UTF8.GetBytes(Convert.ToBase64String(Encoding.UTF8.GetBytes(script)) + "\\n" + input);
                Task feeding = Task.Run(() => {
                    process.StandardInput.BaseStream.Write(frame, 0, frame.Length);
                    process.StandardInput.Close();
                });
                while (!process.WaitForExit(50)) {
                    if (WaitForSingleObject(client, 0) != WaitTimeout || !OwnerAlive(ownerPid, ownerStartTicks)) {
                        throw new InvalidOperationException("The elevated Computer Use action was cancelled.");
                    }
                    if (feeding.IsFaulted) feeding.GetAwaiter().GetResult();
                }
                if (process.ExitCode == 0) feeding.GetAwaiter().GetResult();
                return new Result { Stdout = stdout.Result, Stderr = stderr.Result, ExitCode = process.ExitCode };
            } finally {
                try { if (!process.HasExited) process.Kill(); } catch {}
            }
        }
    }

    public static void Run(string pipeName, int ownerPid, long ownerStartTicks, string callerSid) {
        while (OwnerAlive(ownerPid, ownerStartTicks)) {
            using (var pipe = CreatePipe(pipeName, callerSid)) {
                var connecting = pipe.WaitForConnectionAsync();
                while (!connecting.IsCompleted) {
                    if (!OwnerAlive(ownerPid, ownerStartTicks)) return;
                    Thread.Sleep(100);
                }
                try { connecting.GetAwaiter().GetResult(); }
                catch (Exception error) { throw new InvalidOperationException("[CU_HELPER_PIPE_WAIT] Named pipe wait failed.", error); }

                try {
                    var reader = new BinaryReader(pipe, Encoding.UTF8, true);
                    var writer = new BinaryWriter(pipe, Encoding.UTF8, true);
                    string command = reader.ReadString();
                    string script = Encoding.UTF8.GetString(Convert.FromBase64String(reader.ReadString()));
                    string input = Encoding.UTF8.GetString(Convert.FromBase64String(reader.ReadString()));
                    if (command != "execute" && command != "ping" && command != "stop") {
                        throw new InvalidOperationException("Unknown Computer Use transaction command.");
                    }
                    if (command == "stop") {
                        writer.Write(""); writer.Write(""); writer.Write(0); writer.Flush();
                        return;
                    }
                    Result result = command == "ping"
                        ? new Result { Stdout = "ready", ExitCode = 0 }
                        : Execute(pipe, ownerPid, ownerStartTicks, script, input);
                    writer.Write(result.Stdout);
                    writer.Write(result.ExitCode == 0 ? result.Stderr : "[CU_HELPER_ACTION] " + result.Stderr);
                    writer.Write(result.ExitCode);
                    writer.Flush();
                } catch (Exception error) {
                    try {
                        var writer = new BinaryWriter(pipe, Encoding.UTF8, true);
                        writer.Write(""); writer.Write("[CU_HELPER_REQUEST] " + error.Message); writer.Write(21); writer.Flush();
                    } catch {}
                }
            }
        }
    }
}
`

function payload(broker: Broker, command: Command, script = '', stdin = ''): string {
  return JSON.stringify({
    pipe: broker.pipeName,
    command,
    script: Buffer.from(script, 'utf8').toString('base64'),
    stdin: Buffer.from(stdin, 'utf8').toString('base64'),
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

async function startBroker(elevated: boolean, signal?: AbortSignal): Promise<void> {
  if (active) return
  if (starting) return starting
  const operation = (async () => {
    signal?.throwIfAborted()
    const pipeName = `doge-cu-${process.pid}-${randomUUID()}`
    const identity = runPowerShellSync(`[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value + '|' + (Get-Process -Id ${process.pid}).StartTime.Ticks`, 5000).trim()
    const [callerSid, ownerStartTicks] = identity.split('|')
    if (!callerSid || !/^\d+$/.test(ownerStartTicks ?? '')) throw new Error('Could not identify the Windows user or owner process for the Computer Use helper.')
    const scriptPath = join(tmpdir(), `doge-cu-broker-${randomUUID()}.ps1`)
    const logPath = `${scriptPath}.log`
    const scriptLiteral = scriptPath.replace(/'/g, "''")
    const logLiteral = logPath.replace(/'/g, "''")
    const server = `try {\n[Console]::Out.Close()\n[Console]::Error.Close()\n$ErrorActionPreference = 'Stop'\nAdd-Type @'\n${BROKER_CS}\n'@\n[CuElevatedBroker]::Run('${pipeName}', ${process.pid}, ${ownerStartTicks}L, '${callerSid}')\n} catch {\n[System.IO.File]::WriteAllText('${logLiteral}', ($_ | Out-String), [System.Text.Encoding]::UTF8)\nexit 1\n}`
    writeFileSync(scriptPath, `\uFEFF${server}`, 'utf8')
    const broker = { pipeName, pid: 0 }
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
        ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
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

export async function ensureElevatedPowerShell(signal?: AbortSignal): Promise<void> {
  const broker = active
  if (broker) {
    try {
      await transact(broker, 'ping', 5000, '', '', signal)
      return
    } catch (error) {
      if (signal?.aborted) throw error
      forgetBroker(broker)
      throw new Error(`The Windows Computer Use helper is unavailable. No input was sent; retry only after inspecting the target. ${error instanceof Error ? error.message : String(error)}`)
    }
  }
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
  if (!broker) return
  try { await transact(broker, 'stop', 1500) } catch {}
}

process.once('exit', () => {
  const broker = active
  active = undefined
  targetElevated = false
  if (!broker) return
  try { transactSync(broker, 'stop', 1500) } catch {}
})

export const _test = {
  activePid: () => active?.pid,
  startLocal: async () => {
    await startBroker(false)
    targetElevated = true
  },
  stop: stopElevatedPowerShell,
}

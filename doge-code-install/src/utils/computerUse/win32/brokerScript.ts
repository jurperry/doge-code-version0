import { POWER_SHELL_PREFIX } from './powerShell.js'

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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeWaitHandle CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(SafeWaitHandle job, int infoClass, IntPtr data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(SafeWaitHandle job, IntPtr process);
    const int JobObjectExtendedLimitInformationClass = 9;
    const uint JobObjectLimitKillOnJobClose = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    struct JobObjectBasicLimitInformation {
        public IntPtr PerProcessUserTimeLimit;
        public IntPtr PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JobObjectExtendedLimitInformation {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    static SafeWaitHandle CreateActionJob(IntPtr process) {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid) {
            job.Dispose();
            throw new InvalidOperationException("Could not create the Computer Use action job.");
        }
        try {
            var info = new JobObjectExtendedLimitInformation();
            info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int size = Marshal.SizeOf(info);
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(info, data, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, data, (uint)size)) {
                    throw new InvalidOperationException("Could not protect the Computer Use action job. Win32 error " + Marshal.GetLastWin32Error());
                }
            } finally { Marshal.FreeHGlobal(data); }
            if (!AssignProcessToJobObject(job, process)) {
                throw new InvalidOperationException("Could not assign the Computer Use action to its job. Win32 error " + Marshal.GetLastWin32Error());
            }
            return job;
        } catch {
            job.Dispose();
            throw;
        }
    }

    static bool IsRevoked(string revocationFile) {
        return !string.IsNullOrEmpty(revocationFile) && File.Exists(revocationFile);
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

    static Result Execute(NamedPipeServerStream pipe, int ownerPid, long ownerStartTicks, string script, string input, string revocationFile) {
        if (ownerPid <= 0) throw new InvalidOperationException("The Computer Use owner is no longer running.");
        uint clientPid;
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid)) {
            throw new InvalidOperationException("Could not identify the Computer Use action client.");
        }
        using (var client = OpenProcess(Synchronize, false, clientPid))
        using (var owner = OpenProcess(Synchronize, false, (uint)ownerPid)) {
            if (client.IsInvalid || WaitForSingleObject(client, 0) != WaitTimeout) {
                throw new InvalidOperationException("The Computer Use action client is no longer running.");
            }
            if (owner.IsInvalid || WaitForSingleObject(owner, 0) != WaitTimeout || !OwnerAlive(ownerPid, ownerStartTicks)) {
                throw new InvalidOperationException("The Computer Use owner is no longer running.");
            }
            return RunAction(client, owner, script, input, revocationFile);
        }
    }

    static Result RunAction(SafeWaitHandle client, SafeWaitHandle owner, string script, string input, string revocationFile) {
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
            if (IsRevoked(revocationFile)) throw new InvalidOperationException("Permanent Computer Use authorization is being revoked.");
            if (WaitForSingleObject(owner, 0) != WaitTimeout) throw new InvalidOperationException("The Computer Use owner is no longer running.");
            if (!process.Start()) throw new InvalidOperationException("Could not start the elevated Computer Use action.");
            Task<string> stdout = process.StandardOutput.ReadToEndAsync();
            Task<string> stderr = process.StandardError.ReadToEndAsync();
            SafeWaitHandle actionJob = null;
            try {
                actionJob = CreateActionJob(process.Handle);
                var frame = Encoding.UTF8.GetBytes(Convert.ToBase64String(Encoding.UTF8.GetBytes(script)) + "\\n" + input);
                Task feeding = Task.Run(() => {
                    process.StandardInput.BaseStream.Write(frame, 0, frame.Length);
                    process.StandardInput.Close();
                });
                while (!process.WaitForExit(50)) {
                    if (IsRevoked(revocationFile) || WaitForSingleObject(client, 0) != WaitTimeout || WaitForSingleObject(owner, 0) != WaitTimeout) {
                        throw new InvalidOperationException("The elevated Computer Use action was cancelled.");
                    }
                    if (feeding.IsFaulted) feeding.GetAwaiter().GetResult();
                }
                if (process.ExitCode == 0) feeding.GetAwaiter().GetResult();
                return new Result { Stdout = stdout.Result, Stderr = stderr.Result, ExitCode = process.ExitCode };
            } finally {
                try { if (!process.HasExited) process.Kill(); } catch {}
                if (actionJob != null) actionJob.Dispose();
            }
        }
    }

    public static void Run(string pipeName, int sessionOwnerPid, long sessionOwnerStartTicks, string callerSid, int idleTimeoutMs, string revocationFile) {
        var idle = Stopwatch.StartNew();
        while (!IsRevoked(revocationFile) && (sessionOwnerPid <= 0 || OwnerAlive(sessionOwnerPid, sessionOwnerStartTicks))) {
            using (var pipe = CreatePipe(pipeName, callerSid)) {
                var connecting = pipe.WaitForConnectionAsync();
                while (!connecting.IsCompleted) {
                    if (IsRevoked(revocationFile)) return;
                    if (sessionOwnerPid > 0 && !OwnerAlive(sessionOwnerPid, sessionOwnerStartTicks)) return;
                    if (idleTimeoutMs > 0 && idle.ElapsedMilliseconds >= idleTimeoutMs) return;
                    Thread.Sleep(100);
                }
                try { connecting.GetAwaiter().GetResult(); }
                catch (Exception error) { throw new InvalidOperationException("[CU_HELPER_PIPE_WAIT] Named pipe wait failed.", error); }
                if (IsRevoked(revocationFile)) return;

                try {
                    var reader = new BinaryReader(pipe, Encoding.UTF8, true);
                    var writer = new BinaryWriter(pipe, Encoding.UTF8, true);
                    string command = reader.ReadString();
                    string script = Encoding.UTF8.GetString(Convert.FromBase64String(reader.ReadString()));
                    string input = Encoding.UTF8.GetString(Convert.FromBase64String(reader.ReadString()));
                    int ownerPid = reader.ReadInt32();
                    long ownerStartTicks = reader.ReadInt64();
                    if (command != "execute" && command != "ping" && command != "stop") {
                        throw new InvalidOperationException("Unknown Computer Use transaction command.");
                    }
                    if (command == "stop") {
                        writer.Write(""); writer.Write(""); writer.Write(0); writer.Flush();
                        return;
                    }
                    Result result = command == "ping"
                        ? new Result { Stdout = "ready", ExitCode = 0 }
                        : Execute(pipe, ownerPid, ownerStartTicks, script, input, revocationFile);
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
                idle.Restart();
            }
        }
    }
}
`

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function buildBrokerServerScript(options: {
  pipeName: string
  ownerPid: number
  ownerStartTicks: string
  callerSid: string
  idleTimeoutMs?: number
  revocationFile?: string
}): string {
  const { pipeName, ownerPid, ownerStartTicks, callerSid, idleTimeoutMs = 0, revocationFile = '' } = options
  return `[Console]::Out.Close()\n[Console]::Error.Close()\n$ErrorActionPreference = 'Stop'\nAdd-Type @'\n${BROKER_CS}\n'@\n[CuElevatedBroker]::Run(${psLiteral(pipeName)}, ${ownerPid}, ${ownerStartTicks}L, ${psLiteral(callerSid)}, ${idleTimeoutMs}, ${psLiteral(revocationFile)})`
}

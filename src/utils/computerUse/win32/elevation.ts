/**
 * Windows process elevation and integrity level detection.
 *
 * Provides utilities to:
 * - Detect current process integrity level (IL)
 * - Check target window IL for UIPI compatibility
 * - Test whether SendMessage can reach a given HWND
 * - Provide actionable UAC elevation guidance
 *
 * UIPI (User Interface Privilege Isolation) blocks SendMessage/PostMessage
 * from lower-IL processes to higher-IL windows. This module detects such
 * mismatches and recommends elevation when needed.
 */

import { runPowerShellSync } from './powerShell.js'
import { runComputerUsePowerShellSync } from './elevatedPowerShell.js'

export const INPUT_INTEGRITY_TYPES = `
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CuInputIntegrity {
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, out int value, int size, IntPtr needed);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }

    static int Integrity(IntPtr process) {
        IntPtr token;
        if (!OpenProcessToken(process, 0x0008, out token)) return -1;
        try {
            int size;
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out size); // TokenIntegrityLevel
            if (size <= 0) return -1;
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                if (!GetTokenInformation(token, 25, data, size, out size)) return -1;
                IntPtr sid = Marshal.ReadIntPtr(data);
                int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                return count == 0 ? -1 : Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            } finally { Marshal.FreeHGlobal(data); }
        } finally { CloseHandle(token); }
    }

    public static void RequireWindow(IntPtr window) {
        int interactive;
        if (!GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 6, out interactive, 4, IntPtr.Zero) || interactive == 0) {
            throw new InvalidOperationException("The Windows input desktop is unavailable. No input was sent.");
        }
        uint pid;
        if (GetWindowThreadProcessId(window, out pid) == 0) {
            throw new InvalidOperationException("The Windows input target could not be identified. No input was sent.");
        }
        using (var targetProcess = Process.GetProcessById((int)pid)) {
            if (string.Equals(targetProcess.ProcessName, "consent", StringComparison.OrdinalIgnoreCase)) {
                throw new InvalidOperationException("Windows UAC requires the user to respond directly. No input was sent.");
            }
        }
        IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        int target = -1;
        if (process != IntPtr.Zero) {
            try { target = Integrity(process); } finally { CloseHandle(process); }
        }
        int current = Integrity(GetCurrentProcess());
        if (current < 0 || target < 0) {
            throw new InvalidOperationException("Could not verify the Windows input target's integrity level. Ask the user to operate this window directly.");
        }
        if (target > current) {
            throw new InvalidOperationException("Windows UIPI blocks input to this higher-integrity window in both full-display and bound-window modes. Ask the user to operate this window directly. Do not retry or use another input method.");
        }
    }

    public static void RequireForeground() { RequireWindow(GetForegroundWindow()); }
    public static void RequireAtCursor() {
        Point point;
        if (!GetCursorPos(out point)) throw new InvalidOperationException("Could not read cursor position before Windows input.");
        RequireWindow(WindowFromPoint(point));
    }
}
'@
`

export type IntegrityLevel = 'low' | 'medium' | 'high' | 'system' | 'unknown'

export interface ElevationStatus {
  /** Current process integrity level */
  currentIL: IntegrityLevel
  /** Whether running as Administrator (High IL or above) */
  isAdmin: boolean
  /** Whether UAC is enabled on the system */
  uacEnabled: boolean
}

export interface WindowILCheck {
  /** Target window integrity level */
  il: IntegrityLevel
  /** Whether we can SendMessage to this window */
  canSendMessages: boolean
  /** Reason if blocked */
  blockedReason?: string
}

const IL_ORDER: Record<IntegrityLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  system: 3,
  unknown: -1,
}

export function needsElevatedHelper(current: IntegrityLevel, target: IntegrityLevel): boolean {
  return current !== 'unknown' && target !== 'unknown' && IL_ORDER[target] > IL_ORDER[current]
}

export function getForegroundProcessId(): number | null {
  const result = runPs(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CuForegroundPid {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
}
'@
$targetPid = [uint32]0
[CuForegroundPid]::GetWindowThreadProcessId([CuForegroundPid]::GetForegroundWindow(), [ref]$targetPid) | Out-Null
if ($targetPid -ne 0) { $targetPid }
`)
  const pid = Number(result.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

// Cache results — process IL doesn't change during runtime
let cachedIL: IntegrityLevel | undefined
let cachedElevationStatus: ElevationStatus | undefined

function runPs(script: string): string {
  try {
    return runPowerShellSync(script, 8000)
  } catch {
    return ''
  }
}

/**
 * Detect the integrity level of the current process.
 * Uses OpenProcessToken → GetTokenInformation(TokenIntegrityLevel).
 * Result is cached — process IL cannot change at runtime.
 */
export function getCurrentProcessIL(): IntegrityLevel {
  if (cachedIL !== undefined) return cachedIL
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ILCheck {
    [DllImport("advapi32.dll", SetLastError=true)]
    public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
    [DllImport("advapi32.dll", SetLastError=true)]
    public static extern bool GetTokenInformation(IntPtr TokenHandle, uint TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength, out uint ReturnLength);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);
    public const uint TOKEN_QUERY = 0x0008;
    public const uint TokenIntegrityLevel = 25;

    public static string GetIL() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) return "unknown";
        try {
            uint size;
            GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out size);
            IntPtr buf = Marshal.AllocHGlobal((int)size);
            try {
                if (!GetTokenInformation(token, TokenIntegrityLevel, buf, size, out size)) return "unknown";
                int sidLen = (int)size - Marshal.SizeOf(typeof(uint));
                IntPtr sidPtr = buf + Marshal.SizeOf(typeof(uint));
                byte[] sid = new byte[sidLen];
                Marshal.Copy(sidPtr, sid, 0, sidLen);
                uint rid = (uint)(sid[sid.Length-1] << 24 | sid[sid.Length-2] << 16 | sid[sid.Length-3] << 8 | sid[sid.Length-4]);
                if (rid == 0x00001000) return "low";
                if (rid == 0x00002000) return "medium";
                if (rid == 0x00003000) return "high";
                if (rid == 0x00004000) return "system";
                return "medium";
            } finally { Marshal.FreeHGlobal(buf); }
        } finally { CloseHandle(token); }
    }
}
'@
[ILCheck]::GetIL()
`
  const result = runPs(script)
  const il = result.toLowerCase().trim()
  if (il === 'low' || il === 'medium' || il === 'high' || il === 'system') {
    cachedIL = il as IntegrityLevel
    return cachedIL
  }
  cachedIL = 'unknown'
  return cachedIL
}

/**
 * Get the integrity level of a process by PID.
 */
export function getProcessIL(pid: number): IntegrityLevel {
  // Validate PID is a positive integer
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'unknown'
  }
  const script = `
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class ProcIL {
    [DllImport("advapi32.dll", SetLastError=true)]
    public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
    [DllImport("advapi32.dll", SetLastError=true)]
    public static extern bool GetTokenInformation(IntPtr TokenHandle, uint TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength, out uint ReturnLength);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);
    public const uint TOKEN_QUERY = 0x0008;
    public const uint TokenIntegrityLevel = 25;
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    public static string GetIL(int pid) {
        IntPtr proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (proc == IntPtr.Zero) return "unknown";
        try {
            IntPtr token;
            if (!OpenProcessToken(proc, TOKEN_QUERY, out token)) return "unknown";
            try {
                uint size;
                GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out size);
                IntPtr buf = Marshal.AllocHGlobal((int)size);
                try {
                    if (!GetTokenInformation(token, TokenIntegrityLevel, buf, size, out size)) return "unknown";
                    int sidLen = (int)size - Marshal.SizeOf(typeof(uint));
                    IntPtr sidPtr = buf + Marshal.SizeOf(typeof(uint));
                    byte[] sid = new byte[sidLen];
                    Marshal.Copy(sidPtr, sid, 0, sidLen);
                    uint rid = (uint)(sid[sid.Length-1] << 24 | sid[sid.Length-2] << 16 | sid[sid.Length-3] << 8 | sid[sid.Length-4]);
                    if (rid == 0x00001000) return "low";
                    if (rid == 0x00002000) return "medium";
                    if (rid == 0x00003000) return "high";
                    if (rid == 0x00004000) return "system";
                    return "medium";
                } finally { Marshal.FreeHGlobal(buf); }
            } finally { CloseHandle(token); }
        } finally { CloseHandle(proc); }
    }
}
'@
[ProcIL]::GetIL(${pid})
`
  const result = runPs(script)
  const il = result.toLowerCase().trim()
  if (il === 'low' || il === 'medium' || il === 'high' || il === 'system') {
    return il as IntegrityLevel
  }
  return 'unknown'
}

/**
 * Get full elevation status for the current process.
 * Result is cached — process IL and UAC state don't change at runtime.
 */
export function getElevationStatus(): ElevationStatus {
  if (cachedElevationStatus) return cachedElevationStatus
  const currentIL = getCurrentProcessIL()
  const isAdmin = IL_ORDER[currentIL] >= IL_ORDER['high']

  // Check UAC status
  const uacScript = `
try {
  $val = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name 'EnableLUA' -ErrorAction SilentlyContinue
  if ($val -and $val.EnableLUA -eq 1) { 'true' } else { 'false' }
} catch { 'unknown' }
`
  const uacResult = runPs(uacScript)
  const uacEnabled = uacResult === 'true'

  cachedElevationStatus = { currentIL, isAdmin, uacEnabled }
  return cachedElevationStatus
}

/**
 * Check if we can interact with a specific window via SendMessage.
 */
export function checkWindowAccess(hwnd: number): WindowILCheck {
  // Validate HWND is a positive integer
  if (!Number.isInteger(hwnd) || hwnd <= 0) {
    return { il: 'unknown', canSendMessages: false, blockedReason: 'Invalid HWND' }
  }
  // Get PID of the target window
  const pidScript = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinPid {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
$pid = [uint32]0
[WinPid]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]$pid) | Out-Null
$pid
`
  const pidStr = runPs(pidScript)
  const pid = Number(pidStr)
  if (!pid) {
    return { il: 'unknown', canSendMessages: false, blockedReason: 'Could not determine window PID' }
  }

  const myStatus = getElevationStatus()
  const targetIL = getProcessIL(pid)

  const myLevel = IL_ORDER[myStatus.currentIL]
  const targetLevel = IL_ORDER[targetIL]

  if (myLevel >= targetLevel) {
    return { il: targetIL, canSendMessages: true }
  }

  return {
    il: targetIL,
    canSendMessages: false,
    blockedReason: `UIPI: current process (${myStatus.currentIL}) cannot send to window (${targetIL}). Run as Administrator.`,
  }
}

/**
 * Test if SendMessage actually works by sending a harmless WM_NULL message.
 * WM_NULL is a no-op message; if it returns nonzero, the message was delivered.
 */
export function testSendMessage(hwnd: number): boolean {
  if (!Number.isInteger(hwnd) || hwnd <= 0) return false
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MsgTest {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    public static extern void SetLastError(uint dwErrCode);
    public static int Probe(IntPtr hwnd) {
        SetLastError(0);
        SendMessage(hwnd, 0, IntPtr.Zero, IntPtr.Zero);
        return Marshal.GetLastWin32Error();
    }
}
'@
[MsgTest]::Probe([IntPtr]${hwnd})
`
  const result = runComputerUsePowerShellSync(script, 8000)
  if (result === '') {
    throw new Error('WM_NULL probe returned no result; message accessibility is unknown.')
  }
  const error = Number(result)
  if (error === 0) return true
  if (error === 5) return false
  throw new Error(`WM_NULL probe failed with Win32 error ${error}; message accessibility is unknown.`)
}

/**
 * Generate elevation guidance message for the user.
 */
export function getElevationGuidance(status: ElevationStatus): string {
  if (status.isAdmin) {
    return 'Already running as Administrator. Full Computer Use access granted.'
  }

  const lines = [
    'Computer Use on Windows requires elevated permissions.',
    `Current integrity level: ${status.currentIL}`,
    'To enable full functionality:',
    '',
    '  Option 1: Right-click terminal → "Run as Administrator"',
    '  Option 2: Run: Start-Process powershell -Verb RunAs',
    '',
    'Without elevation, some windows may be unreachable (UIPI restriction).',
  ]

  return lines.join('\n')
}

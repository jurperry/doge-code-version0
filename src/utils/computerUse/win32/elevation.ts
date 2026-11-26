/**
 * Windows process elevation and integrity level detection.
 *
 * Provides utilities to:
 * - Detect current process integrity level (IL)
 * - Test whether SendMessage can reach a given HWND
 *
 * UIPI (User Interface Privilege Isolation) blocks SendMessage/PostMessage
 * from lower-IL processes to higher-IL windows. This module detects such
 * mismatches and recommends elevation when needed.
 */

import { processIntegrityRid } from './nativeWindows.js'
import { runComputerUsePowerShell } from './elevatedPowerShell.js'

export const INPUT_INTEGRITY_TYPES = `
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CuInputIntegrity {
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, out int value, int size, IntPtr needed);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }

    static int Integrity(IntPtr process) {
        IntPtr token;
        if (!OpenProcessToken(process, 0x0008, out token)) return Marshal.GetLastWin32Error() == 5 ? -2 : -1;
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

    public static int Current() { return Integrity(GetCurrentProcess()); }

    public static int ForProcess(uint pid) {
        IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) return -1;
        try { return Integrity(process); } finally { CloseHandle(process); }
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
        int target = ForProcess(pid);
        int current = Current();
        if (current < 0 || target < 0) {
            throw new InvalidOperationException("Could not verify the Windows input target's integrity level. Ask the user to operate this window directly.");
        }
        if (target > current) {
            throw new InvalidOperationException("Windows UIPI blocks input to this higher-integrity window in both full-display and bound-window modes. Ask the user to operate this window directly. Do not retry or use another input method.");
        }
    }

    public static void RequireForeground() { RequireWindow(GetForegroundWindow()); }
    public static void RequireAtCursor() { RequireAtCursor(IntPtr.Zero); }
    public static void RequireAtCursor(IntPtr expectedRoot) { RequireAtCursor(expectedRoot, 0); }
    public static void RequireAtCursor(IntPtr expectedRoot, uint expectedPid) {
        Point point;
        if (!GetCursorPos(out point)) throw new InvalidOperationException("Could not read cursor position before Windows input.");
        IntPtr hit = WindowFromPoint(point);
        uint pid;
        if (expectedPid != 0 && (GetWindowThreadProcessId(hit, out pid) == 0 || pid != expectedPid)) {
            throw new InvalidOperationException("The authorized window at these coordinates changed. Take a fresh screenshot. No click was sent at this point.");
        }
        if (expectedRoot != IntPtr.Zero && GetAncestor(hit, 2) != expectedRoot) { // GA_ROOT
            throw new InvalidOperationException("The point is covered by another window or is outside the bound window. Take a fresh screenshot. No click was sent at this point.");
        }
        RequireWindow(hit);
    }
}
'@
`

export type IntegrityLevel = 'low' | 'medium' | 'high' | 'system' | 'restricted' | 'unknown'

export function needsElevatedHelper(current: IntegrityLevel, target: IntegrityLevel): boolean {
  return (current === 'low' || current === 'medium') && (target === 'high' || target === 'restricted')
}

export function needsElevatedInputHelper(current: IntegrityLevel, target: IntegrityLevel, foreground: IntegrityLevel): boolean {
  return needsElevatedHelper(current, target) || needsElevatedHelper(current, foreground)
}

let cachedIL: IntegrityLevel | undefined

export function parseIntegrityLevel(value: string): IntegrityLevel {
  if (!/^-?\d+$/.test(value)) return 'unknown'
  const rid = Number(value)
  if (rid === -2) return 'restricted'
  if (rid < 0 || rid >= 0x5000) return 'unknown'
  if (rid >= 0x4000) return 'system'
  if (rid >= 0x3000) return 'high'
  if (rid >= 0x2000) return 'medium'
  return 'low'
}

export function getCurrentProcessIL(): IntegrityLevel {
  if (cachedIL !== undefined) return cachedIL
  const integrity = getProcessIL(process.pid)
  if (integrity !== 'unknown' && integrity !== 'restricted') cachedIL = integrity
  return integrity
}

export function getProcessIL(pid: number): IntegrityLevel {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) return 'unknown'
  return parseIntegrityLevel(String(processIntegrityRid(pid)))
}

// WM_NULL probes delivery only. Every action still checks the live input target.
export async function testSendMessage(hwnd: number): Promise<boolean> {
  if (!Number.isInteger(hwnd) || hwnd <= 0) return false
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MsgTest {
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", SetLastError=true)]
    static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("kernel32.dll")]
    public static extern void SetLastError(uint dwErrCode);
    public static int Probe(IntPtr hwnd) {
        SetLastError(0);
        IntPtr result;
        if (SendMessageTimeout(hwnd, 0, IntPtr.Zero, IntPtr.Zero, 0x23, 750, out result) != IntPtr.Zero) return 0;
        int error = Marshal.GetLastWin32Error();
        return error == 0 ? 1460 : error;
    }
}
'@
[MsgTest]::Probe([IntPtr]${hwnd})
`
  const result = await runComputerUsePowerShell(script, 3000)
  if (result === '') {
    throw new Error('WM_NULL probe returned no result; message accessibility is unknown.')
  }
  const error = Number(result)
  if (error === 0) return true
  if (error === 5) return false
  throw new Error(`WM_NULL probe failed with Win32 error ${error}; message accessibility is unknown.`)
}

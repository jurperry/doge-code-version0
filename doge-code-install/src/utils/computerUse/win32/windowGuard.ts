/**
 * Input-precondition guard for the bound HWND (Windows Computer Use).
 *
 * 输入动作分两类传输：
 *  - SendMessage（HWND 绑定，后台安全）→ 仅需存活检查；窗口被关闭后
 *    SendMessage 静默无效，必须先验证 IsWindow。
 *  - 真实输入（Chromium 等窗口使用的 SetCursorPos+mouse_event /
 *    keybd_event）→ 事件注入系统输入流，会落进**当前前台窗口**；目标
 *    不在前台时等于往别的应用里点击/打字。
 *
 * 输入前通过 FFI 快速检查，在实际派发的进程中复查身份与焦点。
 * 只有显式激活窗口才尝试恢复和置前。
 */

import { ensureElevatedPowerShell, runComputerUsePowerShellSync as runPowerShellSync, runElevatedPowerShell } from './elevatedPowerShell.js'
import { getCurrentProcessIL, getProcessIL, needsElevatedHelper } from './elevation.js'
import { runPowerShell } from './powerShell.js'
import { foregroundWindow, isWindowForeground, isWindowMinimized, windowProcessId, windowText } from './nativeWindows.js'

// ── C# P/Invoke helper ──────────────────────────────────────────────────────

const GUARD_TYPES = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CuGuard {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    public const uint GA_ROOT = 2;

    public static bool IsFg(IntPtr target) {
        IntPtr fg = GetForegroundWindow();
        return fg == target || GetAncestor(fg, GA_ROOT) == target;
    }
    public static string FgTitle() {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return "";
        var sb = new StringBuilder(256);
        GetWindowText(fg, sb, sb.Capacity);
        return sb.ToString();
    }
    public static bool TryForeground(IntPtr target) {
        if (IsFg(target) || SetForegroundWindow(target)) return true;
        // SetForegroundWindow is refused unless the caller is/recently was the
        // foreground process. Attaching to the current foreground thread's
        // input queue makes us eligible — the classic workaround (pywinauto /
        // AutoHotkey use the same trick).
        uint dummy;
        IntPtr fg = GetForegroundWindow();
        uint fgTid = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out dummy);
        uint ourTid = GetCurrentThreadId();
        bool attached = false;
        if (fgTid != 0 && fgTid != ourTid) {
            attached = AttachThreadInput(ourTid, fgTid, true);
        }
        try {
            SetForegroundWindow(target);
        } finally {
            if (attached) AttachThreadInput(ourTid, fgTid, false);
        }
        return IsFg(target);
    }
}
'@
`

// ── Result types ────────────────────────────────────────────────────────────

export type EnsureWindowResult =
  | { status: 'ok' }
  | { status: 'dead' }
  | { status: 'identity_mismatch'; actualPid: number | null }
  | { status: 'not_foreground'; foregroundTitle: string | null }

// ── Script builders ─────────────────────────────────────────────────────────

export function buildEnsureWindowScript(
  hwnd: number,
  needForeground: boolean,
  expectedPid?: number,
): string {
  const fgBlock = needForeground
    ? `
if ([CuGuard]::IsIconic([IntPtr]${hwnd})) {
    [CuGuard]::ShowWindowAsync([IntPtr]${hwnd}, 9) | Out-Null
    Start-Sleep -Milliseconds 250
}
\$ok = \$false
for (\$i = 0; \$i -lt 3 -and -not \$ok; \$i++) {
    ${expectedPid === undefined ? '' : `
    [CuGuard]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]\$currentPid) | Out-Null
    if (\$currentPid -ne ${expectedPid}) { 'PIDMISMATCH|' + \$currentPid; return }
    `}
    \$ok = [CuGuard]::TryForeground([IntPtr]${hwnd})
    Start-Sleep -Milliseconds 100
    \$ok = [CuGuard]::IsFg([IntPtr]${hwnd}) -and -not [CuGuard]::IsIconic([IntPtr]${hwnd})
}
if (\$ok) { 'OK' } else { 'NOFG|' + [CuGuard]::FgTitle() }
`
    : `'OK'
`
  const identityBlock = expectedPid === undefined ? fgBlock : `
\$currentPid = [uint32]0
[CuGuard]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]\$currentPid) | Out-Null
if (\$currentPid -ne ${expectedPid}) { 'PIDMISMATCH|' + \$currentPid } else {
${fgBlock}}
`
  return `${GUARD_TYPES}
if (-not [CuGuard]::IsWindow([IntPtr]${hwnd})) { 'DEAD' } else {
${identityBlock}}
`
}

export function buildRequireWindowScript(hwnd: number, expectedPid?: number): string {
  const pidCheck = expectedPid === undefined ? '' : `
\$currentPid = [uint32]0
[CuGuard]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]\$currentPid) | Out-Null
if (\$currentPid -ne ${expectedPid}) { throw 'Window identity changed (PID ' + \$currentPid + ')' }
`
  return `${GUARD_TYPES}
if (-not [CuGuard]::IsWindow([IntPtr]${hwnd})) { throw 'Target window no longer exists' }
${pidCheck}
if ([CuGuard]::IsIconic([IntPtr]${hwnd}) -or -not [CuGuard]::IsFg([IntPtr]${hwnd})) {
    throw 'The bound window is no longer in the foreground. No input was sent. Use activate_window with screenshot: true.'
}
`
}

/** Parse the ensure-window PowerShell output. Pure — unit-testable. */
export function parseEnsureOutput(raw: string): EnsureWindowResult {
  const trimmed = raw.trim()
  if (!trimmed) return { status: 'dead' }
  const firstLine = trimmed.split('\n')[0].trim()
  if (firstLine === 'DEAD') return { status: 'dead' }
  if (firstLine === 'OK') return { status: 'ok' }
  if (firstLine.startsWith('PIDMISMATCH|')) {
    const rawPid = firstLine.slice('PIDMISMATCH|'.length).trim()
    const actualPid = Number(rawPid)
    return { status: 'identity_mismatch', actualPid: Number.isFinite(actualPid) ? actualPid : null }
  }
  if (firstLine.startsWith('NOFG|')) {
    const title = firstLine.slice('NOFG|'.length).trim()
    return { status: 'not_foreground', foregroundTitle: title || null }
  }
  // Unrecognized output (PowerShell error text etc.) — treat as dead so the
  // caller surfaces an error instead of sending input blind.
  return { status: 'dead' }
}

// ── Guard entry point ───────────────────────────────────────────────────────

/** Foreground the observed window in the same integrity context used for its input. */
export async function activateObservedWindow(hwnd: number, pid: number, signal?: AbortSignal): Promise<boolean> {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || !Number.isSafeInteger(pid) || pid <= 0) return false
  signal?.throwIfAborted()
  if (windowProcessId(hwnd) !== pid) return false
  if (isWindowForeground(hwnd) && !isWindowMinimized(hwnd)) return true
  const elevated = needsElevatedHelper(getCurrentProcessIL(), getProcessIL(pid))
  if (elevated) await ensureElevatedPowerShell(signal)
  signal?.throwIfAborted()
  if (windowProcessId(hwnd) !== pid) return false
  const run = elevated ? runElevatedPowerShell : runPowerShell
  const result = await run(buildEnsureWindowScript(hwnd, true, pid), 4000, undefined, signal)
  return parseEnsureOutput(result).status === 'ok' && windowProcessId(hwnd) === pid && isWindowForeground(hwnd)
}

export function ensureInputWindow(hwnd: number, needForeground: boolean, expectedPid?: number): EnsureWindowResult {
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) return { status: 'dead' }
  const pid = windowProcessId(hwnd)
  if (!pid) return { status: 'dead' }
  if (expectedPid !== undefined && pid !== expectedPid) return { status: 'identity_mismatch', actualPid: pid }
  if (needForeground && (!isWindowForeground(hwnd) || isWindowMinimized(hwnd))) {
    return { status: 'not_foreground', foregroundTitle: windowText(foregroundWindow(), 'title') || null }
  }
  return { status: 'ok' }
}

/** PIDs whose process name equals `name` (case-insensitive, no .exe). */
export function getPidsForProcessName(name: string): number[] {
  const safe = name.replace(/'/g, "''")
  if (!safe.trim()) return []
  try {
    return runPowerShellSync(`Get-Process | Where-Object { $_.ProcessName -eq '${safe}' } | ForEach-Object { $_.Id }`, 8000)
      .split('\n')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

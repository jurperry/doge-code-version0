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
 * 卫兵链（对齐 zcode computer-use MCP 的 activate 语义：激活后必须验证
 * 前台后置条件，失败即报错，绝不静默降级到后台）：
 *   检查（IsWindow / IsIconic / 前台归属）→ 需要时恢复最小化并激活
 *   （AttachThreadInput 前台锁绕行 + ALT 微扰）→ 再校验 → 通过才放行。
 *
 * 全部走单条 PowerShell（一次进程内完成检查+激活+重试校验），与
 * platforms/win32.ts 其余输入原语同一套 spawnSync 风格。
 */

import { listWindows } from './windowEnum.js'
import { runComputerUsePowerShellSync as runPowerShellSync } from './elevatedPowerShell.js'
import { INPUT_INTEGRITY_TYPES } from './elevation.js'

// ── C# P/Invoke helper ──────────────────────────────────────────────────────

const GUARD_TYPES = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CuGuard {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    public const uint GA_ROOT = 2;
    public const byte VK_MENU = 0x12;
    public const uint KEYEVENTF_KEYUP = 0x2;

    // Foreground comparison is root-owner based: clicking a child/owned window
    // (e.g. a dialog of the target app) still counts as the target being front.
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
        if (IsFg(target)) return true;
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
            BringWindowToTop(target);
            SetForegroundWindow(target);
        } finally {
            if (attached) AttachThreadInput(ourTid, fgTid, false);
        }
        return IsFg(target);
    }
    public static void AltNudge() {
        // Bare ALT press/release unlocks the foreground lock for the next
        // SetForegroundWindow (Windows treats it as user input). Last resort
        // only — fires on the final retry below.
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
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
  forInput = false,
): string {
  const fgBlock = needForeground
    ? `
if ([CuGuard]::IsIconic([IntPtr]${hwnd})) {
    [CuGuard]::ShowWindow([IntPtr]${hwnd}, 9) | Out-Null
    Start-Sleep -Milliseconds 250
}
\$ok = \$false
for (\$i = 0; \$i -lt 3 -and -not \$ok; \$i++) {
    \$ok = [CuGuard]::TryForeground([IntPtr]${hwnd})
    if (-not \$ok) {
        if (\$i -eq 1) { [CuGuard]::AltNudge() }
        Start-Sleep -Milliseconds 200
    }
}
if (\$ok) { 'OK' } else { 'NOFG|' + [CuGuard]::FgTitle() }
`
    : `'OK'
`
  const guarded = forInput ? `[CuInputIntegrity]::RequireWindow([IntPtr]${hwnd})\n${fgBlock}` : fgBlock
  const identityBlock = expectedPid === undefined ? guarded : `
\$currentPid = [uint32]0
[CuGuard]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]\$currentPid) | Out-Null
if (\$currentPid -ne ${expectedPid}) { 'PIDMISMATCH|' + \$currentPid } else {
${guarded}}
`
  return `${forInput ? INPUT_INTEGRITY_TYPES : ''}${GUARD_TYPES}
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
if ([CuGuard]::IsIconic([IntPtr]${hwnd})) {
    [CuGuard]::ShowWindow([IntPtr]${hwnd}, 9) | Out-Null
    Start-Sleep -Milliseconds 250
}
\$ok = \$false
for (\$i = 0; \$i -lt 3 -and -not \$ok; \$i++) {
    \$ok = [CuGuard]::TryForeground([IntPtr]${hwnd})
    if (-not \$ok) {
        if (\$i -eq 1) { [CuGuard]::AltNudge() }
        Start-Sleep -Milliseconds 200
    }
}
if (-not \$ok) { throw 'Could not foreground the target window: ' + [CuGuard]::FgTitle() }
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

/**
 * Check (and when `needForeground`, activate + re-verify) a window in a single
 * PowerShell invocation. Returns the status; the caller decides the error.
 */
export function ensureWindow(
  hwnd: number,
  needForeground: boolean,
  expectedPid?: number,
  forInput = false,
): EnsureWindowResult {
  if (!Number.isInteger(hwnd) || hwnd <= 0) return { status: 'dead' }
  try {
    return parseEnsureOutput(runPowerShellSync(buildEnsureWindowScript(hwnd, needForeground, expectedPid, forInput), 10000))
  } catch (error) {
    if (forInput) throw error
    return { status: 'dead' }
  }
}

// ── Replacement-window lookup (window died → app may have another window) ──

/**
 * Find a live replacement window for a dead binding: same PID first, then any
 * window whose process name matches the bound executable's base name. Used to
 * survive an app closing one window and opening another (new document, dialog
 * teardown) without forcing the model to re-open the whole app.
 */
export function findReplacementWindow(
  pid: number | null,
  exeBase: string | null,
): { hwnd: number; pid: number } | null {
  const windows = listWindows()
  if (windows.length === 0) return null
  if (pid != null && pid > 0) {
    const byPid = windows.find(w => w.pid === pid)
    if (byPid) return { hwnd: byPid.hwnd, pid: byPid.pid }
  }
  if (exeBase) {
    const pids = getPidsForProcessName(exeBase)
    if (pids.length > 0) {
      const byProc = windows.find(w => pids.includes(w.pid))
      if (byProc) return { hwnd: byProc.hwnd, pid: byProc.pid }
    }
  }
  return null
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

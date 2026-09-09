/**
 * Windows platform backend for Computer Use.
 *
 * Combines:
 * - PowerShell SetCursorPos/mouse_event for global input (fallback)
 * - win32/windowMessage.ts for window-bound SendMessage input (preferred)
 * - win32/windowCapture.ts for PrintWindow screenshots
 * - win32/windowEnum.ts for EnumWindows app listing
 * - PowerShell CopyFromScreen for full-screen/region screenshots
 * - PowerShell Screen.AllScreens for display enumeration
 *
 * CRITICAL: All screenshots output JPEG (ImageFormat::Jpeg), not PNG.
 */

import type { Platform } from './index.js'
import type {
  InputPlatform,
  ScreenshotPlatform,
  DisplayPlatform,
  AppsPlatform,
  WindowHandle,
  ScreenshotResult,
  DisplayInfo,
  InstalledApp,
  FrontmostAppInfo,
} from './types.js'
import { listWindows } from '../win32/windowEnum.js'
import { captureWindowByHwnd } from '../win32/windowCapture.js'
import { detectAppType, openWithController } from '../win32/appDispatcher.js'
import { markBound, unmarkBound } from '../win32/windowBorder.js'
import {
  ensureWindow,
  findReplacementWindow,
  getPidsForProcessName,
} from '../win32/windowGuard.js'
import { listInstalledAppsWin32 } from '../win32/installedApps.js'
import { classifyWindowClasses } from '../win32/windowClassify.js'

// ---------------------------------------------------------------------------
// Screenshot cache for zoom — avoids re-capturing via PrintWindow on every zoom
// ---------------------------------------------------------------------------
let cachedScreenshot: { base64: string; width: number; height: number; ts: number } | null = null
const SCREENSHOT_CACHE_TTL = 500 // ms — reuse cached capture for zoom within this window

/**
 * Crop a region from a cached screenshot using in-memory JPEG decode + crop.
 * Returns the cropped region as a new ScreenshotResult.
 */
function cropScreenshot(
  cache: { base64: string; width: number; height: number },
  rx: number, ry: number, rw: number, rh: number,
): ScreenshotResult {
  // Clamp crop region to source bounds
  const cx = Math.max(0, Math.min(Math.round(rx), cache.width))
  const cy = Math.max(0, Math.min(Math.round(ry), cache.height))
  const cw = Math.min(Math.round(rw), cache.width - cx)
  const ch = Math.min(Math.round(rh), cache.height - cy)
  if (cw <= 0 || ch <= 0) {
    return { base64: cache.base64, width: cache.width, height: cache.height }
  }
  // Use PowerShell to crop — avoids native image dependency
  const tmpIn = `${process.env.TEMP || '/tmp'}/cu_crop_in_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
  const tmpOut = `${process.env.TEMP || '/tmp'}/cu_crop_out_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
  try {
    const fs = require('fs')
    const inBuf = Buffer.from(cache.base64, 'base64')
    fs.writeFileSync(tmpIn.replace(/\\\\/g, '\\'), inBuf)
    // Use .NET System.Drawing to crop (fast, no external deps)
    ps(`
${DPI_AWARE_PS}
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${tmpIn}')
$crop = New-Object System.Drawing.Bitmap(${cw}, ${ch})
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($src, [System.Drawing.Rectangle]::new(0, 0, ${cw}, ${ch}), [System.Drawing.Rectangle]::new(${cx}, ${cy}, ${cw}, ${ch}), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$crop.Save('${tmpOut}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$crop.Dispose()
$src.Dispose()
`)
    const outBuf = fs.readFileSync(tmpOut.replace(/\\\\/g, '\\'))
    return { base64: outBuf.toString('base64'), width: cw, height: ch }
  } catch {
    // Crop failed — return full screenshot
    return { base64: cache.base64, width: cache.width, height: cache.height }
  } finally {
    try { require('fs').unlinkSync(tmpIn.replace(/\\\\/g, '\\')) } catch {}
    try { require('fs').unlinkSync(tmpOut.replace(/\\\\/g, '\\')) } catch {}
  }
}

// ---------------------------------------------------------------------------
// PowerShell helpers
// ---------------------------------------------------------------------------

function ps(script: string): string {
  const result = Bun.spawnSync({
    cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
    stdout: 'pipe',
    stderr: 'pipe',
    timeoutMs: 10000,
  })
  return new TextDecoder().decode(result.stdout).trim()
}

async function psAsync(script: string): Promise<string> {
  const proc = Bun.spawn(
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  // Timeout guard: kill PowerShell if it hangs
  const timer = setTimeout(() => { try { proc.kill() } catch {} }, 15000)
  try {
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out.trim()
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Win32 P/Invoke types (compiled once per PS session)
// ---------------------------------------------------------------------------

const WIN32_TYPES = `
Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;

public class CuWin32 {
    // --- Cursor ---
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    // --- SendInput (kept for potential future use, but mouse operations use mouse_event instead) ---
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
        public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)] public struct INPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(4)] public MOUSEINPUT mi;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)] public struct KINPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(4)] public KEYBDINPUT ki;
    }
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] i, int cb);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, KINPUT[] i, int cb);

    // --- DPI Awareness ---
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    // --- Keyboard ---
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);

    // --- mouse_event (simple parameters, no struct issues in PowerShell) ---
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, IntPtr dwExtraInfo);

    // --- Window ---
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);

    // Constants
    public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint KEYEVENTF_KEYUP = 0x0002;
}
'@
`

// Prefix to make each PowerShell invocation DPI-aware so GetWindowRect,
// Screen.Bounds, CopyFromScreen, and SetCursorPos all use physical pixels.
const DPI_AWARE_PS = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[CuDpi]::SetProcessDPIAware() | Out-Null
`

// ---------------------------------------------------------------------------
// Virtual key code mapping
// ---------------------------------------------------------------------------

const VK_MAP: Record<string, number> = {
  return: 0x0D, enter: 0x0D, tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2E, escape: 0x1B, esc: 0x1B,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
  shift: 0xA0, lshift: 0xA0, rshift: 0xA1,
  control: 0xA2, ctrl: 0xA2, lcontrol: 0xA2, rcontrol: 0xA3,
  alt: 0xA4, option: 0xA4, lalt: 0xA4, ralt: 0xA5,
  win: 0x5B, meta: 0x5B, command: 0x5B, cmd: 0x5B, super: 0x5B,
  insert: 0x2D, printscreen: 0x2C, pause: 0x13,
  numlock: 0x90, capslock: 0x14, scrolllock: 0x91,
}

const MODIFIER_KEYS = new Set([
  'shift', 'lshift', 'rshift', 'control', 'ctrl', 'lcontrol', 'rcontrol',
  'alt', 'option', 'lalt', 'ralt', 'win', 'meta', 'command', 'cmd', 'super',
])

// ---------------------------------------------------------------------------
// Session-level HWND binding — all operations target this handle
// ---------------------------------------------------------------------------

let boundHwnd: number | null = null
let boundPid: number | null = null
let boundAppType: import('../win32/appDispatcher.js').AppType | null = null
let boundFilePath: string | null = null
/** Executable base name (no .exe) of the bound window's process — used to find
 *  a replacement window when the bound HWND dies (app closed that window). */
let boundExeBase: string | null = null
/** Track whether SendMessage is working for the bound window (UIPI check) */
let sendMessageOk: boolean | null = null
/** Track whether the bound window is Chromium-based (Electron/CEF/Chrome).
 *  Chromium apps ignore SendMessage mouse events — must use SetCursorPos + mouse_event instead. */
let isChromium: boolean = false
/** Bound window belongs to a self-drawn framework (Qt/SDL/GLFW/Unity/AWT —
 *  e.g. the Android emulator). SendMessage mouse AND keyboard are app-layer
 *  no-ops for these; everything must go through real input (foreground guard). */
let isSelfDrawn: boolean = false
/** Class that triggered the framework classification — diagnostics. */
let boundFrameworkClass: string | null = null
/** Last passing guard probe (500ms micro-cache for batch actions). */
let lastGuard: { hwnd: number; ok: boolean; fg: boolean; ts: number } | null = null

/** Mouse channel for the bound window: real input required? */
function realMouseChannel(): boolean {
  return isChromium || isSelfDrawn
}

/** Get the bound HWND, or null if not bound */
export function getBoundHwnd(): number | null { return boundHwnd }

/** Get the bound app type */
export function getBoundAppType(): string | null { return boundAppType }

/** Get the bound file path (for COM-controlled apps) */
export function getBoundFilePath(): string | null { return boundFilePath }

/** Bind to a window HWND — all subsequent input/screenshot operations target this handle */
export function bindWindow(hwnd: number, pid?: number, exeBase?: string): void {
  // Unmark previous window if any
  if (boundHwnd) unmarkBound(boundHwnd)
  boundHwnd = hwnd
  boundPid = pid ?? null
  boundAppType = 'generic'
  boundFilePath = null
  boundExeBase = exeBase ?? null
  lastGuard = null
  // Reset SendMessage status — will be checked on first operation
  sendMessageOk = null
  // Framework classification (Chromium / self-drawn Qt-family) picks the
  // input channel: SendMessage vs real input.
  const framework = detectWindowFramework(hwnd)
  isChromium = framework.chromium
  isSelfDrawn = framework.selfDrawn
  boundFrameworkClass = framework.matchedClass
  // Invalidate screenshot cache for new window
  cachedScreenshot = null
  // Green border on the bound window
  markBound(hwnd)
}

/** Bind to a COM-controlled file (Excel/Word — no window needed) */
export function bindFile(filePath: string, appType: import('../win32/appDispatcher.js').AppType): void {
  boundHwnd = null
  boundPid = null
  boundAppType = appType
  boundFilePath = filePath
}

/** Unbind — revert to global mode, remove green border */
export function unbindWindow(): void {
  if (boundHwnd) unmarkBound(boundHwnd)
  boundHwnd = null
  boundPid = null
  boundAppType = null
  boundFilePath = null
  boundExeBase = null
  sendMessageOk = null
  isChromium = false
  isSelfDrawn = false
  boundFrameworkClass = null
}

/** Diagnostics for tests/debugging: how the bound window's input is routed. */
export function getBoundInputChannel(): {
  chromium: boolean
  selfDrawn: boolean
  frameworkClass: string | null
  realMouse: boolean
} {
  return {
    chromium: isChromium,
    selfDrawn: isSelfDrawn,
    frameworkClass: boundFrameworkClass,
    realMouse: realMouseChannel(),
  }
}

// ---------------------------------------------------------------------------
// Input guard: 检查 → 未在前台则激活 → 再校验 → 通过才输入 → 否则报错
// ---------------------------------------------------------------------------

/**
 * Pre-input precondition for the bound window. Call before every input that
 * targets `boundHwnd`.
 *
 *  - `needForeground=false`（SendMessage 传输，后台安全）: liveness only —
 *    SendMessage 到已销毁的 HWND 静默无效，必须先验证 IsWindow。
 *  - `needForeground=true`（真实输入传输：Chromium 窗口 / UIPI 回退的
 *    SetCursorPos+mouse_event / keybd_event）: ensureWindow 在单条 PowerShell
 *    里完成 恢复最小化 → AttachThreadInput 激活 → 重试校验；未达前台即抛错，
 *    绝不把点击/按键打进当前前台的错误应用。
 *
 * 窗口已死时先按 PID / 进程名找替身窗口重绑（应用换了窗口而非退出），
 * 找不到才抛错并指引模型重新 open_application。
 */
function guardBoundWindow(needForeground: boolean): void {
  if (!boundHwnd) return
  // Micro-cache: within 500ms of a passing probe for the same HWND, skip the
  // extra PowerShell spawn — computer_batch would otherwise pay ~300ms per
  // action. Tight window: a window closed mid-batch is caught by the next
  // probe after expiry.
  if (
    lastGuard !== null &&
    lastGuard.hwnd === boundHwnd &&
    lastGuard.ok &&
    (lastGuard.fg || !needForeground) &&
    Date.now() - lastGuard.ts < 500
  ) {
    return
  }
  let result = ensureWindow(boundHwnd, needForeground)
  if (result.status === 'dead') {
    const replacement = findReplacementWindow(boundPid, boundExeBase)
    if (replacement) {
      bindWindow(replacement.hwnd, replacement.pid, boundExeBase ?? undefined)
      result = ensureWindow(boundHwnd, needForeground)
    }
  }
  if (result.status === 'ok') {
    lastGuard = {
      hwnd: boundHwnd,
      ok: true,
      fg: needForeground,
      ts: Date.now(),
    }
    return
  }
  lastGuard = null
  if (result.status === 'dead') {
    throw new Error(
      'The target application window no longer exists (the app was closed). ' +
        'No input was sent. Call open_application to relaunch it, then take a ' +
        'screenshot before retrying.',
    )
  }
  throw new Error(
    `Could not bring the target window to the foreground (current foreground: ` +
      `${result.foregroundTitle ?? 'unknown'}). No input was sent to avoid ` +
      'clicking or typing into the wrong application. Take a screenshot to ' +
      'inspect the current screen state, or ask the user to restore the window.',
  )
}

// ---------------------------------------------------------------------------
// UIPI check: test whether SendMessage reaches the bound window
// ---------------------------------------------------------------------------

function checkSendMessageAccess(hwnd: number): boolean {
  try {
    const { testSendMessage } = require('../win32/elevation.js') as typeof import('../win32/elevation.js')
    return testSendMessage(hwnd)
  } catch {
    return false
  }
}

/** Ensure we can SendMessage to the bound window. Returns true if OK, false if UIPI blocked. */
function ensureSendAccess(): boolean {
  if (!boundHwnd) return false
  if (sendMessageOk === null) {
    sendMessageOk = checkSendMessageAccess(boundHwnd)
  }
  return sendMessageOk
}

// ---------------------------------------------------------------------------
// Window-framework detection: Chromium / self-drawn (Qt, SDL, GLFW, …)
// ---------------------------------------------------------------------------

/**
 * Enumerate the top-level + child window class names of an HWND, then
 * classify via windowClassify.ts (pure). One PowerShell invocation.
 *
 *  - chromium  → mouse must go through real input (Electron ignores
 *    SendMessage mouse), keyboard still works via the RenderWidgetHost child.
 *  - selfDrawn → the app renders and consumes input itself (Qt/SDL/GLFW/
 *    Unity/AWT — Android emulator is Qt): BOTH mouse and keyboard SendMessage
 *    paths are no-ops at the app layer even though UIPI lets them through.
 */
function detectWindowFramework(hwnd: number): import('../win32/windowClassify.js').WindowFrameworkInfo {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class CuClasses {
    public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc proc, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public static List<string> classNames = new List<string>();
    public static void Find(IntPtr parent) {
        classNames.Clear();
        StringBuilder top = new StringBuilder(256);
        GetClassName(parent, top, top.Capacity);
        classNames.Add(top.ToString());
        EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam) {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, sb.Capacity);
            classNames.Add(sb.ToString());
            return true;
        }, IntPtr.Zero);
    }
}
'@
[CuClasses]::SetProcessDPIAware() | Out-Null
[CuClasses]::Find([IntPtr]${hwnd})
[CuClasses]::classNames | ForEach-Object { $_ }
`
  const raw = ps(script)
  if (!raw) return { chromium: false, selfDrawn: false, matchedClass: null }
  const classes = raw.split('\n').map(s => s.trim()).filter(Boolean)
  const [top, ...children] = classes
  return classifyWindowClasses(top ?? '', children)
}

// ---------------------------------------------------------------------------
// Window Message module (lazy loaded)
// ---------------------------------------------------------------------------

let _wm: typeof import('../win32/windowMessage.js') | undefined
function getWm() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (_wm ??= require('../win32/windowMessage.js') as typeof import('../win32/windowMessage.js'))
}

// ---------------------------------------------------------------------------
// Input — When HWND is bound, operations go through SendMessage (background,
// no focus steal, no physical cursor move).
// Real input (SetCursorPos + mouse_event / keybd_event) is used when
// SendMessage cannot work at the app layer:
//   - Chromium windows (Electron/CEF) ignore SendMessage mouse events
//   - Self-drawn frameworks (Qt/SDL/GLFW/Unity/AWT — e.g. Android emulator)
//     consume raw input themselves; parent-window SendMessage mouse AND
//     keyboard are app-layer no-ops even when UIPI lets them through
//   - UIPI-blocked windows (elevated target)
// Real input goes to the FOREGROUND window — guardBoundWindow(true) activates
// and verifies the bound window first, or the action fails with an error.
// ---------------------------------------------------------------------------

/**
 * Get window rect origin (left, top) via GetWindowRect with DPI awareness.
 * Returns "left,top" string, or null on failure.
 */
function getWindowOrigin(hwnd: number): { left: number; top: number } | null {
  const script = `
${DPI_AWARE_PS}
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuRect+RECT
[CuRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r) | Out-Null
"\$(\$r.L),\$(\$r.T)"
`
  const raw = ps(script)
  if (!raw) return null
  const parts = raw.split(',')
  if (parts.length !== 2) return null
  return { left: parseInt(parts[0], 10), top: parseInt(parts[1], 10) }
}

/**
 * Click at screen coordinates using mouse_event.
 * Uses SetCursorPos to position the cursor, then mouse_event for the click.
 * mouse_event takes simple parameters (no struct), avoiding PowerShell's
 * mutable-struct trap where $i.mi.dwFlags = value silently writes to a copy.
 */
function sendInputClick(hwnd: number, x: number, y: number, button: 'left' | 'right' | 'middle'): void {
  const downFlag = button === 'left' ? '0x0002' : button === 'right' ? '0x0008' : '0x0020'
  const upFlag = button === 'left' ? '0x0004' : button === 'right' ? '0x0010' : '0x0040'
  const rx = Math.round(x)
  const ry = Math.round(y)
  ps(`${WIN32_TYPES}
[CuWin32]::SetProcessDPIAware() | Out-Null
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuClickRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuClickRect+RECT
[CuClickRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r) | Out-Null
[CuWin32]::SetCursorPos(${rx} + \$r.L, ${ry} + \$r.T) | Out-Null
Start-Sleep -Milliseconds 20
[CuWin32]::mouse_event(${downFlag}, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 50
[CuWin32]::mouse_event(${upFlag}, 0, 0, 0, [IntPtr]::Zero)
`)
}

/**
 * SetCursorPos-based mouse move to screen coordinates.
 * Converts screenshot coords to screen coords using GetWindowRect.
 */
function sendInputMove(hwnd: number, x: number, y: number): void {
  const rx = Math.round(x)
  const ry = Math.round(y)
  ps(`${WIN32_TYPES}
[CuWin32]::SetProcessDPIAware() | Out-Null
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuMoveRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuMoveRect+RECT
[CuMoveRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r) | Out-Null
[CuWin32]::SetCursorPos(${rx} + \$r.L, ${ry} + \$r.T) | Out-Null
`)
}

/**
 * Press or release a mouse button via real input at window-relative coords.
 * Used by drag (down → move → up) — separate phases so the physical button
 * stays held between invocations, unlike sendInputClick.
 */
function sendInputButton(
  hwnd: number,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  phase: 'down' | 'up',
): void {
  const flag =
    phase === 'down'
      ? button === 'left' ? '0x0002' : button === 'right' ? '0x0008' : '0x0020'
      : button === 'left' ? '0x0004' : button === 'right' ? '0x0010' : '0x0040'
  const rx = Math.round(x)
  const ry = Math.round(y)
  ps(`${WIN32_TYPES}
[CuWin32]::SetProcessDPIAware() | Out-Null
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuBtnRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuBtnRect+RECT
[CuBtnRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r) | Out-Null
[CuWin32]::SetCursorPos(${rx} + \$r.L, ${ry} + \$r.T) | Out-Null
Start-Sleep -Milliseconds 20
[CuWin32]::mouse_event(${flag}, 0, 0, 0, [IntPtr]::Zero)
`)
}

/**
 * Full drag via real input in ONE PowerShell invocation: position → press →
 * eased interpolation frames → release. One process for the whole gesture —
 * per-frame PS spawns (the old executor-composed path) cost ~300ms each and
 * broke the gesture's timing; self-drawn apps (Qt emulator) translate the
 * physical button-held movement stream into client touch-drag events.
 * Ease-out cubic, 40 fps, mirroring executor.ts animatedMove.
 */
function sendInputDrag(
  hwnd: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationMs: number,
): void {
  const fx = Math.round(fromX)
  const fy = Math.round(fromY)
  const tx = Math.round(toX)
  const ty = Math.round(toY)
  const frames = Math.max(2, Math.min(40, Math.round(durationMs / 25)))
  const frameMs = Math.max(10, Math.round(durationMs / frames))
  // Interpolation is computed PowerShell-side (single process).
  ps(`${WIN32_TYPES}
[CuWin32]::SetProcessDPIAware() | Out-Null
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuDragRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuDragRect+RECT
[CuDragRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r) | Out-Null
\$ox = \$r.L
\$oy = \$r.T
[CuWin32]::SetCursorPos(${fx} + \$ox, ${fy} + \$oy) | Out-Null
Start-Sleep -Milliseconds 40
[CuWin32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
\$frames = ${frames}
for (\$i = 1; \$i -le \$frames; \$i++) {
    \$t = \$i / \$frames
    \$eased = 1 - [math]::Pow(1 - \$t, 3)
    \$x = [math]::Round(${fx} + (${tx} - ${fx}) * \$eased) + \$ox
    \$y = [math]::Round(${fy} + (${ty} - ${fy}) * \$eased) + \$oy
    [CuWin32]::SetCursorPos(\$x, \$y) | Out-Null
    Start-Sleep -Milliseconds ${frameMs}
}
[CuWin32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
`)
}

const input: InputPlatform = {
  async moveMouse(x, y) {
    if (boundHwnd) {
      // Pure positioning — no click. Liveness only (dead binding must error
      // instead of silently no-op'ing); a physical cursor move is harmless.
      guardBoundWindow(false)
      if (realMouseChannel()) {
        // Chromium / self-drawn windows ignore SendMessage mouse — move the
        // physical cursor instead.
        sendInputMove(boundHwnd, x, y)
      } else if (ensureSendAccess()) {
        getWm().sendMouseMove(boundHwnd, Math.round(x), Math.round(y))
      }
      // UIPI blocked non-Chromium — no global fallback for pure mouse move (no click involved)
      return
    }
    ps(`${WIN32_TYPES}; [CuWin32]::SetProcessDPIAware() | Out-Null; [CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`)
  },

  async click(x, y, button) {
    if (boundHwnd) {
      // Chromium / self-drawn / UIPI-blocked windows go through real (global)
      // input — the bound window MUST be foreground or the click lands on
      // whatever the user has in front.
      const realInput = realMouseChannel() || !ensureSendAccess()
      guardBoundWindow(realInput)
      if (realInput) {
        sendInputClick(boundHwnd, x, y, button)
        return
      }
      getWm().sendClick(boundHwnd, Math.round(x), Math.round(y), button)
      return
    }
    const downFlag = button === 'left' ? '0x0002' : button === 'right' ? '0x0008' : '0x0020'
    const upFlag = button === 'left' ? '0x0004' : button === 'right' ? '0x0010' : '0x0040'
    ps(`${WIN32_TYPES}; [CuWin32]::SetProcessDPIAware() | Out-Null; [CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null; Start-Sleep -Milliseconds 20; [CuWin32]::mouse_event(${downFlag}, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 50; [CuWin32]::mouse_event(${upFlag}, 0, 0, 0, [IntPtr]::Zero)`)
  },

  async mouseDown(x, y) {
    if (!boundHwnd) throw new Error('mouseDown requires a bound window HWND. Call open() first.')
    const realInput = realMouseChannel() || !ensureSendAccess()
    guardBoundWindow(realInput)
    if (realInput) {
      sendInputButton(boundHwnd, x, y, 'left', 'down')
      return
    }
    getWm().sendMouseButton(boundHwnd, Math.round(x), Math.round(y), 'left', 'down')
  },

  async mouseUp(x, y) {
    if (!boundHwnd) throw new Error('mouseUp requires a bound window HWND. Call open() first.')
    const realInput = realMouseChannel() || !ensureSendAccess()
    guardBoundWindow(realInput)
    if (realInput) {
      sendInputButton(boundHwnd, x, y, 'left', 'up')
      return
    }
    getWm().sendMouseButton(boundHwnd, Math.round(x), Math.round(y), 'left', 'up')
  },

  async drag(from, to, durationMs) {
    if (!boundHwnd) throw new Error('drag requires a bound window HWND. Call open() first.')
    const realInput = realMouseChannel() || !ensureSendAccess()
    guardBoundWindow(realInput)
    if (realInput) {
      sendInputDrag(boundHwnd, from.x, from.y, to.x, to.y, durationMs)
      return
    }
    getWm().sendDrag(boundHwnd, Math.round(from.x), Math.round(from.y), Math.round(to.x), Math.round(to.y), durationMs)
  },

  async typeText(text) {
    // COM-controlled apps: write directly via COM API
    if (boundAppType === 'word' && boundFilePath) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { appendText } = require('../win32/comWord.js') as typeof import('../win32/comWord.js')
      appendText(boundFilePath, text)
      return
    }
    // HWND-bound apps: try SendMessage first, fall back to real input if the
    // window is self-drawn (WM_CHAR is an app-layer no-op) or UIPI blocks.
    if (boundHwnd) {
      if (!isSelfDrawn && ensureSendAccess()) {
        guardBoundWindow(false)
        getWm().sendText(boundHwnd, text)
        return
      }
      // Real keystrokes go to the FOREGROUND window; the old code fired an
      // unverified SetForegroundWindow and typed regardless. Now: guarded
      // activate + verify, else a model-facing error.
      guardBoundWindow(true)
      // Send keys via global keybd_event
      for (const ch of text) {
        const vk = ch.charCodeAt(0)
        if (vk < 0x20 || vk > 0x7e) {
          // Non-ASCII: use keybd_event with virtual key code directly
          ps(`${WIN32_TYPES}; [CuWin32]::keybd_event([byte]0, ${vk}, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 10; [CuWin32]::keybd_event([byte]0, ${vk}, 2, [UIntPtr]::Zero)`)
        } else {
          // ASCII: use VkKeyScan to get the correct VK code
          ps(`${WIN32_TYPES}; $vk = [CuWin32]::VkKeyScan([char]${vk}); [CuWin32]::keybd_event([byte]($vk -band 0xFF), 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 10; [CuWin32]::keybd_event([byte]($vk -band 0xFF), 0, 2, [UIntPtr]::Zero)`)
        }
      }
      return
    }
    throw new Error('typeText requires a bound window or file. Call open() first.')
  },

  async key(name, action) {
    if (boundHwnd) {
      if (!isSelfDrawn && ensureSendAccess()) {
        guardBoundWindow(false)
        const lower = name.toLowerCase()
        const vk = VK_MAP[lower] ?? (name.length === 1 ? name.charCodeAt(0) : 0)
        if (vk) getWm().sendKey(boundHwnd, vk, action === 'release' ? 'up' : 'down')
        return
      }
      // Real keystrokes need the bound window foregrounded + verified
      guardBoundWindow(true)
      const lower = name.toLowerCase()
      const vk = VK_MAP[lower] ?? (name.length === 1 ? name.charCodeAt(0) : 0)
      if (vk) {
        const flag = action === 'release' ? 'KEYEVENTF_KEYUP' : '0'
        ps(`${WIN32_TYPES}; [CuWin32]::keybd_event([byte]${vk}, 0, ${flag === 'KEYEVENTF_KEYUP' ? '2' : '0'}, [UIntPtr]::Zero)`)
      }
      return
    }
    throw new Error('key requires a bound window HWND. Call open() first.')
  },

  async keys(parts) {
    if (boundHwnd) {
      if (!isSelfDrawn && ensureSendAccess()) {
        guardBoundWindow(false)
        getWm().sendKeys(boundHwnd, parts)
        return
      }
      // Real keystrokes need the bound window foregrounded + verified
      guardBoundWindow(true)
      for (const part of parts) {
        const lower = part.toLowerCase()
        const vk = VK_MAP[lower] ?? (part.length === 1 ? part.charCodeAt(0) : 0)
        if (vk) {
          ps(`${WIN32_TYPES}; [CuWin32]::keybd_event([byte]${vk}, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 10; [CuWin32]::keybd_event([byte]${vk}, 0, 2, [UIntPtr]::Zero)`)
        }
      }
      return
    }
    throw new Error('keys requires a bound window HWND. Call open() first.')
  },

  async scroll(amount, direction) {
    if (boundHwnd) {
      if (realMouseChannel()) {
        // Chromium / self-drawn: global mouse_event wheel — goes to the
        // window under the physical cursor; bound window must be foregrounded
        // + verified.
        guardBoundWindow(true)
        const flag = direction === 'vertical' ? '0x0800' : '0x1000' // MOUSEEVENTF_WHEEL / MOUSEEVENTF_HWHEEL
        ps(`${WIN32_TYPES}; [CuWin32]::SetProcessDPIAware() | Out-Null; [CuWin32]::mouse_event(${flag}, 0, 0, ${amount * 120}, [IntPtr]::Zero)`)
        return
      }
      guardBoundWindow(false)
      // WM_VSCROLL / WM_HSCROLL for window-bound scrolling
      const msg = direction === 'vertical' ? '0x0115' : '0x0114' // WM_VSCROLL / WM_HSCROLL
      const wParam = amount > 0 ? '0' : '1' // SB_LINEUP=0 / SB_LINEDOWN=1
      const n = Math.abs(Math.round(amount))
      let script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WScroll {
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
`
      for (let i = 0; i < n; i++) {
        script += `[WScroll]::SendMessage([IntPtr]${boundHwnd}, ${msg}, [IntPtr]${wParam}, [IntPtr]::Zero) | Out-Null; `
      }
      ps(script)
      return
    }
    const flag = direction === 'vertical' ? '0x0800' : '0x1000' // MOUSEEVENTF_WHEEL / MOUSEEVENTF_HWHEEL
    ps(`${WIN32_TYPES}; [CuWin32]::SetProcessDPIAware() | Out-Null; [CuWin32]::mouse_event(${flag}, 0, 0, ${amount * 120}, [IntPtr]::Zero)`)
  },

  async mouseLocation() {
    // Always returns real cursor position (informational, doesn't move it)
    const out = ps(`${WIN32_TYPES}; [CuWin32]::SetProcessDPIAware() | Out-Null; $p = New-Object CuWin32+POINT; [CuWin32]::GetCursorPos([ref]$p) | Out-Null; "$($p.X),$($p.Y)"`)
    const [xStr, yStr] = out.split(',')
    return { x: Number(xStr), y: Number(yStr) }
  },

  async sendChar(hwnd, char) { getWm().sendChar(Number(hwnd), char) },
  async sendKey(hwnd, vk, action) { getWm().sendKey(Number(hwnd), vk, action) },
  async sendMouseMove(hwnd, x, y) { getWm().sendMouseMove(Number(hwnd), x, y) },
  async sendClick(hwnd, x, y, button) { getWm().sendClick(Number(hwnd), x, y, button) },
  async sendText(hwnd, text) { getWm().sendText(Number(hwnd), text) },
}

// ---------------------------------------------------------------------------
// Screenshot — JPEG output only
// ---------------------------------------------------------------------------

/**
 * Downscale a captured screenshot to target dimensions via PowerShell/.NET.
 * Preserves original physical dimensions as displayWidth/displayHeight so
 * scaleCoord maps downsampled coords back to physical space correctly.
 */
function downscaleCapture(
  src: ScreenshotResult,
  targetW: number,
  targetH: number,
): ScreenshotResult {
  if (!src.base64 || src.width === targetW && src.height === targetH) return src
  const tmpIn = `${process.env.TEMP || '/tmp'}/cu_ds_in_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
  const tmpOut = `${process.env.TEMP || '/tmp'}/cu_ds_out_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
  try {
    const fs = require('fs')
    fs.writeFileSync(tmpIn.replace(/\\\\/g, '\\'), Buffer.from(src.base64, 'base64'))
    ps(`
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${tmpIn}')
$resized = New-Object System.Drawing.Bitmap(${targetW}, ${targetH})
$rg = [System.Drawing.Graphics]::FromImage($resized)
$rg.InterpolationMode = 7
$rg.DrawImage($src, 0, 0, ${targetW}, ${targetH})
$rg.Dispose()
$src.Dispose()
$resized.Save('${tmpOut}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$resized.Dispose()
"ok"
`)
    try { fs.unlinkSync(tmpIn.replace(/\\\\/g, '\\')) } catch {}
    const buf = fs.readFileSync(tmpOut.replace(/\\\\/g, '\\'))
    try { fs.unlinkSync(tmpOut.replace(/\\\\/g, '\\')) } catch {}
    return {
      base64: buf.toString('base64'),
      width: targetW,
      height: targetH,
      displayWidth: src.width,     // original physical width
      displayHeight: src.height,   // original physical height
      originX: src.originX,
      originY: src.originY,
    }
  } catch {
    // Downscale failed — return original (no resize, ratio stays 1.0)
    return src
  }
}

function parseCaptureOutput(raw: string): ScreenshotResult | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'NOT_FOUND' || trimmed === 'INVALID_SIZE') return null
  const firstComma = trimmed.indexOf(',')
  const secondComma = trimmed.indexOf(',', firstComma + 1)
  if (firstComma === -1 || secondComma === -1) return null
  const width = Number(trimmed.slice(0, firstComma))
  const height = Number(trimmed.slice(firstComma + 1, secondComma))
  const base64 = trimmed.slice(secondComma + 1)
  if (!width || !height || !base64) return null
  return { base64, width, height, displayWidth: width, displayHeight: height, originX: 0, originY: 0 }
}

const screenshot: ScreenshotPlatform = {
  async captureScreen(displayId, targetW?: number, targetH?: number) {
    // computeTargetDims can yield non-integers; .NET Bitmap ctor takes ints.
    if (targetW != null) targetW = Math.round(targetW)
    if (targetH != null) targetH = Math.round(targetH)
    // If HWND is bound, capture that specific window via PrintWindow
    if (boundHwnd) {
      const result = this.captureWindow?.(String(boundHwnd))
      if (result) {
        // Downscale HWND capture if target dims provided and differ
        if (targetW && targetH && (result.width !== targetW || result.height !== targetH)) {
          return downscaleCapture(result, targetW, targetH)
        }
        return result
      }
    }
    // Full-screen: save JPEG to temp file, read back as base64
    const tmpFile = `${process.env.TEMP || '/tmp'}/cu_screen_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
    // Build optional resize block — pre-sizes to targetImageSize output so
    // the API transcoder's early-return fires (no server-side resize) and
    // scaleCoord stays coherent.
    const hasResize = targetW != null && targetH != null
    const resizeBlock = hasResize ? `
$resized = New-Object System.Drawing.Bitmap(${targetW}, ${targetH})
$rg = [System.Drawing.Graphics]::FromImage($resized)
$rg.InterpolationMode = 7
$rg.DrawImage($bmp, 0, 0, ${targetW}, ${targetH})
$rg.Dispose()
$bmp.Dispose()
$bmp = $resized
` : ''
    const raw = await psAsync(`
${DPI_AWARE_PS}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = if (${displayId ?? -1} -ge 0) { [System.Windows.Forms.Screen]::AllScreens[${displayId ?? 0}] } else { [System.Windows.Forms.Screen]::PrimaryScreen }
$bounds = $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$g.Dispose()
${resizeBlock}
$bmp.Save('${tmpFile}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
"$($bounds.Width),$($bounds.Height)"
`)
    const [wStr, hStr] = (raw || '').split(',')
    try {
      const fs = require('fs')
      const buf = fs.readFileSync(tmpFile.replace(/\\\\/g, '\\'))
      try { fs.unlinkSync(tmpFile.replace(/\\\\/g, '\\')) } catch {}
      return {
        base64: buf.toString('base64'),
        width: hasResize ? targetW! : Number(wStr),
        height: hasResize ? targetH! : Number(hStr),
        displayWidth: Number(wStr),   // original physical width
        displayHeight: Number(hStr),  // original physical height
        originX: 0,
        originY: 0,
      }
    } catch {
      return { base64: '', width: 0, height: 0, displayWidth: 0, displayHeight: 0, originX: 0, originY: 0 }
    }
  },

  async captureRegion(x, y, w, h) {
    // handleZoom's image-px→logical ratio produces non-integers (e.g.
    // 1106.0266). .NET Bitmap/CopyFromScreen ctors take ints and the PS
    // script dies on the double literals — round before interpolation.
    const rx = Math.round(x), ry = Math.round(y), rw = Math.round(w), rh = Math.round(h)
    // When HWND is bound, crop from cached full-window screenshot (avoids PrintWindow on every zoom)
    if (boundHwnd) {
      const now = Date.now()
      if (!cachedScreenshot || (now - cachedScreenshot.ts) > SCREENSHOT_CACHE_TTL) {
        const full = this.captureWindow?.(String(boundHwnd))
        if (full) {
          cachedScreenshot = { ...full, ts: now }
        }
      }
      if (cachedScreenshot) {
        return cropScreenshot(cachedScreenshot, rx, ry, rw, rh)
      }
      // Fallback: full capture if cache miss
      const result = this.captureWindow?.(String(boundHwnd))
      if (result) return result
    }
    // No HWND bound: fall back to CopyFromScreen (captures real screen area)
    const tmpFile = `${process.env.TEMP || '/tmp'}/cu_region_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
    const raw = await psAsync(`
${DPI_AWARE_PS}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${rw}, ${rh})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${rx}, ${ry}, 0, 0, (New-Object System.Drawing.Size(${rw}, ${rh})))
$g.Dispose()
$bmp.Save('${tmpFile}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
"${rw},${rh}"
`)
    const [wStr, hStr] = (raw || '').split(',')
    try {
      const fs = require('fs')
      const buf = fs.readFileSync(tmpFile.replace(/\\\\/g, '\\'))
      try { fs.unlinkSync(tmpFile.replace(/\\\\/g, '\\')) } catch {}
      return { base64: buf.toString('base64'), width: Number(wStr), height: Number(hStr), displayWidth: Number(wStr), displayHeight: Number(hStr), originX: rx, originY: ry }
    } catch {
      // Surface the failure instead of a silent empty image — the model
      // can't tell a blank zoom from a broken one otherwise.
      throw new Error(`win32 captureRegion failed (region ${rx},${ry} ${rw}x${rh}, ps output: ${JSON.stringify(raw).slice(0, 200)})`)
    }
  },

  captureWindow(hwnd) {
    // PrintWindow via win32/windowCapture.ts — now outputs JPEG directly via temp file
    return captureWindowByHwnd(Number(hwnd))
  },
}

// ---------------------------------------------------------------------------
// Display — Screen.AllScreens
// ---------------------------------------------------------------------------

const display: DisplayPlatform = {
  listAll(): DisplayInfo[] {
    try {
      const raw = ps(`
${DPI_AWARE_PS}
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuDpiInfo {
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr hdc, int index);
}
'@
Add-Type -AssemblyName System.Windows.Forms
$dc = [CuDpiInfo]::GetDC([IntPtr]::Zero)
$dpi = [CuDpiInfo]::GetDeviceCaps($dc, 88)
[Void][CuDpiInfo]::ReleaseDC([IntPtr]::Zero, $dc)
$scale = [math]::Round($dpi / 96.0, 2)
$result = @()
$idx = 0
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $result += "$($s.Bounds.Width),$($s.Bounds.Height),$idx,$($s.Primary),$scale"
  $idx++
}
$result -join "|"
`)
      return raw.split('|').filter(Boolean).map(entry => {
        const [w, h, id, _primary, scale] = entry.split(',')
        return {
          width: Number(w),
          height: Number(h),
          // Dimensions are already physical pixels (DPI-aware PS script) —
          // no logical→physical conversion needed; set scaleFactor=1 so
          // computeTargetDims doesn't double-multiply.
          scaleFactor: 1,
          displayId: Number(id),
        }
      })
    } catch {
      return [{ width: 1920, height: 1080, scaleFactor: 1, displayId: 0 }]
    }
  },

  getSize(displayId): DisplayInfo {
    const all = this.listAll()
    if (displayId !== undefined) {
      const found = all.find(d => d.displayId === displayId)
      if (found) return found
    }
    return all[0] ?? { width: 1920, height: 1080, scaleFactor: 1, displayId: 0 }
  },
}

// ---------------------------------------------------------------------------
// Apps — EnumWindows + registry + AppxPackage
// ---------------------------------------------------------------------------

const apps: AppsPlatform = {
  listRunning(): WindowHandle[] {
    const windows = listWindows()
    return windows.map(w => ({
      id: String(w.hwnd),
      pid: w.pid,
      title: w.title,
    }))
  },

  async listInstalled(): Promise<InstalledApp[]> {
    // 拆阶段并行枚举（注册表 / App Paths / 快捷方式 / Get-StartApps / 运行中
    // 窗口），单飞 + 60s TTL 缓存 — 实现见 win32/installedApps.ts。
    try {
      return await listInstalledAppsWin32()
    } catch {
      return []
    }
  },

  async open(name) {
    // Detect app type and route to appropriate controller
    const appType = detectAppType(name)

    // Excel/Word → COM automation (no window, no HWND)
    if (appType === 'excel' || appType === 'word') {
      const result = await openWithController(name)
      if (result.filePath) {
        bindFile(result.filePath, result.type)
      }
      return
    }

    const escaped = name.replace(/'/g, "''")
    // Executable base name (no .exe) — process-name matching key
    const base = escaped.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').trim()

    // ── Step 0: already-running window → bind directly, no new instance ──
    // Single-instance apps (Android Studio, emulators, browsers) make
    // Start-Process hand off to the existing instance and exit — the old code
    // then waited 10s on the dead launcher PID and silently gave up, leaving
    // the binding stale. Matching the live window up front makes open()
    // idempotent and turns "user minimized/closed the window" into a re-bind.
    {
      const windows = listWindows()
      if (base) {
        const pids = getPidsForProcessName(base)
        const byProc = windows.find(w => pids.includes(w.pid))
        if (byProc) {
          bindWindow(byProc.hwnd, byProc.pid, base)
          // Tool contract says "bring to the front" — best effort; a
          // foreground-lock failure must not fail the bind itself.
          ensureWindow(byProc.hwnd, true)
          return
        }
      }
      if (windows.length > 0 && name.length >= 3) {
        const lower = name.toLowerCase()
        const byTitle = windows.find(w => w.title.toLowerCase().includes(lower))
        if (byTitle) {
          bindWindow(byTitle.hwnd, byTitle.pid, undefined)
          ensureWindow(byTitle.hwnd, true)
          return
        }
      }
    }

    // ── Launch: 1) exact path 2) PATH 3) registry 4) UWP 5) raw name ──
    const result = await psAsync(`
${WIN32_TYPES}
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CuLaunch {
    public delegate bool EnumProc(IntPtr h, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
    public static System.Collections.Generic.List<string> windows = new System.Collections.Generic.List<string>();
    public static void ListWindows() {
        windows.Clear();
        EnumWindows((h, _) => {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256);
            if (GetWindowText(h, sb, sb.Capacity) == 0) return true;
            string title = sb.ToString().Replace("|", " ");
            if (string.IsNullOrWhiteSpace(title)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            windows.Add(h.ToInt64() + "|" + pid + "|" + title);
            return true;
        }, IntPtr.Zero);
    }
}
'@
# Priority: 1) exact path  2) exe in PATH (.exe only!)  3) App Paths registry
#           4) registry Uninstall  5) UWP/Store app  6) raw name
# Get-Command must be filtered to real executables: PATH may surface Git's
# extension-less shell shims (E:/Git/usr/bin/notepad) which Start-Process
# cannot run. App Paths covers Store apps (Win11 notepad/calc live under
# WindowsApps with an App Paths entry) — Get-StartApps is unreliable in
# non-interactive sessions.
$target = '${escaped}'
$proc = $null
$launchPath = ''

# 1. Exact file path
if (Test-Path $target) {
    $proc = Start-Process $target -PassThru -ErrorAction SilentlyContinue
    $launchPath = $target
}

# 2. exe name in PATH (e.g. "notepad.exe", "code.exe") — .exe results only
if (-not $proc) {
    foreach ($name in @($target, "$target.exe")) {
        $found = Get-Command $name -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -and $_.Source.EndsWith('.exe') } |
            Select-Object -First 1
        if ($found) {
            $proc = Start-Process $found.Source -PassThru -ErrorAction SilentlyContinue
            if ($proc) { $launchPath = $found.Source; break }
        }
    }
}

# 3. App Paths registry (HKCU/HKLM) — Store apps + portable installs
if (-not $proc) {
    foreach ($name in @("$target.exe", $target)) {
        foreach ($hive in @('HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
            $ap = Get-ItemProperty (Join-Path $hive $name) -ErrorAction SilentlyContinue
            if ($ap -and $ap.'(default)' -and (Test-Path $ap.'(default)')) {
                $proc = Start-Process $ap.'(default)' -PassThru -ErrorAction SilentlyContinue
                if ($proc) { $launchPath = $ap.'(default)'; break }
            }
        }
        if ($proc) { break }
    }
}

# 4. Search registry Uninstall for install location by display name or key
if (-not $proc) {
    $regPaths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
    foreach ($p in $regPaths) {
        $app = Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object {
            ($_.DisplayName -and $_.DisplayName -match [regex]::Escape($target)) -or $_.PSChildName -eq $target
        } | Select-Object -First 1
        if ($app -and $app.InstallLocation) {
            $exes = Get-ChildItem $app.InstallLocation -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($exes) { $proc = Start-Process $exes.FullName -PassThru -ErrorAction SilentlyContinue; $launchPath = $exes.FullName; break }
        }
    }
}

# 5. UWP/Store app — direct AppID first, then display-name match
if (-not $proc) {
    $sapp = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.AppID -eq $target } | Select-Object -First 1
    if (-not $sapp) {
        $sapp = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -match [regex]::Escape($target) } | Select-Object -First 1
    }
    if ($sapp) { $proc = Start-Process "shell:AppsFolder\$($sapp.AppID)" -PassThru -ErrorAction SilentlyContinue }
}

# 6. Last resort: try raw name
if (-not $proc) { $proc = Start-Process -FilePath $target -PassThru -ErrorAction SilentlyContinue; if ($proc) { $launchPath = $target } }

if (-not $proc) { Write-Host "LAUNCH_FAILED"; exit }

# Wait for a window: 1) the new PID  2) any PID whose process name matches the
# launched exe's base (single-instance handoff / UWP stub-PID cases)  3) a
# window title containing the base or target name. namePids is recomputed per
# iteration — Store apps may not have spawned yet on loop entry.
$hint = if ($launchPath -like '*\\*') { [System.IO.Path]::GetFileNameWithoutExtension($launchPath) } else { '${base}' }
$hwnd = 0
$hwndPid = 0
for ($i = 0; $i -lt 50 -and $hwnd -eq 0; $i++) {
    Start-Sleep -Milliseconds 200
    [CuLaunch]::ListWindows()
    foreach ($c in [CuLaunch]::windows) {
        $parts = $c.Split('|')
        if ($parts.Length -lt 3) { continue }
        $wh = [long]$parts[0]; $wp = [uint32]$parts[1]; $wt = $parts[2]
        if ($wp -eq [uint32]$proc.Id) { $hwnd = $wh; $hwndPid = $wp; break }
    }
    if ($hwnd -eq 0 -and -not [string]::IsNullOrEmpty($hint)) {
        $namePids = @()
        Get-Process -Name $hint -ErrorAction SilentlyContinue | ForEach-Object { $namePids += [uint32]$_.Id }
        foreach ($c in [CuLaunch]::windows) {
            $parts = $c.Split('|')
            if ($parts.Length -lt 3) { continue }
            $wh = [long]$parts[0]; $wp = [uint32]$parts[1]
            if ($namePids -contains $wp) { $hwnd = $wh; $hwndPid = $wp; break }
        }
    }
    if ($hwnd -eq 0 -and -not [string]::IsNullOrEmpty($hint)) {
        foreach ($c in [CuLaunch]::windows) {
            $parts = $c.Split('|')
            if ($parts.Length -lt 3) { continue }
            $wh = [long]$parts[0]; $wp = [uint32]$parts[1]; $wt = $parts[2]
            if ($wt.IndexOf($hint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or $wt.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                $hwnd = $wh; $hwndPid = $wp; break
            }
        }
    }
}
if ($hwnd -eq 0) { Write-Host "HWND_NOT_FOUND|$($proc.Id)"; exit }
$exePath = ''
try { $exePath = (Get-Process -Id $hwndPid -ErrorAction SilentlyContinue).Path } catch {}
if (-not $exePath) { $exePath = $launchPath }
Write-Host "$hwnd|$hwndPid|$exePath"
`)
    if (!result || result.startsWith('LAUNCH_FAILED')) {
      throw new Error(
        `Failed to open "${name}": no launchable executable was found for it. ` +
          'It may be installed under a different name — request it via ' +
          'request_access with the exact display name shown in the available ' +
          'applications list, or pass its full executable path.',
      )
    }
    if (result.startsWith('HWND_NOT_FOUND')) {
      throw new Error(
        `Launched "${name}" but no application window appeared within 10s. ` +
          'It may be a background-only app, still initializing, or require ' +
          'elevation. Take a screenshot to check whether it appeared late, ' +
          'then retry the action or call open_application again to rebind.',
      )
    }
    const parts = result.trim().split('|')
    const hwnd = Number(parts[0])
    const pid = Number(parts[1])
    const exePath = (parts[2] ?? '').trim()
    if (hwnd > 0) {
      // Bind to the launched window — all subsequent operations target this HWND
      const exeBase = exePath
        ? exePath.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').trim()
        : base
      bindWindow(hwnd, pid, exeBase || undefined)
    }
  },

  getFrontmostApp(): FrontmostAppInfo | null {
    try {
      const out = ps(`${WIN32_TYPES}
$hwnd = [CuWin32]::GetForegroundWindow()
$procId = [uint32]0
[CuWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
"$($proc.MainModule.FileName)|$($proc.ProcessName)"`)
      if (!out || !out.includes('|')) return null
      const [exePath, appName] = out.split('|', 2)
      return { id: exePath!, appName: appName! }
    } catch {
      return null
    }
  },

  findWindowByTitle(title): WindowHandle | null {
    const windows = listWindows()
    const found = windows.find(w => w.title.includes(title))
    if (!found) return null
    return { id: String(found.hwnd), pid: found.pid, title: found.title }
  },
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const platform: Platform = { input, screenshot, display, apps }

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

import { win32 as windowsPath } from 'node:path'
import { API_RESIZE_PARAMS, resetMouseButtonHeld, targetImageSize } from '@ant/computer-use-mcp'
import type { BindingReleaseInfo, BindingReleaseReason, FrontmostApp, TargetPreparation, WindowsWindow } from '@ant/computer-use-mcp'
import { logForDebugging } from '../../debug.js'
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
import { listWindowDetails, listWindows } from '../win32/windowEnum.js'
import { captureWindowByHwnd } from '../win32/windowCapture.js'
import { detectAppType, openWithController } from '../win32/appDispatcher.js'
import { markBound, unmarkBound } from '../win32/windowBorder.js'
import {
  activateObservedWindow,
  ensureInputWindow,
  buildRequireWindowScript,
  findReplacementWindow,
  getPidsForProcessName,
} from '../win32/windowGuard.js'
import { listInstalledAppsWin32 } from '../win32/installedApps.js'
import { buildPortableAppLaunchBlock, START_CU_APPLICATION } from '../win32/appLaunch.js'
import { classifyWindowClasses, type WindowFramework } from '../win32/windowClassify.js'
import { getWin32EscExpectFile, isWin32EscHotkeyRegistered } from '../win32/escHook.js'
import { runPowerShell, windowsActionSignal } from '../win32/powerShell.js'
import { childWindowClasses, enumerateDisplays, foregroundTarget, monitorForWindow, targetAtPoint, windowRectangle, windowText } from '../win32/nativeWindows.js'
import { ensureElevatedPowerShell, getElevatedPowerShellPid, isElevatedPowerShellActive, prepareComputerUseRelease, runComputerUsePowerShell, setComputerUseTargetElevated } from '../win32/elevatedPowerShell.js'
import { PROCESS_IMAGE_PS } from '../win32/processImage.js'
import { getCurrentProcessIL, getProcessIL, INPUT_INTEGRITY_TYPES, needsElevatedHelper } from '../win32/elevation.js'
import { desktopState } from '../win32/uacProbe.js'

// ---------------------------------------------------------------------------
// Screenshot cache for zoom — avoids re-capturing via PrintWindow on every zoom
// ---------------------------------------------------------------------------
let cachedScreenshot: { base64: string; width: number; height: number; ts: number } | null = null
const SCREENSHOT_CACHE_TTL = 500 // ms — reuse cached capture for zoom within this window

/**
 * Crop a region from a cached screenshot using in-memory JPEG decode + crop.
 * Returns the cropped region as a new ScreenshotResult.
 */
async function cropScreenshot(
  cache: { base64: string; width: number; height: number },
  rx: number, ry: number, rw: number, rh: number,
): Promise<ScreenshotResult> {
  // Clamp crop region to source bounds
  const cx = Math.max(0, Math.min(Math.round(rx), cache.width))
  const cy = Math.max(0, Math.min(Math.round(ry), cache.height))
  const cw = Math.min(Math.round(rw), cache.width - cx)
  const ch = Math.min(Math.round(rh), cache.height - cy)
  if (cw <= 0 || ch <= 0) {
    throw new Error(`Invalid crop region ${rx},${ry} ${rw}x${rh} for ${cache.width}x${cache.height} screenshot`)
  }
  // Use PowerShell to crop — avoids native image dependency
  const tmpIn = `${process.env.TEMP || '/tmp'}/cu_crop_in_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
  const tmpOut = `${process.env.TEMP || '/tmp'}/cu_crop_out_${Date.now()}.jpg`.replace(/\\/g, '\\\\')
  try {
    const fs = require('fs')
    const inBuf = Buffer.from(cache.base64, 'base64')
    fs.writeFileSync(tmpIn.replace(/\\\\/g, '\\'), inBuf)
    // Use .NET System.Drawing to crop (fast, no external deps)
    await psAsync(`
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
  } catch (error) {
    throw new Error(`Screenshot crop failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    try { require('fs').unlinkSync(tmpIn.replace(/\\\\/g, '\\')) } catch {}
    try { require('fs').unlinkSync(tmpOut.replace(/\\\\/g, '\\')) } catch {}
  }
}

// ---------------------------------------------------------------------------
// PowerShell helpers
// ---------------------------------------------------------------------------

async function psAsync(script: string, timeoutMs = 15_000): Promise<string> {
  return runComputerUsePowerShell(script, timeoutMs)
}

/** Let a short press/release pair finish once started so Escape cannot strand a button or modifier. */
async function sendAtomicInput(script: string): Promise<void> {
  windowsActionSignal.getStore()?.throwIfAborted()
  await windowsActionSignal.exit(() => psAsync(script, 8000))
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
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

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
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    public static bool SetProcessDPIAware() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4))) {
            throw new System.Exception("Per-monitor-v2 DPI awareness is required for physical-pixel input.");
        }
        return true;
    }

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

// Per-monitor-v2 keeps window, display, capture, and input coordinates in
// physical pixels on every monitor.
const DPI_AWARE_PS = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuDpi {
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    public static bool SetProcessDPIAware() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4))) {
            throw new System.Exception("Per-monitor-v2 DPI awareness is required for physical-pixel capture.");
        }
        return true;
    }
}
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
/** Authorized application identity that produced the current binding. */
let boundAppId: string | null = null
let boundAt: number | null = null
let bindingRevision = 0
/** Last release, kept for diagnostics and for the screenshot that observes it. */
let lastBindingRelease: BindingReleaseInfo | null = null
let explicitlyActivatedPid: number | undefined
/** Track whether SendMessage is working for the bound window (UIPI check) */
let sendMessageOk: boolean | null = null
/** Bound window framework — diagnostics and channel decision. */
let boundFramework: WindowFramework = 'standard'
/** SendMessage mouse is a no-op for this framework; real input is required. */
let mouseNeedsRealInput = false
/** SendMessage keyboard is a no-op for this framework; real input is required. */
let keyboardNeedsRealInput = false
/** Class that triggered the framework classification — diagnostics. */
let boundFrameworkClass: string | null = null
/** Channel used by the current decomposed mouse-down, so release pairs correctly. */
let mouseDownUsedRealInput: boolean | null = null
let inputReleasePendingAfterTurn = false
const pendingKeyReleases = new Set<number>()

function shouldLeaveBoundForNewForeground(boundPid: number | null, boundAt: number | null, foreground: FrontmostAppInfo): boolean {
  if (!boundPid || !boundAt) return false
  const foregroundPid = foreground.hostPid ?? foreground.pid
  const startedAt = foreground.hostStartedAt ?? foreground.startedAt
  return !!foregroundPid && foregroundPid !== boundPid && !!startedAt && startedAt > boundAt
}

function toFrontmostApp(foreground: FrontmostAppInfo): FrontmostApp {
  return {
    bundleId: foreground.id,
    displayName: foreground.appName,
    ...(foreground.hostId === undefined ? {} : { hostBundleId: foreground.hostId }),
    ...(foreground.hostName === undefined ? {} : { hostDisplayName: foreground.hostName }),
    ...(foreground.pid === undefined ? {} : { pid: foreground.pid }),
    ...(foreground.hostPid === undefined ? {} : { hostPid: foreground.hostPid }),
    ...(foreground.hostTrusted === undefined ? {} : { hostTrusted: foreground.hostTrusted }),
    ...(foreground.startedAt === undefined ? {} : { startedAt: foreground.startedAt }),
    ...(foreground.hostStartedAt === undefined ? {} : { hostStartedAt: foreground.hostStartedAt }),
  }
}

/**
 * The CU broker and the UAC consent UI are part of this tool's own elevation
 * flow, not an application taking the target over. Treating them as a new
 * foreground app would drop the binding we just created for the elevated
 * target. `consent.exe` covers the secure-desktop prompt; the broker PID covers
 * the long-lived elevated PowerShell.
 */
export function isComputerUseTransientForeground(
  foreground: FrontmostAppInfo,
  context: { selfPid: number; helperPid: number | null },
): boolean {
  const paths = [foreground.id, foreground.hostId]
    .filter((value): value is string => !!value)
    .filter(value => value.includes('\\') || value.includes('/'))
  const systemRoot = (process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows').replace(/[\\/]+$/, '').toLowerCase()
  const systemConsentPaths = new Set([`${systemRoot}\\system32\\consent.exe`, `${systemRoot}\\syswow64\\consent.exe`])
  if (paths.some(value => systemConsentPaths.has(value.replace(/\//g, '\\').toLowerCase()))) return true
  const names = [foreground.appName, foreground.hostName]
    .filter((value): value is string => !!value)
    .map(value => value.toLowerCase())
  // consent.exe normally exposes its process name even when the image path is
  // unreadable from a medium-integrity process. Only treat the bare name as
  // transient; a path-qualified third-party consent.exe is a real app.
  if (paths.length === 0 && names.includes('consent')) return true
  const pid = foreground.hostPid ?? foreground.pid
  if (pid === context.selfPid) return true
  return context.helperPid !== null && (pid === context.helperPid || foreground.pid === context.helperPid)
}

async function flushPendingKeyReleases(): Promise<void> {
  if (pendingKeyReleases.size === 0 || desktopState() !== 'ready') return
  for (const vk of [...pendingKeyReleases]) {
    try {
      await psAsync(`${WIN32_TYPES}; [CuWin32]::keybd_event([byte]${vk}, 0, 2, [UIntPtr]::Zero)`)
      pendingKeyReleases.delete(vk)
    } catch (error) {
      throw new Error(`Could not release a held Windows key before the next action. ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export async function prepareWindowsTarget(signal?: AbortSignal, purpose: TargetPreparation = 'input'): Promise<void> {
  signal?.throwIfAborted()
  if (pendingKeyReleases.size > 0) await prepareComputerUseRelease()
  await flushPendingKeyReleases()
  const foreground = apps.getFrontmostApp()
  const foregroundPid = foreground?.hostPid ?? foreground?.pid
  if (foregroundPid !== explicitlyActivatedPid) {
    explicitlyActivatedPid = undefined
    if (foreground && !isComputerUseTransientForeground(foreground, {
      selfPid: process.pid,
      helperPid: getElevatedPowerShellPid(),
    }) && shouldLeaveBoundForNewForeground(boundPid, boundAt, foreground)) {
      unbindWindow('new_foreground', foreground)
    }
  }
  if (!boundPid && (purpose === 'capture' || purpose === 'hover')) {
    // Full-display capture and positioning operate on the desktop itself.
    setComputerUseTargetElevated(false)
    return
  }
  const current = getCurrentProcessIL()
  if (current === 'high' || current === 'system') {
    setComputerUseTargetElevated(false)
    return
  }
  const pid = boundPid ?? foreground?.pid
  const target = pid ? getProcessIL(pid) : 'unknown'
  const required = needsElevatedHelper(current, target)
  if (required) {
    if (purpose === 'hover' && !isElevatedPowerShellActive()) {
      throw new Error('This window requires the Windows Computer Use helper. Capture a fresh screenshot after the user approves it before moving the pointer.')
    }
    await ensureElevatedPowerShell(signal)
  }
  setComputerUseTargetElevated(required)
}

/** Retry only deferred cleanup or an interrupted press after UAC. */
export async function releaseWindowsInputBeforeAction(afterUac: boolean): Promise<void> {
  if (afterUac || inputReleasePendingAfterTurn || pendingKeyReleases.size > 0) {
    await releaseWindowsMouseAfterTurn()
  }
  if (clearTargetWhenInputReleased && !inputReleasePendingAfterTurn) clearWindowsTargetAfterStop()
}

let clearTargetWhenInputReleased = false

export function clearWindowsTargetAfterStop(): void {
  clearTargetWhenInputReleased = inputReleasePendingAfterTurn
  if (!clearTargetWhenInputReleased) unbindWindow()
}

/** Clean up an unfinished decomposed press once the user desktop is active. */
export async function releaseWindowsMouseAfterTurn(): Promise<void> {
  const channel = mouseDownUsedRealInput
  inputReleasePendingAfterTurn = channel !== null || pendingKeyReleases.size > 0
  if (!inputReleasePendingAfterTurn || desktopState() !== 'ready') return
  if (pendingKeyReleases.size > 0 || channel === true) await prepareComputerUseRelease()
  await flushPendingKeyReleases()
  if (channel !== null) {
    try {
      if (channel || boundHwnd) await input.mouseUp(0, 0)
    } catch (error) {
      // A dead background target never held a physical button.
      if (channel) {
        throw new Error(`The physical Windows mouse button could not be released. No new action was sent; retry cleanup before continuing. ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    mouseDownUsedRealInput = null
    resetMouseButtonHeld()
  }
  inputReleasePendingAfterTurn = false
}

/** Mouse channel for the bound window: real input required? */
function realMouseChannel(): boolean {
  return mouseNeedsRealInput
}

/** Keyboard channel. Frameworks that ignore synthetic mouse also ignore
 *  synthetic keyboard at the app layer, so both flags normally move together. */
function realKeyboardChannel(): boolean {
  return keyboardNeedsRealInput
}

/** Get the bound HWND, or null if not bound */
export function getBoundHwnd(): number | null { return boundHwnd }

/** Authorized app identity for package-level tier checks, not a guessed foreground app. */
export function getBoundAppId(): string | null { return boundAppId }
export function getBoundRevision(): number { return bindingRevision }
/** Last release; cleared when a new binding is established. */
export function getBindingRelease(): BindingReleaseInfo | null { return lastBindingRelease }

/** Get the bound app type */
export function getBoundAppType(): string | null { return boundAppType }

/** Get the bound file path (for COM-controlled apps) */
export function getBoundFilePath(): string | null { return boundFilePath }

/** Bind to a window HWND — all subsequent input/screenshot operations target this handle */
export function bindWindow(hwnd: number, pid?: number, exeBase?: string, appId: string | null = null): void {
  // Unmark previous window if any
  if (boundHwnd) unmarkBound(boundHwnd)
  boundHwnd = hwnd
  boundPid = pid ?? null
  boundAppType = 'generic'
  boundFilePath = null
  boundExeBase = exeBase ?? null
  boundAppId = appId
  boundAt = Date.now()
  bindingRevision++
  lastBindingRelease = null
  explicitlyActivatedPid = undefined
  mouseDownUsedRealInput = null
  // Reset SendMessage status — will be checked on first operation
  sendMessageOk = null
  // Framework classification decides the input channel: SendMessage
  // (background, no cursor/focus theft) vs real input (foreground guard).
  const framework = detectWindowFramework(hwnd)
  boundFramework = framework.framework
  mouseNeedsRealInput = framework.mouseNeedsRealInput
  keyboardNeedsRealInput = framework.keyboardNeedsRealInput
  boundFrameworkClass = framework.matchedClass
  // Invalidate screenshot cache for new window
  cachedScreenshot = null
  // Green border on the bound window
  markBound(hwnd)
}

/** Bind to a COM-controlled file (Excel/Word — no window needed) */
export function bindFile(filePath: string, appType: import('../win32/appDispatcher.js').AppType, appId: string | null = null): void {
  boundHwnd = null
  boundPid = null
  boundAppType = appType
  boundFilePath = filePath
  boundAppId = appId
  boundAt = Date.now()
  bindingRevision++
  lastBindingRelease = null
  explicitlyActivatedPid = undefined
  mouseDownUsedRealInput = null
}

/** Unbind — revert to global mode, remove green border, and record why. */
export function unbindWindow(
  reason: BindingReleaseReason = 'explicit',
  foreground: FrontmostAppInfo | null = null,
): void {
  if (boundHwnd !== null || boundFilePath !== null) {
    lastBindingRelease = {
      reason,
      at: Date.now(),
      revision: bindingRevision + 1,
      appId: boundAppId,
      pid: boundPid,
      hwnd: boundHwnd,
      foreground: foreground ? toFrontmostApp(foreground) : null,
    }
    logForDebugging(
      `[Computer Use] binding released: reason=${reason} app=${boundAppId ?? 'none'} ` +
        `pid=${boundPid ?? 'none'} hwnd=${boundHwnd ?? 'none'} ` +
        `foreground=${foreground ? `${foreground.pid ?? '?'}:${foreground.id}` : 'none'}`,
      { level: 'debug' },
    )
  }
  if (boundHwnd) unmarkBound(boundHwnd)
  boundHwnd = null
  boundPid = null
  boundAppType = null
  boundFilePath = null
  boundExeBase = null
  boundAppId = null
  boundAt = null
  bindingRevision++
  explicitlyActivatedPid = undefined
  mouseDownUsedRealInput = null
  sendMessageOk = null
  boundFramework = 'standard'
  mouseNeedsRealInput = false
  keyboardNeedsRealInput = false
  boundFrameworkClass = null
}

/** Diagnostics for tests/debugging: how the bound window's input is routed. */
export function getBoundInputChannel(): {
  framework: WindowFramework
  chromium: boolean
  selfDrawn: boolean
  frameworkClass: string | null
  realMouse: boolean
  realKeyboard: boolean
} {
  return {
    framework: boundFramework,
    chromium: boundFramework === 'chromium',
    selfDrawn: boundFramework === 'self-drawn',
    frameworkClass: boundFrameworkClass,
    realMouse: realMouseChannel(),
    realKeyboard: realKeyboardChannel(),
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
 *  - `needForeground=true`（真实输入传输：Chromium 窗口等使用的
 *    SetCursorPos+mouse_event / keybd_event）: ensureWindow 在单条 PowerShell
 *    里完成 恢复最小化 → AttachThreadInput 激活 → 重试校验；未达前台即抛错，
 *    绝不把点击/按键打进当前前台的错误应用。
 *
 * 窗口已死时先按 PID / 进程名找替身窗口重绑（应用换了窗口而非退出），
 * 找不到才抛错并指引模型重新 open_application。
 */
async function guardBoundWindow(needForeground: boolean): Promise<void> {
  if (!boundHwnd) return
  let result = await ensureInputWindow(boundHwnd, needForeground, boundPid ?? undefined)
  if (result.status === 'dead' && !isAbsoluteExe(boundAppId)) {
    const replacement = findReplacementWindow(boundPid, boundExeBase)
    if (replacement) {
      bindWindow(replacement.hwnd, replacement.pid, boundExeBase ?? undefined, boundAppId)
      result = await ensureInputWindow(boundHwnd, needForeground, boundPid ?? undefined)
    }
  }
  if (result.status === 'ok') return
  if (result.status === 'identity_mismatch') {
    throw new Error(
      `The target window now belongs to a different process (PID ${result.actualPid ?? 'unknown'}), so its previous authorization no longer applies. No input was sent. Call open_application for the intended app, then take a screenshot.`,
    )
  }
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

function requireForegroundScript(hwnd: number): string {
  return `${INPUT_INTEGRITY_TYPES}
[CuInputIntegrity]::RequireWindow([IntPtr]${hwnd})
${buildRequireWindowScript(hwnd, boundPid ?? undefined)}
if (-not [CuGuard]::IsFg([IntPtr]${hwnd})) { throw 'Foreground changed immediately before input dispatch' }
`
}

// ---------------------------------------------------------------------------
// UIPI check: test whether SendMessage reaches the bound window
// ---------------------------------------------------------------------------

async function checkSendMessageAccess(hwnd: number): Promise<boolean> {
  const { testSendMessage } = require('../win32/elevation.js') as typeof import('../win32/elevation.js')
  return testSendMessage(hwnd)
}

/** Ensure we can SendMessage to the bound window, or fail with actionable guidance. */
async function ensureSendAccess(): Promise<boolean> {
  if (!boundHwnd) return false
  if (sendMessageOk === null) {
    sendMessageOk = await checkSendMessageAccess(boundHwnd)
  }
  if (sendMessageOk === false) {
    throw new Error('Windows UIPI blocked messages to the target application. Ask the user to operate this window directly. No input was sent.')
  }
  return true
}

// ---------------------------------------------------------------------------
// Window-framework detection: Chromium / WPF / WinUI / WinForms / self-drawn
// ---------------------------------------------------------------------------

/**
 * Enumerate the top-level + child window class names of an HWND, then
 * classify via windowClassify.ts (pure). One PowerShell invocation.
 *
 * The classifier returns per-framework mouse/keyboard capabilities:
 * SendMessage is preferred, and only frameworks that demonstrably ignore
 * synthetic messages get the real-input channel (foreground guard).
 */
function detectWindowFramework(hwnd: number) {
  return classifyWindowClasses(windowText(hwnd, 'class'), childWindowClasses(hwnd))
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
// Input — When HWND is bound, prefer SendMessage (background, no focus steal,
// no physical cursor movement). Real input (SetCursorPos + mouse_event /
// keybd_event) is used only when the classified framework ignores synthetic
// messages at the app layer:
//   - Chromium (Electron/CEF/WebView2)
//   - WPF (HwndWrapper, e.g. AnyCast), WinUI 3 / UWP, WinForms
//   - JavaFX, Flutter, Unreal, Tk, and self-drawn Qt/SDL/GLFW/Unity/AWT
// Real input goes to the FOREGROUND window — guardBoundWindow(true) activates
// and verifies the bound window first, or the action fails with an error.
// ---------------------------------------------------------------------------

export function getBoundWindowDimensions(): { width: number; height: number } | null {
  return boundHwnd ? windowRectangle(boundHwnd) : null
}

function clickPowerShellScript(hwnd: number, x: number, y: number, button: 'left' | 'right' | 'middle', count: number): string {
  const downFlag = button === 'left' ? '0x0002' : button === 'right' ? '0x0008' : '0x0020'
  const upFlag = button === 'left' ? '0x0004' : button === 'right' ? '0x0010' : '0x0040'
  const rx = Math.round(x)
  const ry = Math.round(y)
  return `${WIN32_TYPES}
${requireForegroundScript(hwnd)}
[CuWin32]::SetProcessDPIAware() | Out-Null
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuClickRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuClickRect+RECT
for (\$i = 0; \$i -lt ${count}; \$i++) {
    if (-not [CuGuard]::IsFg([IntPtr]${hwnd})) { throw "Foreground changed during click sequence after \$i/${count} clicks; outcome is partial" }
    if (-not [CuClickRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r)) { throw 'GetWindowRect failed before click' }
    if (-not [CuWin32]::SetCursorPos(${rx} + \$r.L, ${ry} + \$r.T)) { throw 'SetCursorPos failed before click' }
    Start-Sleep -Milliseconds 20
    [CuInputIntegrity]::RequireAtCursor([IntPtr]${hwnd})
    [CuWin32]::mouse_event(${downFlag}, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [CuWin32]::mouse_event(${upFlag}, 0, 0, 0, [IntPtr]::Zero)
    if (\$i + 1 -lt ${count}) { Start-Sleep -Milliseconds 30 }
}
`
}

async function sendInputClick(hwnd: number, x: number, y: number, button: 'left' | 'right' | 'middle', count: number): Promise<void> {
  await sendAtomicInput(clickPowerShellScript(hwnd, x, y, button, count))
}

/**
 * SetCursorPos-based mouse move to screen coordinates.
 * Converts screenshot coords to screen coords using GetWindowRect.
 */
async function sendInputMove(hwnd: number, x: number, y: number): Promise<void> {
  const rx = Math.round(x)
  const ry = Math.round(y)
  await sendAtomicInput(`${WIN32_TYPES}
${INPUT_INTEGRITY_TYPES}
[CuInputIntegrity]::RequireWindow([IntPtr]${hwnd})
[CuWin32]::SetProcessDPIAware() | Out-Null
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuMoveRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuMoveRect+RECT
if (-not [CuMoveRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r)) { throw 'GetWindowRect failed before mouse move' }
if (-not [CuWin32]::SetCursorPos(${rx} + \$r.L, ${ry} + \$r.T)) { throw 'SetCursorPos failed during mouse move' }
`)
}

/**
 * Press or release a mouse button via real input at window-relative coords.
 * Used by drag (down → move → up) — separate phases so the physical button
 * stays held between invocations, unlike sendInputClick.
 */
async function sendInputButton(
  hwnd: number | undefined,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  phase: 'down' | 'up',
): Promise<void> {
  const flag =
    phase === 'down'
      ? button === 'left' ? '0x0002' : button === 'right' ? '0x0008' : '0x0020'
      : button === 'left' ? '0x0004' : button === 'right' ? '0x0010' : '0x0040'
  const rx = Math.round(x)
  const ry = Math.round(y)
  if (phase === 'up') {
    // Cleanup does not need a live target rectangle or a new cursor position.
    await psAsync(`${WIN32_TYPES}; [CuWin32]::mouse_event(${flag}, 0, 0, 0, [IntPtr]::Zero)`)
    return
  }
  const guard = hwnd === undefined ? '' : requireForegroundScript(hwnd)
  const origin = hwnd === undefined ? '\$ox = 0; \$oy = 0;' : `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuBtnRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuBtnRect+RECT
if (-not [CuBtnRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r)) { throw 'GetWindowRect failed before mouse button event' }
\$ox = \$r.L
\$oy = \$r.T
`
  await sendAtomicInput(`${WIN32_TYPES}
${guard}
${hwnd === undefined ? INPUT_INTEGRITY_TYPES : ''}
[CuWin32]::SetProcessDPIAware() | Out-Null
${origin}
if (-not [CuWin32]::SetCursorPos(${rx} + \$ox, ${ry} + \$oy)) { throw 'SetCursorPos failed before mouse button event' }
Start-Sleep -Milliseconds 20
[CuInputIntegrity]::RequireAtCursor()
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
async function sendInputDrag(
  hwnd: number | undefined,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationMs: number,
): Promise<void> {
  const fx = Math.round(fromX)
  const fy = Math.round(fromY)
  const tx = Math.round(toX)
  const ty = Math.round(toY)
  const frames = Math.max(2, Math.min(40, Math.round(durationMs / 25)))
  const frameMs = Math.max(10, Math.round(durationMs / frames))
  const guard = hwnd === undefined ? '' : requireForegroundScript(hwnd)
  const origin = hwnd === undefined ? '\$ox = 0; \$oy = 0;' : `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuDragRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuDragRect+RECT
if (-not [CuDragRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r)) { throw 'GetWindowRect failed before drag' }
\$ox = \$r.L
\$oy = \$r.T
`
  const beforePress = hwnd === undefined ? '' : `if (-not [CuGuard]::IsFg([IntPtr]${hwnd})) { throw 'Foreground changed before drag press' }`
  const duringDrag = hwnd === undefined ? '' : `if (-not [CuGuard]::IsFg([IntPtr]${hwnd})) { throw "Foreground changed during drag frame \$i; the drag may be partial" }`
  // Interpolation is computed PowerShell-side (single process).
  mouseDownUsedRealInput = true
  await psAsync(`${WIN32_TYPES}
${guard}
${hwnd === undefined ? INPUT_INTEGRITY_TYPES : ''}
[CuWin32]::SetProcessDPIAware() | Out-Null
${origin}
if (-not [CuWin32]::SetCursorPos(${fx} + \$ox, ${fy} + \$oy)) { throw 'SetCursorPos failed at drag start' }
Start-Sleep -Milliseconds 40
${beforePress}
[CuInputIntegrity]::RequireAtCursor()
[CuWin32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
try {
    \$frames = ${frames}
    for (\$i = 1; \$i -le \$frames; \$i++) {
        \$t = \$i / \$frames
        \$eased = 1 - [math]::Pow(1 - \$t, 3)
        \$x = [math]::Round(${fx} + (${tx} - ${fx}) * \$eased) + \$ox
        \$y = [math]::Round(${fy} + (${ty} - ${fy}) * \$eased) + \$oy
        ${duringDrag}
        if (-not [CuWin32]::SetCursorPos(\$x, \$y)) { throw 'SetCursorPos failed during drag' }
        [CuInputIntegrity]::RequireAtCursor()
        Start-Sleep -Milliseconds ${frameMs}
    }
} finally {
    [CuWin32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
}
`)
  mouseDownUsedRealInput = null
}

const KEYBOARD_TYPES = `
Add-Type -Language CSharp @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Explicit)]
public struct CuKeyboardInput {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public CuInputUnion union;
}
[StructLayout(LayoutKind.Explicit)]
public struct CuInputUnion {
    [FieldOffset(0)] public CuKeybdInput ki;
    [FieldOffset(0)] public CuMouseInput mi;
}
[StructLayout(LayoutKind.Sequential)]
public struct CuMouseInput {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Sequential)]
public struct CuKeybdInput {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}
public static class CuKeyboard {
    [DllImport("user32.dll", SetLastError=true)]
    static extern uint SendInput(uint nInputs, CuKeyboardInput[] pInputs, int cbSize);

    static CuKeyboardInput Event(ushort vk, ushort scan, uint flags) {
        return new CuKeyboardInput {
            type = 1,
            union = new CuInputUnion { ki = new CuKeybdInput { wVk = vk, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero } }
        };
    }
    static void Send(CuKeyboardInput[] events) {
        uint sent = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(CuKeyboardInput)));
        if (sent == events.Length) return;
        int error = Marshal.GetLastWin32Error();
        string cleanupError = "";
        if (sent > 0) {
            try {
                var cleanup = new List<CuKeyboardInput>();
                for (int i = (int)sent - 1; i >= 0; i--) {
                    if ((events[i].union.ki.dwFlags & 0x0002) == 0) {
                        cleanup.Add(Event(
                            events[i].union.ki.wVk,
                            events[i].union.ki.wScan,
                            events[i].union.ki.dwFlags | 0x0002));
                    }
                }
                if (cleanup.Count > 0) {
                    uint released = SendInput((uint)cleanup.Count, cleanup.ToArray(), Marshal.SizeOf(typeof(CuKeyboardInput)));
                    if (released != cleanup.Count) cleanupError = " Cleanup injected " + released + "/" + cleanup.Count + " key-up events.";
                }
            } catch (Exception cleanupFailure) {
                cleanupError = " Cleanup failed: " + cleanupFailure.Message;
            }
        }
        throw new Exception("SendInput injected " + sent + "/" + events.Length +
            " events (Win32 error " + error + "). Input may be partial; do not retry blindly." + cleanupError);
    }
    public static void Unicode(string text) {
        var events = new List<CuKeyboardInput>();
        foreach (char ch in text) {
            events.Add(Event(0, ch, 0x0004));
            events.Add(Event(0, ch, 0x0004 | 0x0002));
        }
        if (events.Count > 0) Send(events.ToArray());
    }
    public static void Chord(int[] modifiers, int[] keys) {
        var events = new List<CuKeyboardInput>();
        foreach (int key in modifiers) events.Add(Event((ushort)key, 0, 0));
        foreach (int key in keys) {
            events.Add(Event((ushort)key, 0, 0));
            events.Add(Event((ushort)key, 0, 0x0002));
        }
        for (int i = modifiers.Length - 1; i >= 0; i--) {
            events.Add(Event((ushort)modifiers[i], 0, 0x0002));
        }
        if (events.Count > 0) Send(events.ToArray());
    }
}
'@
`

function vkForKey(name: string): number | undefined {
  const lower = name.toLowerCase()
  const mapped = VK_MAP[lower]
  if (mapped !== undefined) return mapped
  if (name.length === 1 && name.charCodeAt(0) <= 0x7f) {
    return name.toUpperCase().charCodeAt(0)
  }
  return undefined
}

export function planKeyChord(parts: string[]): { modifiers: number[]; keys: number[] } {
  if (parts.length === 0) throw new Error('Key chord is empty; no input was sent.')
  const modifiers: number[] = []
  const keys: number[] = []
  for (const part of parts) {
    const vk = vkForKey(part)
    if (vk === undefined) {
      throw new Error(`Unknown or unsupported key "${part}"; no input was sent.`)
    }
    if (MODIFIER_KEYS.has(part.toLowerCase())) modifiers.push(vk)
    else keys.push(vk)
  }
  return { modifiers, keys }
}

async function sendInputChord(parts: string[], hwnd?: number): Promise<void> {
  const { modifiers, keys } = planKeyChord(parts)
  const modifierArgs = `@(${modifiers.join(',')})`
  const keyArgs = `@(${keys.join(',')})`
  await sendAtomicInput(`${KEYBOARD_TYPES}
${hwnd === undefined ? `${INPUT_INTEGRITY_TYPES}\n[CuInputIntegrity]::RequireForeground()` : requireForegroundScript(hwnd)}
${expectedEscapeScript(parts)}[CuKeyboard]::Chord([int[]]${modifierArgs}, [int[]]${keyArgs})
`)
}

/**
 * Suppress the Escape the model is about to inject, without ignoring a user's
 * injected Escape. The timestamp is written by the same PowerShell process
 * immediately before keybd_event — not when the tool call starts — so the
 * foreground guard/Add-Type startup cannot consume the 3s expectation
 * window. Any chord containing Escape is covered (shift+escape, alt+escape…).
 */
function expectedEscapeScript(parts: readonly string[]): string {
  if (!isWin32EscHotkeyRegistered()) return ''
  if (!parts.some(part => {
    const lower = part.toLowerCase()
    return lower === 'escape' || lower === 'esc'
  })) return ''
  const path = getWin32EscExpectFile().replace(/'/g, "''")
  const tmp = `${path}.tmp`
  return `try { $tmp = '${tmp}'; [IO.File]::WriteAllText($tmp, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()); if ([IO.File]::Exists('${path}')) { [IO.File]::Delete('${path}') }; [IO.File]::Move($tmp, '${path}') } catch {};\n`
}

function unicodePowerShellScript(_text: string, hwnd?: number): string {
  return `${KEYBOARD_TYPES}
$encoded = [Console]::In.ReadToEnd()
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encoded))
${hwnd === undefined ? `${INPUT_INTEGRITY_TYPES}\n[CuInputIntegrity]::RequireForeground()` : requireForegroundScript(hwnd)}
[CuKeyboard]::Unicode($text)
`
}

async function sendInputUnicode(text: string, hwnd?: number, signal?: AbortSignal): Promise<void> {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  await runComputerUsePowerShell(unicodePowerShellScript(text, hwnd), 15_000, encoded, signal)
}

function wheelDelta(amount: number, direction: 'vertical' | 'horizontal'): number {
  return direction === 'vertical' ? -amount * 120 : amount * 120
}

async function sendInputScroll(
  hwnd: number,
  x: number | undefined,
  y: number | undefined,
  amount: number,
  direction: 'vertical' | 'horizontal',
): Promise<void> {
  const flag = direction === 'vertical' ? '0x0800' : '0x1000'
  const position = x === undefined || y === undefined ? '' : `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuScrollRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object CuScrollRect+RECT
if (-not [CuScrollRect]::GetWindowRect([IntPtr]${hwnd}, [ref]\$r)) { throw 'GetWindowRect failed before scroll' }
if (-not [CuWin32]::SetCursorPos(${Math.round(x)} + \$r.L, ${Math.round(y)} + \$r.T)) { throw 'SetCursorPos failed before scroll' }
`
  await sendAtomicInput(`${WIN32_TYPES}
${requireForegroundScript(hwnd)}
[CuWin32]::SetProcessDPIAware() | Out-Null
${position}
if (-not [CuGuard]::IsFg([IntPtr]${hwnd})) { throw 'Foreground changed immediately before scroll' }
[CuInputIntegrity]::RequireForeground()
[CuInputIntegrity]::RequireAtCursor()
[CuWin32]::mouse_event(${flag}, 0, 0, ${wheelDelta(amount, direction)}, [IntPtr]::Zero)
`)
}

const input: InputPlatform = {
  async moveMouse(x, y) {
    if (boundHwnd) {
      // Pure positioning — no click. Liveness only (dead binding must error
      // instead of silently no-op'ing); a physical cursor move is harmless.
      await guardBoundWindow(false)
      if (realMouseChannel()) {
        // Chromium / self-drawn windows ignore SendMessage mouse — move the
        // physical cursor instead.
        await sendInputMove(boundHwnd, x, y)
      } else {
        await ensureSendAccess()
        if (!await getWm().sendMouseMove(boundHwnd, Math.round(x), Math.round(y), boundPid ?? undefined)) {
          throw new Error('Window mouse-move dispatch failed; no fallback was attempted.')
        }
      }
      return
    }
    await sendAtomicInput(`${WIN32_TYPES}; [CuWin32]::SetProcessDPIAware() | Out-Null; if (-not [CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})) { throw 'SetCursorPos failed during mouse move' }`)
  },

  async click(x, y, button, count = 1) {
    if (!Number.isInteger(count) || count < 1 || count > 3) {
      throw new Error('Click count must be an integer from 1 to 3; no input was sent.')
    }
    if (boundHwnd) {
      // Multi-click needs the real system click counter; background messages
      // remain limited to single-click delivery.
      const realInput = count > 1 || realMouseChannel()
      await guardBoundWindow(realInput)
      if (realInput) {
        await sendInputClick(boundHwnd, x, y, button, count)
        return
      }
      await ensureSendAccess()
      if (!await getWm().sendClick(boundHwnd, Math.round(x), Math.round(y), button, boundPid ?? undefined)) {
        throw new Error('Window click dispatch failed; no fallback was attempted.')
      }
      return
    }
    const downFlag = button === 'left' ? '0x0002' : button === 'right' ? '0x0008' : '0x0020'
    const upFlag = button === 'left' ? '0x0004' : button === 'right' ? '0x0010' : '0x0040'
    await sendAtomicInput(`${WIN32_TYPES}
${INPUT_INTEGRITY_TYPES}
[CuWin32]::SetProcessDPIAware() | Out-Null
if (-not [CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})) { throw 'SetCursorPos failed before click' }
Start-Sleep -Milliseconds 20
for ($i = 0; $i -lt ${count}; $i++) {
    [CuInputIntegrity]::RequireAtCursor()
    [CuWin32]::mouse_event(${downFlag}, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [CuWin32]::mouse_event(${upFlag}, 0, 0, 0, [IntPtr]::Zero)
    if ($i + 1 -lt ${count}) { Start-Sleep -Milliseconds 30 }
}
`)
  },

  async mouseDown(x, y) {
    if (!boundHwnd) {
      mouseDownUsedRealInput = true
      await sendInputButton(undefined, x, y, 'left', 'down')
      return
    }
    const realInput = realMouseChannel()
    await guardBoundWindow(realInput)
    if (realInput) {
      mouseDownUsedRealInput = true
      await sendInputButton(boundHwnd, x, y, 'left', 'down')
      return
    }
    await ensureSendAccess()
    mouseDownUsedRealInput = false
    if (!await getWm().sendMouseButton(boundHwnd, Math.round(x), Math.round(y), 'left', 'down', boundPid ?? undefined)) {
      throw new Error('Window mouse-down dispatch failed; button state may be unchanged.')
    }
  },

  async mouseUp(x, y) {
    if (desktopState() !== 'ready' || windowsActionSignal.getStore()?.aborted) {
      if (mouseDownUsedRealInput === true) {
        inputReleasePendingAfterTurn = true
        throw new Error('The Windows input desktop is unavailable. The physical mouse release will be retried when it is ready.')
      }
      return
    }
    if (!boundHwnd) {
      await sendInputButton(undefined, x, y, 'left', 'up')
      mouseDownUsedRealInput = null
      return
    }
    const realInput = mouseDownUsedRealInput ?? realMouseChannel()
    if (realInput) {
      // Physical release is cleanup: no foreground or window-rect check.
      await sendInputButton(boundHwnd, x, y, 'left', 'up')
    } else if (!await getWm().sendMouseButton(boundHwnd, Math.round(x), Math.round(y), 'left', 'up', boundPid ?? undefined)) {
      throw new Error('Window mouse-up dispatch failed; the button may still be held. Inspect the target before retrying.')
    }
    mouseDownUsedRealInput = null
  },

  async drag(from, to, durationMs) {
    if (!boundHwnd) {
      await sendInputDrag(undefined, from.x, from.y, to.x, to.y, durationMs)
      return
    }
    const realInput = realMouseChannel()
    await guardBoundWindow(realInput)
    if (realInput) {
      await sendInputDrag(boundHwnd, from.x, from.y, to.x, to.y, durationMs)
      return
    }
    await ensureSendAccess()
    if (!await getWm().sendDrag(boundHwnd, Math.round(from.x), Math.round(from.y), Math.round(to.x), Math.round(to.y), durationMs, boundPid ?? undefined)) {
      throw new Error('Window drag dispatch failed; the gesture may be partial. Do not retry blindly.')
    }
  },

  async typeText(text, signal) {
    // COM-controlled apps: write directly via COM API
    if (boundAppType === 'word' && boundFilePath) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { appendText } = require('../win32/comWord.js') as typeof import('../win32/comWord.js')
      if (!(await appendText(boundFilePath, text))) {
        throw new Error('Word COM text dispatch failed; the document may be partially updated. Inspect it before retrying.')
      }
      return
    }
    // WM_CHAR is not reliable for Unicode text, including native EDIT controls.
    // Use the same verified SendInput path for every bound window.
    if (boundHwnd) {
      await guardBoundWindow(true)
      await sendInputUnicode(text, boundHwnd, signal)
      return
    }
    await sendInputUnicode(text, undefined, signal)
  },

  async key(name, action) {
    const vk = vkForKey(name)
    if (vk === undefined) throw new Error(`Unknown or unsupported key "${name}"; no input was sent.`)
    if (action === 'release') {
      if (desktopState() !== 'ready') {
        pendingKeyReleases.add(vk)
        return
      }
      if (boundHwnd && !realKeyboardChannel()) {
        try { await windowsActionSignal.exit(() => getWm().sendKey(boundHwnd!, vk, 'up', boundPid ?? undefined)) } catch {}
      }
      if (windowsActionSignal.getStore()?.aborted) {
        pendingKeyReleases.add(vk)
        return
      }
      // Always attempt the physical release too; key-up is idempotent and must
      // not depend on the target still being foreground or alive.
      try {
        await psAsync(`${WIN32_TYPES}; [CuWin32]::keybd_event([byte]${vk}, 0, 2, [UIntPtr]::Zero)`)
        pendingKeyReleases.delete(vk)
      } catch (error) {
        pendingKeyReleases.add(vk)
        throw error
      }
      return
    }
    if (boundHwnd) {
      if (!realKeyboardChannel()) {
        await guardBoundWindow(false)
        await ensureSendAccess()
        if (!await getWm().sendKey(boundHwnd, vk, 'down', boundPid ?? undefined)) {
          throw new Error(`Window key ${action} dispatch failed for "${name}".`)
        }
        return
      }
      await guardBoundWindow(true)
      await sendAtomicInput(`${WIN32_TYPES}
${requireForegroundScript(boundHwnd)}
${expectedEscapeScript([name])}[CuWin32]::keybd_event([byte]${vk}, 0, 0, [UIntPtr]::Zero)`)
      return
    }
    await sendAtomicInput(`${WIN32_TYPES}
${INPUT_INTEGRITY_TYPES}
[CuInputIntegrity]::RequireForeground()
${expectedEscapeScript([name])}[CuWin32]::keybd_event([byte]${vk}, 0, 0, [UIntPtr]::Zero)`)
  },

  async keys(parts) {
    const chord = planKeyChord(parts)
    if (boundHwnd) {
      // Return/Tab need the focused control, which may have its own HWND.
      const needsRealChord = chord.modifiers.length > 0 || chord.keys.includes(VK_MAP.return) || chord.keys.includes(VK_MAP.tab)
      if (!realKeyboardChannel() && !needsRealChord) {
        await guardBoundWindow(false)
        await ensureSendAccess()
        if (!await getWm().sendKeys(boundHwnd, parts, boundPid ?? undefined)) {
          throw new Error('Window key-chord arguments are invalid; no fallback was attempted.')
        }
        return
      }
      await guardBoundWindow(true)
      await sendInputChord(parts, boundHwnd)
      return
    }
    await sendInputChord(parts)
  },

  async scroll(amount, direction, x, y) {
    if (boundHwnd) {
      if (realMouseChannel()) {
        await guardBoundWindow(true)
        await sendInputScroll(boundHwnd, x, y, amount, direction)
        return
      }
      await guardBoundWindow(false)
      await ensureSendAccess()
      await getWm().sendScroll(boundHwnd, amount, direction, boundPid ?? undefined)
      return
    }
    const flag = direction === 'vertical' ? '0x0800' : '0x1000' // MOUSEEVENTF_WHEEL / MOUSEEVENTF_HWHEEL
    const position = x === undefined || y === undefined ? '' : `if (-not [CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})) { throw 'SetCursorPos failed before scroll' }; `
    await sendAtomicInput(`${WIN32_TYPES}
${INPUT_INTEGRITY_TYPES}
[CuWin32]::SetProcessDPIAware() | Out-Null
${position}[CuInputIntegrity]::RequireAtCursor()
[CuInputIntegrity]::RequireForeground()
[CuWin32]::mouse_event(${flag}, 0, 0, ${wheelDelta(amount, direction)}, [IntPtr]::Zero)`)
  },

  async mouseLocation() {
    const windowOffset = boundHwnd
      ? `$r = New-Object CuWin32+RECT; if (-not [CuWin32]::GetWindowRect([IntPtr]${boundHwnd}, [ref]$r)) { throw 'GetWindowRect failed while reading cursor position' }; `
      : ''
    const output = boundHwnd ? '$($p.X - $r.L),$($p.Y - $r.T)' : '$($p.X),$($p.Y)'
    const out = await psAsync(`${WIN32_TYPES}; [CuWin32]::SetProcessDPIAware() | Out-Null; $p = New-Object CuWin32+POINT; if (-not [CuWin32]::GetCursorPos([ref]$p)) { throw 'GetCursorPos failed' }; ${windowOffset}"${output}"`)
    const [xStr, yStr] = out.split(',')
    if (![xStr, yStr].every(value => Number.isFinite(Number(value)))) {
      throw new Error(`Invalid cursor position: ${out}`)
    }
    return { x: Number(xStr), y: Number(yStr) }
  },

  async sendChar(hwnd, char) { await getWm().sendChar(Number(hwnd), char) },
  async sendKey(hwnd, vk, action) { await getWm().sendKey(Number(hwnd), vk, action) },
  async sendMouseMove(hwnd, x, y) { await getWm().sendMouseMove(Number(hwnd), x, y) },
  async sendClick(hwnd, x, y, button) { await getWm().sendClick(Number(hwnd), x, y, button) },
  async sendText(hwnd, text) { await getWm().sendText(Number(hwnd), text) },
}

// ---------------------------------------------------------------------------
// Screenshot — JPEG output only
// ---------------------------------------------------------------------------

/**
 * Downscale a captured screenshot to target dimensions via PowerShell/.NET.
 * Preserves original physical dimensions as displayWidth/displayHeight so
 * scaleCoord maps downsampled coords back to physical space correctly.
 */
function fitCaptureDimensions(srcW: number, srcH: number, maxW: number, maxH: number): [number, number] {
  const scale = Math.min(maxW / srcW, maxH / srcH, 1)
  return [Math.max(1, Math.round(srcW * scale)), Math.max(1, Math.round(srcH * scale))]
}

async function downscaleCapture(
  src: ScreenshotResult,
  targetW: number,
  targetH: number,
): Promise<ScreenshotResult> {
  if (!src.base64 || src.width === targetW && src.height === targetH) return src
  const base64 = await runComputerUsePowerShell(`
Add-Type -AssemblyName System.Drawing
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$inputStream = [System.IO.MemoryStream]::new($inputBytes)
$source = [System.Drawing.Image]::FromStream($inputStream)
$resized = [System.Drawing.Bitmap]::new(${targetW}, ${targetH})
$graphics = [System.Drawing.Graphics]::FromImage($resized)
$graphics.InterpolationMode = 7
$graphics.DrawImage($source, 0, 0, ${targetW}, ${targetH})
$graphics.Dispose()
$source.Dispose()
$inputStream.Dispose()
$output = [System.IO.MemoryStream]::new()
$resized.Save($output, [System.Drawing.Imaging.ImageFormat]::Jpeg)
[Convert]::ToBase64String($output.ToArray())
$output.Dispose()
$resized.Dispose()
`, 8000, src.base64)
  return {
    base64,
    width: targetW,
    height: targetH,
    displayWidth: src.displayWidth ?? src.width,
    displayHeight: src.displayHeight ?? src.height,
    originX: src.originX,
    originY: src.originY,
    displayId: src.displayId,
    displayCount: src.displayCount,
    captureMode: src.captureMode,
    targetRevision: src.targetRevision,
  }
}

const screenshot = {
  async captureScreen(displayId?: number, targetW?: number, targetH?: number, fitForApi = false) {
    if (boundHwnd) {
      const result = await captureWindowByHwnd(boundHwnd, boundPid ?? undefined)
      if (!result) throw new Error('The bound window did not produce an image.')
      result.displayId = displayId ?? 0
      result.captureMode = 'bound_window'
      if (targetW && targetH) {
        const fitted = fitCaptureDimensions(result.width, result.height, targetW, targetH)
        return downscaleCapture(result, fitted[0], fitted[1])
      }
      return result
    }
    return captureDisplay(displayId, targetW, targetH, fitForApi)
  },

  async captureRegion(x, y, w, h, origin = { x: 0, y: 0 }) {
    // handleZoom's image-px→logical ratio produces non-integers (e.g.
    // 1106.0266). .NET Bitmap/CopyFromScreen ctors take ints and the PS
    // script dies on the double literals — round before interpolation.
    const rx = Math.round(x), ry = Math.round(y), rw = Math.round(w), rh = Math.round(h)
    // When HWND is bound, crop from cached full-window screenshot (avoids PrintWindow on every zoom)
    if (boundHwnd) {
      const now = Date.now()
      if (!cachedScreenshot || (now - cachedScreenshot.ts) > SCREENSHOT_CACHE_TTL) {
        const revision = bindingRevision
        const full = await captureWindowByHwnd(boundHwnd, boundPid ?? undefined)
        if (bindingRevision !== revision) throw new Error('The capture target changed during zoom. Take a fresh screenshot.')
        if (full) {
          cachedScreenshot = { ...full, ts: now }
        }
      }
      if (cachedScreenshot) {
        return cropScreenshot(cachedScreenshot, rx, ry, rw, rh)
      }
      throw new Error('Bound-window zoom capture failed; no full-screen fallback was used because its coordinate space would differ.')
    }
    // Unbound zoom uses the origin of the screenshot being inspected.
    const screenX = rx + origin.x
    const screenY = ry + origin.y
    const base64 = await runPowerShell(`
${DPI_AWARE_PS}
Add-Type -AssemblyName System.Drawing
$size = [System.Drawing.Size]::new(${rw}, ${rh})
$bmp = [System.Drawing.Bitmap]::new(${rw}, ${rh})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${screenX}, ${screenY}, 0, 0, $size)
$g.Dispose()
$stream = [System.IO.MemoryStream]::new()
$bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
[Convert]::ToBase64String($stream.ToArray())
$stream.Dispose()
$bmp.Dispose()
`)
    return { base64, width: rw, height: rh, displayWidth: rw, displayHeight: rh, originX: screenX, originY: screenY }
  },

} satisfies ScreenshotPlatform

async function captureDisplay(displayId?: number, targetW?: number, targetH?: number, fitForApi = false): Promise<ScreenshotResult> {
  const displays = enumerateDisplays()
  const monitor = displays.find(item => item.displayId === displayId) ?? displays.find(item => item.isPrimary) ?? displays[0]!
  const { originX = 0, originY = 0, width, height } = monitor
  const [outputW, outputH] = fitForApi
    ? targetImageSize(width, height, API_RESIZE_PARAMS)
    : [Math.round(targetW ?? width), Math.round(targetH ?? height)]
  const resize = outputW === width && outputH === height ? '' : `
    $resized = [System.Drawing.Bitmap]::new(${outputW}, ${outputH})
    $rg = [System.Drawing.Graphics]::FromImage($resized)
    $rg.InterpolationMode = 7
    $rg.DrawImage($bmp, 0, 0, ${outputW}, ${outputH})
    $rg.Dispose()
    $bmp.Dispose()
    $bmp = $resized
  `
  const base64 = await runPowerShell(`
${DPI_AWARE_PS}
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::new(${width}, ${height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${originX}, ${originY}, 0, 0, [System.Drawing.Size]::new(${width}, ${height}))
$g.Dispose()
${resize}
$stream = [System.IO.MemoryStream]::new()
$bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
[Convert]::ToBase64String($stream.ToArray())
$stream.Dispose()
$bmp.Dispose()
`)
  return { base64, width: outputW, height: outputH, displayWidth: width, displayHeight: height,
    originX, originY, displayCount: displays.length, displayId: monitor.displayId, captureMode: 'full_display' }
}

export async function captureScreenForApi(displayId?: number, allowDisplayFallback = false): Promise<ScreenshotResult> {
  const captureRevision = bindingRevision
  const hwnd = boundHwnd
  if (hwnd) {
    let shot: ScreenshotResult | undefined
    try {
      shot = await screenshot.captureScreen(displayId)
    } catch (error) {
      windowsActionSignal.getStore()?.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      if (!allowDisplayFallback || bindingRevision !== captureRevision) throw error
      await releaseWindowsMouseAfterTurn()
      windowsActionSignal.getStore()?.throwIfAborted()
      if (bindingRevision !== captureRevision || inputReleasePendingAfterTurn) throw error
      displayId = monitorForWindow(hwnd) ?? displayId
      unbindWindow('capture_unavailable')
    }
    if (shot) {
      const [width, height] = targetImageSize(shot.width, shot.height, API_RESIZE_PARAMS)
      const resized = await downscaleCapture(shot, width, height)
      if (bindingRevision !== captureRevision) throw new Error('The capture target changed during the screenshot. Take a fresh screenshot.')
      return { ...resized, targetRevision: captureRevision }
    }
  }
  const revision = bindingRevision
  const shot = await screenshot.captureScreen(displayId, undefined, undefined, true)
  if (bindingRevision !== revision) throw new Error('The capture target changed while the screenshot was in progress. The old image was discarded; take a fresh screenshot.')
  return { ...shot, targetRevision: revision }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const display: DisplayPlatform = {
  listAll(): DisplayInfo[] {
    return enumerateDisplays().map(({ handle: _handle, ...monitor }) => monitor)
  },

  getSize(displayId): DisplayInfo {
    const all = this.listAll()
    if (displayId !== undefined) {
      const found = all.find(d => d.displayId === displayId)
      if (found) return found
    }
    if (all.length === 0) throw new Error('No Windows displays were enumerated')
    return all.find(item => item.isPrimary) ?? all[0]!
  },
}

// ---------------------------------------------------------------------------
// Apps — EnumWindows + registry + AppxPackage
// ---------------------------------------------------------------------------

function isAbsoluteExe(path: string | null): boolean {
  return path !== null && windowsPath.isAbsolute(path) && /\.exe$/i.test(path)
}

function comparableExePath(path: string): string {
  return windowsPath.normalize(path).toLowerCase()
}

function windowIdentity(window: { hwnd: number; pid: number }): string {
  return `${window.hwnd}:${window.pid}`
}

export function listWindowsWithIdentity(visibleOnly = true): WindowsWindow[] {
  return listWindowDetails(visibleOnly).map(({ path, ...window }) => ({
    ...window,
    bundleId: path,
    windowId: windowIdentity(window),
  }))
}

export async function activateWindowsWindow(window: WindowsWindow, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const candidate = listWindowDetails(false).find(item => item.hwnd === window.hwnd && item.pid === window.pid)
  if (!candidate?.path || comparableExePath(candidate.path) !== comparableExePath(window.bundleId)) {
    throw new Error('The selected window changed. Refresh list_windows before activating it.')
  }
  signal?.throwIfAborted()
  const activated = await activateObservedWindow(candidate.hwnd, candidate.pid, signal)
  if (activated) explicitlyActivatedPid = candidate.pid
  return activated
}

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

  async open(name, signal, windowId) {
    signal?.throwIfAborted()
    const exactExe = isAbsoluteExe(name)
    const appType = detectAppType(name)
    if (!exactExe && !windowId && (appType === 'excel' || appType === 'word')) {
      const result = await openWithController(name)
      signal?.throwIfAborted()
      if (result.filePath) bindFile(result.filePath, result.type, name)
      return
    }

    const escaped = name.replace(/'/g, "''")
    const base = windowsPath.basename(name).replace(/\.exe$/i, '').trim()
    const windows = listWindows(exactExe)
    const candidatePids = !exactExe && base ? getPidsForProcessName(base) : []
    const matchingWindows = windows.filter(window => exactExe
      ? window.path && comparableExePath(window.path) === comparableExePath(name)
      : candidatePids.includes(window.pid))
    const candidate = windowId
      ? matchingWindows.find(window => exactExe && windowIdentity(window) === windowId)
      : matchingWindows[0]
    if (windowId && !candidate) {
      throw new Error('The selected window no longer matches the granted executable. Refresh list_granted_applications before opening it.')
    }
    if (candidate) {
      bindWindow(candidate.hwnd, candidate.pid, base, name)
      await activateObservedWindow(candidate.hwnd, candidate.pid, signal)
      await prepareWindowsTarget(signal)
      return
    }

    // ── Launch: 1) exact path 2) PATH 3) registry 4) UWP 5) raw name ──
    const result = await runPowerShell(`
${WIN32_TYPES}
${exactExe ? PROCESS_IMAGE_PS : ''}
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
$exactExe = $${exactExe}
$proc = $null
$launchPath = ''

${START_CU_APPLICATION}

# 1. Exact file path
if (Test-Path -LiteralPath $target) {
    ${buildPortableAppLaunchBlock()}
}

if (-not $exactExe) {
# 2. exe name in PATH (e.g. "notepad.exe", "code.exe") — .exe results only
if (-not $proc) {
    foreach ($name in @($target, "$target.exe")) {
        $found = Get-Command $name -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -and $_.Source.EndsWith('.exe') } |
            Select-Object -First 1
        if ($found) {
            ${buildPortableAppLaunchBlock('$found.Source')}
            if ($proc) { break }
        }
    }
}

# 3. App Paths registry (HKCU/HKLM) — Store apps + portable installs
if (-not $proc) {
    foreach ($name in @("$target.exe", $target)) {
        foreach ($hive in @('HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
            $ap = Get-ItemProperty (Join-Path $hive $name) -ErrorAction SilentlyContinue
            if ($ap -and $ap.'(default)' -and (Test-Path -LiteralPath $ap.'(default)')) {
                ${buildPortableAppLaunchBlock("$ap.'(default)'")}
                if ($proc) { break }
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
            if ($exes) { ${buildPortableAppLaunchBlock('$exes.FullName')}; break }
        }
    }
}

# 5. UWP/Store app — direct AppID first, then display-name match
if (-not $proc) {
    $sapp = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.AppID -eq $target } | Select-Object -First 1
    if (-not $sapp) {
        $sapp = Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -match [regex]::Escape($target) } | Select-Object -First 1
    }
    if ($sapp) { $proc = Start-CuApplication "shell:AppsFolder\$($sapp.AppID)" }
}

# 6. Last resort: try raw name
if (-not $proc) { $proc = Start-CuApplication $target; if ($proc) { $launchPath = $target } }

}

if (-not $proc) { Write-Host "LAUNCH_FAILED"; exit }

# Wait for a window: 1) the new PID  2) any PID whose process name matches the
# launched exe's base for shell identities (single-instance/UWP handoff).
# Complete exe paths are matched only by process image.
$hint = if ($launchPath -like '*\\*') { [System.IO.Path]::GetFileNameWithoutExtension($launchPath) } else { '${base.replace(/'/g, "''")}' }
$hwnd = 0
$hwndPid = 0
for ($i = 0; $i -lt 50 -and $hwnd -eq 0; $i++) {
    Start-Sleep -Milliseconds 200
    [CuLaunch]::ListWindows()
    if ($exactExe) {
        foreach ($c in [CuLaunch]::windows) {
            $parts = $c.Split('|')
            $wp = [uint32]$parts[1]
            $image = [CuProcessImage]::Get($wp)
            if ([string]::Equals($image, $launchPath, [StringComparison]::OrdinalIgnoreCase)) {
                $hwnd = [long]$parts[0]; $hwndPid = $wp; break
            }
        }
        continue
    }
    foreach ($c in [CuLaunch]::windows) {
        $parts = $c.Split('|')
        $wp = [uint32]$parts[1]
        if ($wp -eq [uint32]$proc.Id) { $hwnd = [long]$parts[0]; $hwndPid = $wp; break }
    }
    if ($hwnd -eq 0 -and -not [string]::IsNullOrEmpty($hint)) {
        $namePids = @(Get-Process -Name $hint -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
        foreach ($c in [CuLaunch]::windows) {
            $parts = $c.Split('|')
            $wp = [uint32]$parts[1]
            if ($namePids -contains $wp) { $hwnd = [long]$parts[0]; $hwndPid = $wp; break }
        }
    }
}
if ($hwnd -eq 0) { Write-Host "HWND_NOT_FOUND|$($proc.Id)"; exit }
$exePath = ''
try { $exePath = (Get-Process -Id $hwndPid -ErrorAction SilentlyContinue).Path } catch {}
if (-not $exePath) { $exePath = $launchPath }
Write-Host "$hwnd|$hwndPid|$exePath"
`, 60_000, undefined, signal)
    signal?.throwIfAborted()
    if (!result || result.startsWith('LAUNCH_FAILED')) {
      throw new Error(
        `Failed to open "${name}": no launchable executable was found for it. ` +
          'It may be installed under a different name — request it via ' +
          'request_access with the exact display name shown in the available ' +
          'applications list, or pass its full executable path.',
      )
    }
    if (result.startsWith('HWND_NOT_FOUND')) {
      if (exactExe) {
        throw new Error(`Launched "${name}" but no window belonging to that executable appeared within 10s. If it opened another application, request access to that application's executable before binding its window.`)
      }
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
      bindWindow(hwnd, pid, exeBase || undefined, name)
      await activateObservedWindow(hwnd, pid, signal)
      await prepareWindowsTarget(signal)
    }
  },

  getAppAtPoint: targetAtPoint,

  getFrontmostApp: foregroundTarget,

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

export const _test = {
  planKeyChord,
  fitCaptureDimensions,
  clickPowerShellScript,
  unicodePowerShellScript,
  wheelDelta,
  vkForKey,
  shouldLeaveBoundForNewForeground,
  isComputerUseTransientForeground,
}

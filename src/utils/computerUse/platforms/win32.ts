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
/** Track whether SendMessage is working for the bound window (UIPI check) */
let sendMessageOk: boolean | null = null
/** Track whether the bound window is Chromium-based (Electron/CEF/Chrome).
 *  Chromium apps ignore SendMessage mouse events — must use SetCursorPos + mouse_event instead. */
let isChromium: boolean = false

/** Get the bound HWND, or null if not bound */
export function getBoundHwnd(): number | null { return boundHwnd }

/** Get the bound app type */
export function getBoundAppType(): string | null { return boundAppType }

/** Get the bound file path (for COM-controlled apps) */
export function getBoundFilePath(): string | null { return boundFilePath }

/** Bind to a window HWND — all subsequent input/screenshot operations target this handle */
export function bindWindow(hwnd: number, pid?: number): void {
  // Unmark previous window if any
  if (boundHwnd) unmarkBound(boundHwnd)
  boundHwnd = hwnd
  boundPid = pid ?? null
  boundAppType = 'generic'
  boundFilePath = null
  // Reset SendMessage status — will be checked on first operation
  sendMessageOk = null
  // Detect Chromium-based windows (Electron/CEF) — need SetCursorPos + mouse_event instead of SendMessage
  isChromium = detectChromium(hwnd)
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
  sendMessageOk = null
  isChromium = false
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
// Chromium detection: check if bound window is Electron/CEF/Chrome
// ---------------------------------------------------------------------------

/** Chromium child window class name prefixes (case-insensitive) */
const CHROMIUM_CLASSES = ['Chrome_RenderWidgetHostHWND', 'Chrome_WidgetWin_']

/**
 * Detect whether a window belongs to a Chromium-based app (Electron/CEF/Chrome).
 * Enumerates child windows and checks for known Chromium class names.
 * Returns true if any child matches.
 */
function detectChromium(hwnd: number): boolean {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class CuChromium {
    public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc proc, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public static List<string> classNames = new List<string>();
    public static void Find(IntPtr parent) {
        classNames.Clear();
        EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam) {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, sb.Capacity);
            classNames.Add(sb.ToString());
            return true;
        }, IntPtr.Zero);
    }
}
'@
[CuChromium]::SetProcessDPIAware() | Out-Null
[CuChromium]::Find([IntPtr]${hwnd})
[CuChromium]::classNames | ForEach-Object { $_ }
`
  const raw = ps(script)
  if (!raw) return false
  const classes = raw.split('\n').map(s => s.trim()).filter(Boolean)
  return classes.some(cls =>
    CHROMIUM_CLASSES.some(prefix => cls.startsWith(prefix))
  )
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
// Input — ALL text/key input goes through SendMessage when HWND is bound.
// Global SetCursorPos/mouse_event/keybd_event is DISABLED to avoid interfering with user.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Input — When HWND is bound, ALL operations go through SendMessage.
// NO global API (SetCursorPos/mouse_event/keybd_event/SendKeys) is used.
// This ensures the user's desktop is never disturbed.
// EXCEPTION: Chromium-based windows (Electron/CEF) ignore SendMessage mouse events,
// so we use SetCursorPos + mouse_event with screen coordinates for those.
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

const input: InputPlatform = {
  async moveMouse(x, y) {
    if (boundHwnd) {
      if (isChromium) {
        // Chromium windows ignore SendMessage mouse — use SetCursorPos + mouse_event with screen coordinates
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
      if (isChromium) {
        // Chromium windows ignore SendMessage mouse — use SetCursorPos + mouse_event with screen coordinates
        sendInputClick(boundHwnd, x, y, button)
        return
      }
      if (ensureSendAccess()) {
        getWm().sendClick(boundHwnd, Math.round(x), Math.round(y), button)
        return
      }
      // UIPI blocked — fall back to global SetCursorPos + mouse_event with screen coordinates
      sendInputClick(boundHwnd, x, y, button)
      return
    }
    const downFlag = button === 'left' ? '0x0002' : button === 'right' ? '0x0008' : '0x0020'
    const upFlag = button === 'left' ? '0x0004' : button === 'right' ? '0x0010' : '0x0040'
    ps(`${WIN32_TYPES}; [CuWin32]::SetProcessDPIAware() | Out-Null; [CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null; Start-Sleep -Milliseconds 20; [CuWin32]::mouse_event(${downFlag}, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 50; [CuWin32]::mouse_event(${upFlag}, 0, 0, 0, [IntPtr]::Zero)`)
  },

  async typeText(text) {
    // COM-controlled apps: write directly via COM API
    if (boundAppType === 'word' && boundFilePath) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { appendText } = require('../win32/comWord.js') as typeof import('../win32/comWord.js')
      appendText(boundFilePath, text)
      return
    }
    // HWND-bound apps: try SendMessage first, fall back to global input if UIPI blocks
    if (boundHwnd) {
      if (ensureSendAccess()) {
        getWm().sendText(boundHwnd, text)
        return
      }
      // UIPI blocked — fall back to global keybd_event
      // Bring window to foreground first
      ps(`${WIN32_TYPES}
$hwnd = [IntPtr]${boundHwnd}
# Try SetForegroundWindow — works if our IL >= target IL after the first attempt
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuFg { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
'@
[CuFg]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 100
`)
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
      if (ensureSendAccess()) {
        const lower = name.toLowerCase()
        const vk = VK_MAP[lower] ?? (name.length === 1 ? name.charCodeAt(0) : 0)
        if (vk) getWm().sendKey(boundHwnd, vk, action === 'release' ? 'up' : 'down')
        return
      }
      // UIPI blocked — fall back to global keybd_event
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
      if (ensureSendAccess()) {
        getWm().sendKeys(boundHwnd, parts)
        return
      }
      // UIPI blocked — fall back to global keybd_event for each key
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
      if (isChromium) {
        // Chromium windows may not respond to WM_VSCROLL — use mouse_event MOUSEEVENTF_WHEEL
        const flag = direction === 'vertical' ? '0x0800' : '0x1000' // MOUSEEVENTF_WHEEL / MOUSEEVENTF_HWHEEL
        ps(`${WIN32_TYPES}; [CuWin32]::SetProcessDPIAware() | Out-Null; [CuWin32]::mouse_event(${flag}, 0, 0, ${amount * 120}, [IntPtr]::Zero)`)
        return
      }
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
    try {
      const raw = await psAsync(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$apps = @()

# Traditional Win32 apps from registry
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($p in $paths) {
  Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object {
    $apps += "$($_.DisplayName)|$($_.InstallLocation)|$($_.PSChildName)"
  }
}

# UWP/MSIX apps (Windows 10/11 Store apps)
Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.IsFramework -eq $false -and $_.SignatureKind -eq 'Store' } | ForEach-Object {
  $cleanName = $_.Name -replace '^Microsoft\\.Windows', '' -replace '^Microsoft\\.', ''
  $apps += "$cleanName|$($_.InstallLocation)|$($_.PackageFamilyName)"
}

# Start menu shortcuts (catches non-registry installs like portable apps)
$shortcutPaths = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "C:\\Users\\Public\\Desktop"
)
foreach ($smp in $shortcutPaths) {
  Get-ChildItem $smp -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($_.FullName)
    if ($lnk.TargetPath -and $lnk.TargetPath.EndsWith('.exe')) {
      $name = $_.BaseName
      $target = $lnk.TargetPath
      $apps += "$name|$target|$target"
    }
  }
}

# Also check Get-StartApps for any remaining entries
Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.AppID -like '*:\\*' } | ForEach-Object {
  $name = $_.Name
  $target = $_.AppID
  $apps += "$name|$target|$target"
}

$apps | Select-Object -Unique
`)
      const entries = raw.split('\n').filter(Boolean).map(line => {
        const [name, path, id] = line.trim().split('|', 3)
        return {
          id: (id ?? name ?? '').trim(),
          displayName: (name ?? '').trim(),
          path: (path ?? '').trim(),
        }
      })
      // Deduplicate by displayName: prefer entries with .exe paths over
      // registry entries with empty/non-exe paths (e.g. QQ||QQ from registry
      // should lose to QQ|D:\QQ.exe|D:\QQ.exe from shortcuts).
      // When replacing, merge paths so path-based matching can find the app
      // via both the shortcut target and the registry InstallLocation.
      const byName = new Map<string, { id: string; displayName: string; path: string; extraPaths?: string[] }>()
      for (const entry of entries) {
        const key = entry.displayName.toLowerCase()
        const existing = byName.get(key)
        if (!existing) {
          byName.set(key, entry)
        } else {
          // Prefer the entry whose id is an .exe path
          const existingIsExe = existing.id.toLowerCase().endsWith('.exe')
          const newIsExe = entry.id.toLowerCase().endsWith('.exe')
          if (newIsExe && !existingIsExe) {
            // Shortcut wins over registry — keep registry's path as extraPaths
            const mergedPaths: string[] = []
            if (existing.path && existing.path !== entry.path) mergedPaths.push(existing.path)
            if (entry.path && !mergedPaths.includes(entry.path)) mergedPaths.push(entry.path)
            byName.set(key, { ...entry, extraPaths: mergedPaths.length > 0 ? mergedPaths : undefined })
          } else if (!newIsExe && existingIsExe) {
            // Registry loses to shortcut — keep registry's path as extraPaths on winner
            if (entry.path && entry.path !== existing.path) {
              const existingExtras = existing.extraPaths ?? []
              if (!existingExtras.includes(entry.path)) {
                existing.extraPaths = [...existingExtras, entry.path]
              }
            }
          }
        }
      }
      return [...byName.values()]
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

    // Text/Browser/Generic → exe launch + HWND bind (offscreen)
    const escaped = name.replace(/'/g, "''")
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
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    public const int SW_SHOWMINNOACTIVE = 7;
    public static long FindByPidOrTitle(uint targetPid, string titleHint) {
        long found = 0;
        EnumWindows((h, _) => {
            if (!IsWindowVisible(h)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid == targetPid) { found = h.ToInt64(); return false; }
            if (!string.IsNullOrEmpty(titleHint)) {
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, 256);
                if (sb.ToString().IndexOf(titleHint, StringComparison.OrdinalIgnoreCase) >= 0) {
                    found = h.ToInt64(); return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
# Priority: 1) exact path  2) exe in PATH  3) registry install location  4) UWP/Store app  5) raw name
$target = '${escaped}'
$proc = $null

# 1. Exact file path
if (Test-Path $target) {
    $proc = Start-Process $target -PassThru -ErrorAction SilentlyContinue
}

# 2. exe name in PATH (e.g. "notepad.exe", "code.exe")
if (-not $proc) {
    $found = Get-Command $target -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $proc = Start-Process $found.Source -PassThru -ErrorAction SilentlyContinue }
}

# 3. Search registry for install location by display name
if (-not $proc) {
    $regPaths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')
    foreach ($p in $regPaths) {
        $app = Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and $_.DisplayName -match [regex]::Escape($target) } | Select-Object -First 1
        if ($app -and $app.InstallLocation) {
            $exes = Get-ChildItem $app.InstallLocation -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($exes) { $proc = Start-Process $exes.FullName -PassThru -ErrorAction SilentlyContinue; break }
        }
    }
}

# 4. UWP/Store app
if (-not $proc) {
    $uwp = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match [regex]::Escape($target) } | Select-Object -First 1
    if ($uwp) { $proc = Start-Process "shell:AppsFolder\$($uwp.PackageFamilyName)!App" -PassThru -ErrorAction SilentlyContinue }
}

# 5. Last resort: try raw name
if (-not $proc) { $proc = Start-Process -FilePath $target -PassThru -ErrorAction SilentlyContinue }

if (-not $proc) { Write-Host "LAUNCH_FAILED"; exit }
# Wait for window HWND (UWP apps may have different PID)
# UWP apps (Win11 Notepad, Calculator, etc.) spawn from a different PID.
# Wait longer and search by title more aggressively.
$hint = '${escaped}'.Split('\')[-1].Replace('.exe','')
$hwnd = 0
for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 200
    $hwnd = [CuLaunch]::FindByPidOrTitle([uint32]$proc.Id, $hint)
    if ($hwnd -ne 0) { break }
}
if ($hwnd -eq 0) { Write-Host "HWND_NOT_FOUND|$($proc.Id)"; exit }
# Keep the window at its normal position — user can see and interact with it.
# PrintWindow captures work regardless of window position/occlusion.
# SendMessage uses client-area coordinates, so position doesn't matter.
Write-Host "$hwnd|$($proc.Id)"
`)
    if (!result || result.startsWith('LAUNCH_FAILED') || result.startsWith('HWND_NOT_FOUND')) {
      return
    }
    const parts = result.trim().split('|')
    const hwnd = Number(parts[0])
    const pid = Number(parts[1])
    if (hwnd > 0) {
      // Bind to the launched window — all subsequent operations target this HWND
      bindWindow(hwnd, pid)
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

/**
 * SendMessage-based input for Win32 windows.
 * All operations target a specific HWND without stealing focus or moving the mouse.
 *
 * Per-monitor-v2 DPI awareness keeps GetWindowRect/ClientToScreen in the same
 * physical pixels as the normalized PrintWindow screenshot. The native-boundary
 * helper subtracts the client offset; Windows translates message coordinates
 * for the receiving window's DPI awareness, so no second manual scale is applied.
 */

import { runComputerUsePowerShellSync as runPowerShellSync } from './elevatedPowerShell.js'

const WINMSG_TYPE = `
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinMsg {
    public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc proc, IntPtr lParam);

    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lp);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")]
    static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    public static bool SetProcessDPIAware() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4))) {
            throw new System.Exception("Per-monitor-v2 DPI awareness is required for physical-pixel input.");
        }
        return true;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    public static IntPtr MakeLParam(int lo, int hi) {
        return (IntPtr)((hi << 16) | (lo & 0xFFFF));
    }

    public static void RequireProcess(IntPtr hwnd, uint expectedPid) {
        if (expectedPid == 0) return;
        uint actualPid = 0;
        GetWindowThreadProcessId(hwnd, out actualPid);
        if (actualPid != expectedPid) {
            throw new System.Exception("Window identity changed: expected PID " + expectedPid + ", actual PID " + actualPid);
        }
    }

    public static IntPtr MakeClientLParam(IntPtr hwnd, int x, int y) {
        SetProcessDPIAware();
        RECT wr;
        if (!GetWindowRect(hwnd, out wr)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        POINT pt = new POINT { X = 0, Y = 0 };
        if (!ClientToScreen(hwnd, ref pt)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        return MakeLParam(x - (pt.X - wr.L), y - (pt.Y - wr.T));
    }

    public const uint WM_CHAR = 0x0102;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const uint WM_RBUTTONDOWN = 0x0204;
    public const uint WM_RBUTTONUP = 0x0205;
    public const uint WM_MBUTTONDOWN = 0x0207;
    public const uint WM_MBUTTONUP = 0x0208;

    public static List<string> childResults = new List<string>();

    public static void FindChildren(IntPtr parent) {
        childResults.Clear();
        EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam) {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(hWnd, sb, sb.Capacity);
            childResults.Add(hWnd.ToInt64() + "|" + sb.ToString());
            return true;
        }, IntPtr.Zero);
    }
}
'@
`

// Edit class names in priority order
const EDIT_CLASSES = [
  'RichEditD2DPT',              // Win11 Notepad
  'RichEdit20W',                // WordPad
  'Edit',                       // Classic edit controls
  'Scintilla',                  // Scintilla-based editors (Notepad++, etc.)
  'Chrome_RenderWidgetHostHWND', // Chrome/Electron
]

const VK_MAP: Record<string, number> = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  menu: 0x12,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  insert: 0x2d,
  delete: 0x2e,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73,
  f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77,
  f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
}

function runPs(script: string): string {
  return runPowerShellSync(script, 8000)
}

function requireProcess(hwnd: number, expectedPid?: number): string {
  return `[WinMsg]::RequireProcess([IntPtr]${hwnd}, ${expectedPid ?? 0})`
}

/**
 * Find the first edit-capable child window of a parent HWND.
 * Searches for known edit control class names in priority order.
 */
export function findEditChild(parentHwnd: number, expectedPid?: number): number | null {
  const script = `${WINMSG_TYPE}
${requireProcess(parentHwnd, expectedPid)}
[WinMsg]::FindChildren([IntPtr]${parentHwnd})
[WinMsg]::childResults | ForEach-Object { $_ }
`
  const raw = runPs(script)
  if (!raw) return null

  const children = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const trimmed = line.trim()
      const pipe = trimmed.indexOf('|')
      if (pipe === -1) return null
      return {
        hwnd: Number(trimmed.slice(0, pipe)),
        className: trimmed.slice(pipe + 1),
      }
    })
    .filter((item): item is { hwnd: number; className: string } => item !== null)

  // Search in priority order
  for (const editClass of EDIT_CLASSES) {
    const match = children.find(c => c.className === editClass)
    if (match) return match.hwnd
  }

  return null
}

/**
 * Send a single character to a window via WM_CHAR.
 */
export function sendChar(hwnd: number, char: string, expectedPid?: number): boolean {
  const code = char.charCodeAt(0)
  const script = `${WINMSG_TYPE}
${requireProcess(hwnd, expectedPid)}
[WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_CHAR, [IntPtr]${code}, [IntPtr]0)
`
  return runPs(script) !== null
}

/**
 * Send a string of text to a window by finding its edit child and sending WM_CHAR for each character.
 */
export function sendText(hwnd: number, text: string, expectedPid?: number): boolean {
  const editHwnd = findEditChild(hwnd, expectedPid)
  if (editHwnd === null) return false

  // Build a single PowerShell script that sends every UTF-16 code unit,
  // including both halves of a surrogate pair.
  const charLines = Array.from({ length: text.length }, (_, index) => {
    const code = text.charCodeAt(index)
    return `[WinMsg]::SendMessage([IntPtr]${editHwnd}, [WinMsg]::WM_CHAR, [IntPtr]${code}, [IntPtr]0)`
  }).join('\n')

  const script = `${WINMSG_TYPE}
${requireProcess(hwnd, expectedPid)}
${charLines}
`
  return runPs(script) !== null
}

/**
 * Send a key down or key up event via WM_KEYDOWN / WM_KEYUP.
 */
export function sendKey(hwnd: number, vk: number, action: 'down' | 'up', expectedPid?: number): boolean {
  const msg = action === 'down' ? '0x0100' : '0x0101'
  const script = `${WINMSG_TYPE}
${requireProcess(hwnd, expectedPid)}
[WinMsg]::SendMessage([IntPtr]${hwnd}, ${msg}, [IntPtr]${vk}, [IntPtr]0)
`
  return runPs(script) !== null
}

/**
 * Send a key combination (e.g. ['ctrl', 'a']).
 * Holds modifiers via WM_KEYDOWN, presses the key, then releases modifiers in reverse order.
 */
export function sendKeys(hwnd: number, combo: string[], expectedPid?: number): boolean {
  if (combo.length === 0) return false

  const MODIFIER_NAMES = new Set(['shift', 'ctrl', 'control', 'alt', 'menu'])

  const modifiers: number[] = []
  let mainKey: number | undefined

  for (const key of combo) {
    const lower = key.toLowerCase()
    const vk = VK_MAP[lower]
    if (vk !== undefined) {
      if (MODIFIER_NAMES.has(lower)) {
        modifiers.push(vk)
      } else {
        mainKey = vk
      }
    } else if (lower.length === 1) {
      // Single character — use its uppercase VK code
      mainKey = lower.toUpperCase().charCodeAt(0)
    } else {
      return false
    }
  }

  if (mainKey === undefined) return false

  // Build script: modifiers down, key down, key up, modifiers up (reverse)
  const lines: string[] = []
  for (const mod of modifiers) {
    lines.push(`[WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_KEYDOWN, [IntPtr]${mod}, [IntPtr]0)`)
  }
  lines.push(`[WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_KEYDOWN, [IntPtr]${mainKey}, [IntPtr]0)`)
  lines.push(`[WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_KEYUP, [IntPtr]${mainKey}, [IntPtr]0)`)
  for (const mod of [...modifiers].reverse()) {
    lines.push(`[WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_KEYUP, [IntPtr]${mod}, [IntPtr]0)`)
  }

  const script = `${WINMSG_TYPE}
${requireProcess(hwnd, expectedPid)}
${lines.join('\n')}
`
  return runPs(script) !== null
}

/**
 * Send a WM_MOUSEMOVE message to move the cursor within a window's client area.
 * Coordinates are window-relative (from screenshot) and adjusted to client-area-relative.
 */
export function sendMouseMove(hwnd: number, x: number, y: number, expectedPid?: number): boolean {
  const script = `${WINMSG_TYPE}
${requireProcess(hwnd, expectedPid)}
$lp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(x)}, ${Math.round(y)})
[WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0200, [IntPtr]0, $lp)
`
  return runPs(script) !== null
}

/**
 * Send a mouse click at window-relative coordinates.
 * Coordinates are adjusted to client-area-relative to account for title bar and borders.
 */
function clickMessages(button: 'left' | 'right' | 'middle'): { down: string; up: string } {
  return {
    down: button === 'left' ? '0x0201' : button === 'right' ? '0x0204' : '0x0207',
    up: button === 'left' ? '0x0202' : button === 'right' ? '0x0205' : '0x0208',
  }
}

export function sendClick(hwnd: number, x: number, y: number, button: 'left' | 'right' | 'middle', expectedPid?: number): boolean {
  const { down: downMsg, up: upMsg } = clickMessages(button)

  const script = `${WINMSG_TYPE}
${requireProcess(hwnd, expectedPid)}
$lp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(x)}, ${Math.round(y)})
[WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0200, [IntPtr]0, $lp)
[WinMsg]::SendMessage([IntPtr]${hwnd}, ${downMsg}, [IntPtr]0, $lp)
[WinMsg]::SendMessage([IntPtr]${hwnd}, ${upMsg}, [IntPtr]0, $lp)
`
  return runPs(script) !== null
}

/**
 * Send ONLY a button press or release (no move, no full click) — the phase
 * primitive for drag composition on windows where SendMessage input works.
 */
export function sendMouseButton(
  hwnd: number,
  x: number,
  y: number,
  button: 'left' | 'right',
  phase: 'down' | 'up',
  expectedPid?: number,
): boolean {
  const msg = phase === 'down'
    ? (button === 'left' ? '0x0201' : '0x0204')
    : (button === 'left' ? '0x0202' : '0x0205')
  const script = `${WINMSG_TYPE}
${requireProcess(hwnd, expectedPid)}
$lp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(x)}, ${Math.round(y)})
[WinMsg]::SendMessage([IntPtr]${hwnd}, ${msg}, [IntPtr]0, $lp)
`
  return runPs(script) !== null
}

/**
 * Full drag gesture via SendMessage in ONE PowerShell invocation:
 * move to `from` → WM_LBUTTONDOWN → eased WM_MOUSEMOVE frames →
 * WM_LBUTTONUP. Client-area adjusted like sendClick. One process for the
 * whole gesture — the old executor-composed path spawned a PowerShell per
 * animation frame.
 */
export function sendDrag(
  hwnd: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationMs: number,
  expectedPid?: number,
): boolean {
  const frames = Math.max(2, Math.min(40, Math.round(durationMs / 25)))
  const frameMs = Math.max(10, Math.round(durationMs / frames))
  const script = `${WINMSG_TYPE}
${requireProcess(hwnd, expectedPid)}
$lpDown = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(fromX)}, ${Math.round(fromY)})
[WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0200, [IntPtr]0, $lpDown)
Start-Sleep -Milliseconds 20
[WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0201, [IntPtr]1, $lpDown)
Start-Sleep -Milliseconds 40
try {
    $frames = ${frames}
    for ($i = 1; $i -le $frames; $i++) {
        $t = $i / $frames
        $eased = 1 - [math]::Pow(1 - $t, 3)
        $x = [math]::Round(${Math.round(fromX)} + (${Math.round(toX)} - ${Math.round(fromX)}) * $eased)
        $y = [math]::Round(${Math.round(fromY)} + (${Math.round(toY)} - ${Math.round(fromY)}) * $eased)
        $lp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, $x, $y)
        [WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0200, [IntPtr]1, $lp)
        Start-Sleep -Milliseconds ${frameMs}
    }
} finally {
    $lpUp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(toX)}, ${Math.round(toY)})
    [WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0202, [IntPtr]0, $lpUp)
}
`
  return runPs(script) !== null
}

/**
 * Send an Enter key (carriage return) via WM_CHAR.
 */
export function sendEnter(hwnd: number, expectedPid?: number): boolean {
  const script = `${WINMSG_TYPE}
${requireProcess(hwnd, expectedPid)}
[WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_CHAR, [IntPtr]13, [IntPtr]0)
`
  return runPs(script) !== null
}

export const _test = { clickMessages, requireProcess }

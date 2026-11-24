/**
 * SendMessage-based input for Win32 windows.
 * All operations target a specific HWND without stealing focus or moving the mouse.
 *
 * Per-monitor-v2 DPI awareness keeps GetWindowRect/ClientToScreen in the same
 * physical pixels as the normalized PrintWindow screenshot. The native-boundary
 * helper subtracts the client offset; Windows translates message coordinates
 * for the receiving window's DPI awareness, so no second manual scale is applied.
 */

import { runComputerUsePowerShell } from './elevatedPowerShell.js'
import { INPUT_INTEGRITY_TYPES } from './elevation.js'
import { windowsActionSignal } from './powerShell.js'

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

    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", SetLastError=true)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    public static IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam) {
        const uint Flags = 0x23; // SMTO_BLOCK | SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT
        IntPtr result;
        if (SendMessageTimeout(hWnd, msg, wParam, lParam, Flags, 750, out result) == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            throw new InvalidOperationException("The target did not acknowledge window message 0x" + msg.ToString("X") + " (Win32 error " + error + ").");
        }
        return result;
    }

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", EntryPoint="GetWindowLongW")]
    static extern int GetWindowLong(IntPtr hwnd, int index);

    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool PhysicalToLogicalPointForPerMonitorDPI(IntPtr hwnd, ref POINT point);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lp);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    static extern bool IsChild(IntPtr parent, IntPtr child);

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

    [StructLayout(LayoutKind.Sequential)]
    struct TitleBarInfo {
        public int Size;
        public RECT Bounds;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst=6)] public uint[] States;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst=6)] public RECT[] Areas;
    }

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

    public static void RequireChild(IntPtr parent, IntPtr child) {
        uint parentPid;
        if (!IsChild(parent, child) || GetWindowThreadProcessId(parent, out parentPid) == 0) {
            throw new InvalidOperationException("The edit control no longer belongs to the selected window.");
        }
        RequireProcess(child, parentPid);
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

    static bool HitMinimizeButton(IntPtr hwnd, POINT physical) {
        const uint WM_GETTITLEBARINFOEX = 0x033F;
        const int MinimizeIndex = 2;
        const uint UnavailableOrInvisible = 0x0001 | 0x8000;
        var info = new TitleBarInfo {
            Size = Marshal.SizeOf(typeof(TitleBarInfo)), States = new uint[6], Areas = new RECT[6]
        };
        IntPtr buffer = Marshal.AllocHGlobal(info.Size);
        try {
            Marshal.StructureToPtr(info, buffer, false);
            SendMessage(hwnd, WM_GETTITLEBARINFOEX, IntPtr.Zero, buffer);
            info = (TitleBarInfo)Marshal.PtrToStructure(buffer, typeof(TitleBarInfo));
            RECT button = info.Areas[MinimizeIndex];
            return (info.States[MinimizeIndex] & UnavailableOrInvisible) == 0 &&
                physical.X >= button.L && physical.X < button.R && physical.Y >= button.T && physical.Y < button.B;
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    public static bool TryClickMinimize(IntPtr hwnd, uint expectedPid, int x, int y) {
        const int GWL_STYLE = -16;
        const int CaptionWithMinimize = 0x00C00000 | 0x00080000 | 0x00020000;
        SetProcessDPIAware();
        RequireProcess(hwnd, expectedPid);
        if (!IsWindowVisible(hwnd) || !IsWindowEnabled(hwnd) || IsIconic(hwnd)) return false;
        if ((GetWindowLong(hwnd, GWL_STYLE) & CaptionWithMinimize) != CaptionWithMinimize) return false;
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        if (x < 0 || y < 0 || x >= rect.R - rect.L || y >= rect.B - rect.T) return false;
        var screen = new POINT { X = rect.L + x, Y = rect.T + y };
        if (!HitMinimizeButton(hwnd, screen)) return false;
        // The caption query uses our physical coordinates. The command carries
        // the original click position in the receiving window's DPI space.
        if (!PhysicalToLogicalPointForPerMonitorDPI(hwnd, ref screen)) return false;
        if (screen.X < short.MinValue || screen.X > short.MaxValue || screen.Y < short.MinValue || screen.Y > short.MaxValue) return false;
        Minimize(hwnd, expectedPid, MakeLParam(screen.X, screen.Y));
        return true;
    }

    public static void Minimize(IntPtr hwnd, uint expectedPid, IntPtr point) {
        const uint WM_SYSCOMMAND = 0x0112;
        const int SC_MINIMIZE = 0xF020;
        RequireProcess(hwnd, expectedPid);
        if (IsIconic(hwnd)) return;
        if (!IsWindowVisible(hwnd) || !IsWindowEnabled(hwnd)) {
            throw new InvalidOperationException("The selected window is hidden or disabled.");
        }
        SendMessage(hwnd, WM_SYSCOMMAND, (IntPtr)SC_MINIMIZE, point);
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

async function runPs(script: string, inputHwnd?: number, options?: { cancellable?: boolean }): Promise<string> {
  windowsActionSignal.getStore()?.throwIfAborted()
  const guard = inputHwnd === undefined ? '' : INPUT_INTEGRITY_TYPES + `
[CuInputIntegrity]::RequireWindow([IntPtr]${inputHwnd})
`
  // Keep an already dispatched press/release pair together when Esc arrives.
  const run = () => runComputerUsePowerShell(WINMSG_TYPE + guard + script, 8000, undefined, options?.cancellable ? windowsActionSignal.getStore() : undefined)
  return options?.cancellable ? run() : windowsActionSignal.exit(run)
}

function requireProcess(hwnd: number, expectedPid?: number): string {
  return `[WinMsg]::RequireProcess([IntPtr]${hwnd}, ${expectedPid ?? 0})`
}

/** Deliver the command for a confirmed native minimize button without moving the pointer. */
export async function tryClickMinimize(hwnd: number, expectedPid: number, x: number, y: number): Promise<boolean> {
  const result = await runPs(`
if ([WinMsg]::TryClickMinimize([IntPtr]${hwnd}, ${expectedPid}, ${Math.round(x)}, ${Math.round(y)})) {
    'MINIMIZE_SENT'
} else { 'NOT_MINIMIZE' }
`, hwnd, { cancellable: true })
  if (result === 'MINIMIZE_SENT') return true
  if (result === 'NOT_MINIMIZE') return false
  throw new Error('Could not determine the native minimize result. Inspect the window before retrying.')
}

export async function sendMinimize(hwnd: number, expectedPid: number, signal?: AbortSignal): Promise<void> {
  const run = () => runPs(`[WinMsg]::Minimize([IntPtr]${hwnd}, ${expectedPid}, [IntPtr]::Zero)`, hwnd, { cancellable: true })
  await (signal ? windowsActionSignal.run(signal, run) : run())
}

/**
 * Find the first edit-capable child window of a parent HWND.
 * Searches for known edit control class names in priority order.
 */
export async function findEditChild(parentHwnd: number, expectedPid?: number): Promise<number | null> {
  const script = `
${requireProcess(parentHwnd, expectedPid)}
[WinMsg]::FindChildren([IntPtr]${parentHwnd})
[WinMsg]::childResults | ForEach-Object { $_ }
`
  const raw = await runPs(script)
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
export async function sendChar(hwnd: number, char: string, expectedPid?: number): Promise<boolean> {
  const code = char.charCodeAt(0)
  const script = `
${requireProcess(hwnd, expectedPid)}
[WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_CHAR, [IntPtr]${code}, [IntPtr]0)
`
  await runPs(script, hwnd)
  return true
}

/**
 * Send a string of text to a window by finding its edit child and sending WM_CHAR for each character.
 */
export async function sendText(hwnd: number, text: string, expectedPid?: number): Promise<boolean> {
  const editHwnd = await findEditChild(hwnd, expectedPid)
  if (editHwnd === null) return false

  // Build a single PowerShell script that sends every UTF-16 code unit,
  // including both halves of a surrogate pair.
  const charLines = Array.from({ length: text.length }, (_, index) => {
    const code = text.charCodeAt(index)
    return `[WinMsg]::SendMessage([IntPtr]${editHwnd}, [WinMsg]::WM_CHAR, [IntPtr]${code}, [IntPtr]0)`
  }).join('\n')

  const script = `
${requireProcess(hwnd, expectedPid)}
[WinMsg]::RequireChild([IntPtr]${hwnd}, [IntPtr]${editHwnd})
${charLines}
`
  await runPs(script, hwnd)
  return true
}

/**
 * Send a key down or key up event via WM_KEYDOWN / WM_KEYUP.
 */
export async function sendKey(hwnd: number, vk: number, action: 'down' | 'up', expectedPid?: number): Promise<boolean> {
  const msg = action === 'down' ? '0x0100' : '0x0101'
  const script = `
${requireProcess(hwnd, expectedPid)}
[WinMsg]::SendMessage([IntPtr]${hwnd}, ${msg}, [IntPtr]${vk}, [IntPtr]0)
`
  await runPs(script, action === 'down' ? hwnd : undefined)
  return true
}

/**
 * Send a key combination (e.g. ['ctrl', 'a']).
 * Holds modifiers via WM_KEYDOWN, presses the key, then releases modifiers in reverse order.
 */
export async function sendKeys(hwnd: number, combo: string[], expectedPid?: number): Promise<boolean> {
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

  const script = `
${requireProcess(hwnd, expectedPid)}
$pressed = New-Object 'System.Collections.Generic.List[int]'
try {
    foreach ($key in @(${[...modifiers, mainKey].join(', ')})) {
        ${requireProcess(hwnd, expectedPid)}
        $pressed.Add($key)
        [WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_KEYDOWN, [IntPtr]$key, [IntPtr]0)
    }
} finally {
    $releaseError = $null
    for ($i = $pressed.Count - 1; $i -ge 0; $i--) {
        try {
            ${requireProcess(hwnd, expectedPid)}
            [WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_KEYUP, [IntPtr]($pressed[$i]), [IntPtr]0)
        } catch { $releaseError = $_ }
    }
    if ($releaseError) { throw $releaseError }
}
`
  await runPs(script, hwnd)
  return true
}

/**
 * Send a WM_MOUSEMOVE message to move the cursor within a window's client area.
 * Coordinates are window-relative (from screenshot) and adjusted to client-area-relative.
 */
export async function sendMouseMove(hwnd: number, x: number, y: number, expectedPid?: number): Promise<boolean> {
  const script = `
${requireProcess(hwnd, expectedPid)}
$lp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(x)}, ${Math.round(y)})
[WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0200, [IntPtr]0, $lp)
`
  await runPs(script, hwnd)
  return true
}

/**
 * Send a mouse click at window-relative coordinates.
 * Coordinates are adjusted to client-area-relative to account for title bar and borders.
 */
function clickMessages(button: 'left' | 'right' | 'middle'): { down: string; up: string; buttons: number } {
  return {
    down: button === 'left' ? '0x0201' : button === 'right' ? '0x0204' : '0x0207',
    up: button === 'left' ? '0x0202' : button === 'right' ? '0x0205' : '0x0208',
    buttons: button === 'left' ? 1 : button === 'right' ? 2 : 0x10,
  }
}

export async function sendClick(hwnd: number, x: number, y: number, button: 'left' | 'right' | 'middle', expectedPid?: number): Promise<boolean> {
  const { down: downMsg, up: upMsg, buttons } = clickMessages(button)

  const script = `
${requireProcess(hwnd, expectedPid)}
$lp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(x)}, ${Math.round(y)})
[WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0200, [IntPtr]0, $lp)
${requireProcess(hwnd, expectedPid)}
try {
    [WinMsg]::SendMessage([IntPtr]${hwnd}, ${downMsg}, [IntPtr]${buttons}, $lp)
} finally {
    ${requireProcess(hwnd, expectedPid)}
    [WinMsg]::SendMessage([IntPtr]${hwnd}, ${upMsg}, [IntPtr]0, $lp)
}
`
  await runPs(script, hwnd)
  return true
}

/**
 * Send ONLY a button press or release (no move, no full click) — the phase
 * primitive for drag composition on windows where SendMessage input works.
 */
export async function sendMouseButton(
  hwnd: number,
  x: number,
  y: number,
  button: 'left' | 'right',
  phase: 'down' | 'up',
  expectedPid?: number,
): Promise<boolean> {
  const msg = phase === 'down'
    ? (button === 'left' ? '0x0201' : '0x0204')
    : (button === 'left' ? '0x0202' : '0x0205')
  const buttons = phase === 'up' ? 0 : button === 'left' ? 1 : 2
  const script = `
${requireProcess(hwnd, expectedPid)}
$lp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(x)}, ${Math.round(y)})
[WinMsg]::SendMessage([IntPtr]${hwnd}, ${msg}, [IntPtr]${buttons}, $lp)
`
  await runPs(script, phase === 'down' ? hwnd : undefined)
  return true
}

export async function sendScroll(hwnd: number, amount: number, direction: 'vertical' | 'horizontal', expectedPid?: number): Promise<void> {
  const message = direction === 'vertical' ? '0x0115' : '0x0114'
  const wParam = amount > 0 ? 1 : 0
  await runPs(`
for ($i = 0; $i -lt ${Math.abs(Math.round(amount))}; $i++) {
    ${requireProcess(hwnd, expectedPid)}
    [WinMsg]::SendMessage([IntPtr]${hwnd}, ${message}, [IntPtr]${wParam}, [IntPtr]::Zero)
}
`, hwnd)
}

/**
 * Full drag gesture via SendMessage in ONE PowerShell invocation:
 * move to `from` → WM_LBUTTONDOWN → eased WM_MOUSEMOVE frames →
 * WM_LBUTTONUP. Client-area adjusted like sendClick. One process for the
 * whole gesture — the old executor-composed path spawned a PowerShell per
 * animation frame.
 */
export async function sendDrag(
  hwnd: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationMs: number,
  expectedPid?: number,
): Promise<boolean> {
  const frames = Math.max(2, Math.min(40, Math.round(durationMs / 25)))
  const frameMs = Math.max(10, Math.round(durationMs / frames))
  const script = `
${requireProcess(hwnd, expectedPid)}
$lpDown = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(fromX)}, ${Math.round(fromY)})
[WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0200, [IntPtr]0, $lpDown)
Start-Sleep -Milliseconds 20
${requireProcess(hwnd, expectedPid)}
try {
    [WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0201, [IntPtr]1, $lpDown)
    Start-Sleep -Milliseconds 40
    $frames = ${frames}
    for ($i = 1; $i -le $frames; $i++) {
        $t = $i / $frames
        $eased = 1 - [math]::Pow(1 - $t, 3)
        $x = [math]::Round(${Math.round(fromX)} + (${Math.round(toX)} - ${Math.round(fromX)}) * $eased)
        $y = [math]::Round(${Math.round(fromY)} + (${Math.round(toY)} - ${Math.round(fromY)}) * $eased)
        ${requireProcess(hwnd, expectedPid)}
        $lp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, $x, $y)
        [WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0200, [IntPtr]1, $lp)
        Start-Sleep -Milliseconds ${frameMs}
    }
} finally {
    ${requireProcess(hwnd, expectedPid)}
    $lpUp = [WinMsg]::MakeClientLParam([IntPtr]${hwnd}, ${Math.round(toX)}, ${Math.round(toY)})
    [WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0202, [IntPtr]0, $lpUp)
}
`
  await runPs(script, hwnd)
  return true
}

/**
 * Send an Enter key (carriage return) via WM_CHAR.
 */
export async function sendEnter(hwnd: number, expectedPid?: number): Promise<boolean> {
  const script = `
${requireProcess(hwnd, expectedPid)}
[WinMsg]::SendMessage([IntPtr]${hwnd}, [WinMsg]::WM_CHAR, [IntPtr]13, [IntPtr]0)
`
  await runPs(script, hwnd)
  return true
}

export const _test = { clickMessages, requireProcess }

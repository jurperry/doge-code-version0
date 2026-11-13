/**
 * Visual indicator for bound windows — DWM native border color.
 *
 * Uses DWMWA_BORDER_COLOR (attribute 34) on Windows 11+.
 * The border:
 * - Follows window rounded corners natively
 * - Tracks window movement/resize automatically (OS-level rendering)
 * - Persists across repaints
 * - Zero performance overhead
 * - Falls back to no-op on older Windows or Electron-style frameless windows
 */

import { runPowerShellSync } from './powerShell.js'

function ps(script: string): string {
  return runPowerShellSync(script, 5000)
}

const DWM_TYPES = `
Add-Type @'
using System;
using System.Runtime.InteropServices;

public class CuDwm {
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref uint val, int size);

    // DWMWA_BORDER_COLOR = 34 (Win11 22000+)
    // COLORREF format: 0x00BBGGRR
    public static int SetBorderColor(IntPtr hwnd, byte r, byte g, byte b) {
        uint color = (uint)((b << 16) | (g << 8) | r);
        return DwmSetWindowAttribute(hwnd, 34, ref color, 4);
    }

    public static int ResetBorder(IntPtr hwnd) {
        uint def = 0xFFFFFFFF; // DWMWA_COLOR_DEFAULT
        return DwmSetWindowAttribute(hwnd, 34, ref def, 4);
    }
}
'@
`

/**
 * Set green border on bound window via DWM.
 * Automatic: follows rounded corners, window movement, resize.
 */
function tryBorder(command: () => string): boolean {
  try {
    return command() === '0'
  } catch {
    return false
  }
}

export function markBound(hwnd: number): boolean {
  return tryBorder(() => ps(`${DWM_TYPES}; [CuDwm]::SetBorderColor([IntPtr]${hwnd}, 0, 200, 0)`))
}

/**
 * Remove border, restore default.
 */
export function unmarkBound(hwnd: number): boolean {
  return tryBorder(() => ps(`${DWM_TYPES}; [CuDwm]::ResetBorder([IntPtr]${hwnd})`))
}

/**
 * Set custom border color.
 */
export function setBorderColor(hwnd: number, r: number, g: number, b: number): boolean {
  return tryBorder(() => ps(`${DWM_TYPES}; [CuDwm]::SetBorderColor([IntPtr]${hwnd}, ${r}, ${g}, ${b})`))
}

export const _test = { tryBorder }

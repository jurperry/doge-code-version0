/**
 * Window enumeration using Win32 EnumWindows API.
 * Returns visible windows with their HWND, PID, and title.
 */

import { INPUT_INTEGRITY_TYPES, parseIntegrityLevel, type IntegrityLevel } from './elevation.js'
import { PROCESS_IMAGE_PS } from './processImage.js'
import { runPowerShellSync } from './powerShell.js'

export interface WindowInfo {
  hwnd: number
  pid: number
  title: string
  path?: string
}

export interface WindowDetails extends WindowInfo {
  path: string
  className: string
  visible: boolean
  minimized: boolean
  foreground: boolean
  dpiAwareness: number | null
  il: IntegrityLevel
}

const ENUM_WINDOWS_PS = `
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public static List<string> results = new List<string>();

    public static void Run(bool visibleOnly, bool details) {
        results.Clear();
        IntPtr foreground = details ? GetForegroundWindow() : IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            bool visible = IsWindowVisible(hWnd);
            if (visibleOnly && !visible) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            StringBuilder sb = new StringBuilder(Math.Min(len + 1, 513));
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == 0) return true;
            string entry = hWnd.ToInt64() + "|" + pid + "|" + Encode(title);
            if (details) {
                var className = new StringBuilder(256);
                GetClassName(hWnd, className, className.Capacity);
                int dpi = GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(hWnd));
                entry += "|" + Encode(className.ToString()) + "|" + Convert.ToInt32(visible) + "|" +
                    Convert.ToInt32(IsIconic(hWnd)) + "|" + Convert.ToInt32(hWnd == foreground) + "|" + dpi;
            }
            results.Add(entry);
            return true;
        }, IntPtr.Zero);
    }

    static string Encode(string value) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(value)); }
}
'@
`

/**
 * List all visible windows with non-empty titles.
 * Returns HWND, PID, and window title for each.
 */
export function listWindows(includeProcessImage = false): WindowInfo[] {
  const output = includeProcessImage ? `
${PROCESS_IMAGE_PS}
$images = @{}
[WinEnum]::results | ForEach-Object {
    $processId = [uint32]$_.Split('|')[1]
    if (-not $images.ContainsKey($processId)) { $images[$processId] = [CuProcessImage]::Get($processId) }
    "$_|$($images[$processId])"
}
` : '[WinEnum]::results'
  const raw = runPowerShellSync(`${ENUM_WINDOWS_PS}\n[WinEnum]::Run($true, $false)\n${output}`, 8000)
  if (!raw) return []

  return raw.split(/\r?\n/).map(line => {
    const [handle, processId, titleBase64, path] = line.split('|')
    const hwnd = Number(handle)
    const pid = Number(processId)
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || !Number.isInteger(pid) || pid <= 0 || !titleBase64) return null
    const title = Buffer.from(titleBase64, 'base64').toString('utf8')
    return { hwnd, pid, title, ...(path ? { path } : {}) }
  }).filter((item): item is WindowInfo => item !== null)
}

/** Read diagnostic window metadata in a single local PowerShell process. */
export function listWindowDetails(visibleOnly = true): WindowDetails[] {
  const raw = runPowerShellSync(`${ENUM_WINDOWS_PS}
${PROCESS_IMAGE_PS}
${INPUT_INTEGRITY_TYPES}
[WinEnum]::Run($${visibleOnly}, $true)
$metadata = @{}
[WinEnum]::results | ForEach-Object {
    $processId = [uint32]$_.Split('|')[1]
    if (-not $metadata.ContainsKey($processId)) {
        $image = [CuProcessImage]::Get($processId)
        $rid = [CuInputIntegrity]::ForProcess($processId)
        $metadata[$processId] = "$image|$rid"
    }
    "$_|$($metadata[$processId])"
}
`, 8000)
  if (!raw) return []
  return raw.split(/\r?\n/).flatMap(line => {
    const [handle, processId, title, className, visible, minimized, foreground, dpi, path, rid] = line.split('|')
    const hwnd = Number(handle)
    const pid = Number(processId)
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || !Number.isSafeInteger(pid) || pid <= 0 || !title) return []
    const dpiAwareness = Number(dpi)
    return [{ hwnd, pid, title: Buffer.from(title, 'base64').toString('utf8'),
      path: path ?? '', className: Buffer.from(className ?? '', 'base64').toString('utf8'),
      visible: visible === '1', minimized: minimized === '1', foreground: foreground === '1',
      dpiAwareness: [0, 1, 2].includes(dpiAwareness) ? dpiAwareness : null,
      il: parseIntegrityLevel(rid ?? ''),
    }]
  })
}

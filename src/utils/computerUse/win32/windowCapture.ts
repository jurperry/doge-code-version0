/**
 * Window-level screenshot capture using Win32 PrintWindow API.
 * Captures windows even when occluded or minimized.
 *
 * Per-monitor-v2 DPI awareness keeps window rectangles in physical pixels.
 * Verified PopCap/WinForms DPI-unaware windows can render into a logical-sized
 * corner of that physical bitmap; only those captures are normalized.
 */

import { runComputerUsePowerShellSync as runPowerShellSync } from './elevatedPowerShell.js'

const NORMALIZE_UNAWARE_CAPTURE_CS = `
    static void GetCaptureDpi(IntPtr hwnd, out uint dpiX, out uint dpiY) {
        dpiX = 96;
        dpiY = 96;
        IntPtr context = GetWindowDpiAwarenessContext(hwnd);
        if (GetAwarenessFromDpiAwarenessContext(context) != 0) return;
        IntPtr monitor = MonitorFromWindow(hwnd, 2);
        int hr = GetDpiForMonitor(monitor, 0, out dpiX, out dpiY);
        if (hr != 0 || dpiX == 0 || dpiY == 0) {
            throw new System.Exception("GetDpiForMonitor failed while reading capture geometry (HRESULT " + hr + ").");
        }
    }

    static Bitmap NormalizeUnawareCapture(IntPtr hwnd, Bitmap bmp, uint dpiX, uint dpiY) {
        IntPtr context = GetWindowDpiAwarenessContext(hwnd);
        if (GetAwarenessFromDpiAwarenessContext(context) != 0) return bmp;
        StringBuilder className = new StringBuilder(256);
        GetClassName(hwnd, className, className.Capacity);
        string name = className.ToString();
        if (name != "MainWindow" && !name.StartsWith("WindowsForms10.", StringComparison.OrdinalIgnoreCase)) return bmp;
        int sourceW = Math.Max(1, (int)Math.Round(bmp.Width * 96.0 / dpiX));
        int sourceH = Math.Max(1, (int)Math.Round(bmp.Height * 96.0 / dpiY));
        if (sourceW >= bmp.Width && sourceH >= bmp.Height) return bmp;

        Bitmap normalized = new Bitmap(bmp.Width, bmp.Height);
        try {
            using (Graphics g = Graphics.FromImage(normalized)) {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(
                    bmp,
                    new Rectangle(0, 0, normalized.Width, normalized.Height),
                    new Rectangle(0, 0, Math.Min(sourceW, bmp.Width), Math.Min(sourceH, bmp.Height)),
                    GraphicsUnit.Pixel);
            }
        } catch {
            normalized.Dispose();
            throw;
        }
        bmp.Dispose();
        return normalized;
    }
`

interface CaptureResult {
  base64: string
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  originX: number
  originY: number
}

const CAPTURE_BY_TITLE_PS = `
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
public class WinCap {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern IntPtr FindWindow(string c, string t);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
    [DllImport("user32.dll")]
    static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")]
    static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    public static bool SetProcessDPIAware() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4))) {
            throw new System.Exception("Per-monitor-v2 DPI awareness is required for physical-pixel capture.");
        }
        return true;
    }
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")]
    public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("shcore.dll")]
    public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }

${NORMALIZE_UNAWARE_CAPTURE_CS}
    public static string Capture(string title) {
        SetProcessDPIAware();
        IntPtr hwnd = FindWindow(null, title);
        if (hwnd == IntPtr.Zero) return "NOT_FOUND";
        RECT r;
        if (!GetWindowRect(hwnd, out r)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        int w = r.R - r.L; int h = r.B - r.T;
        if (w <= 0 || h <= 0) return "INVALID_SIZE";
        uint dpiX, dpiY;
        GetCaptureDpi(hwnd, out dpiX, out dpiY);
        Bitmap bmp = new Bitmap(w, h);
        Graphics g = Graphics.FromImage(bmp);
        IntPtr hdc = IntPtr.Zero;
        try {
            hdc = g.GetHdc();
            if (!PrintWindow(hwnd, hdc, 2)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            g.ReleaseHdc(hdc); hdc = IntPtr.Zero;
            g.Dispose(); g = null;
            bmp = NormalizeUnawareCapture(hwnd, bmp, dpiX, dpiY);
            using (var ms = new System.IO.MemoryStream()) {
                bmp.Save(ms, ImageFormat.Png);
                return w + "," + h + "," + Convert.ToBase64String(ms.ToArray());
            }
        } finally {
            if (hdc != IntPtr.Zero && g != null) g.ReleaseHdc(hdc);
            if (g != null) g.Dispose();
            if (bmp != null) bmp.Dispose();
        }
    }
}
'@
`

const CAPTURE_BY_HWND_PS = `
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
public class WinCapH {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")]
    static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    public static bool SetProcessDPIAware() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4))) {
            throw new System.Exception("Per-monitor-v2 DPI awareness is required for physical-pixel capture.");
        }
        return true;
    }
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")]
    public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("shcore.dll")]
    public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }
    public const int SW_RESTORE = 9;
    public const int SW_SHOWMINNOACTIVE = 7;

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT2 { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT {
        public int length; public int flags; public int showCmd;
        public POINT2 ptMinPosition; public POINT2 ptMaxPosition;
        public RECT rcNormalPosition;
    }
    public const int SW_SHOWNOACTIVATE = 4;

${NORMALIZE_UNAWARE_CAPTURE_CS}
    public static string Capture(IntPtr hwnd, uint expectedPid) {
        SetProcessDPIAware();
        if (!IsWindow(hwnd)) return "NOT_FOUND";
        if (expectedPid != 0) {
            uint actualPid = 0;
            GetWindowThreadProcessId(hwnd, out actualPid);
            if (actualPid != expectedPid) return "PIDMISMATCH";
        }

        uint dpiX, dpiY;
        GetCaptureDpi(hwnd, out dpiX, out dpiY);
        bool wasMinimized = IsIconic(hwnd);
        bool placementChanged = false;
        WINDOWPLACEMENT origWp = new WINDOWPLACEMENT();
        origWp.length = Marshal.SizeOf(origWp);
        Bitmap bmp = null;
        Graphics g = null;
        IntPtr hdc = IntPtr.Zero;
        string tmp = null;

        try {
            if (wasMinimized) {
                if (!GetWindowPlacement(hwnd, ref origWp)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                RECT rc = origWp.rcNormalPosition;
                int nw = rc.R - rc.L; int nh = rc.B - rc.T;
                if (nw <= 0 || nh <= 0) return "INVALID_SIZE";

                WINDOWPLACEMENT tempWp = origWp;
                tempWp.showCmd = SW_SHOWNOACTIVATE;
                tempWp.rcNormalPosition = new RECT { L = -32000, T = -32000, R = -32000 + nw, B = -32000 + nh };
                if (!SetWindowPlacement(hwnd, ref tempWp)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                placementChanged = true;
                System.Threading.Thread.Sleep(100);
            }

            RECT r;
            if (!GetWindowRect(hwnd, out r)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            int w = r.R - r.L; int h = r.B - r.T;
            if (w <= 0 || h <= 0) return "INVALID_SIZE";

            bmp = new Bitmap(w, h);
            g = Graphics.FromImage(bmp);
            hdc = g.GetHdc();
            if (!PrintWindow(hwnd, hdc, 2)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            g.ReleaseHdc(hdc); hdc = IntPtr.Zero;
            g.Dispose(); g = null;
            bmp = NormalizeUnawareCapture(hwnd, bmp, dpiX, dpiY);

            tmp = System.IO.Path.GetTempFileName() + ".jpg";
            bmp.Save(tmp, ImageFormat.Jpeg);
            bmp.Dispose(); bmp = null;
            return w + "," + h + "," + tmp;
        } catch {
            if (tmp != null) {
                try { System.IO.File.Delete(tmp); } catch {}
            }
            throw;
        } finally {
            if (hdc != IntPtr.Zero && g != null) g.ReleaseHdc(hdc);
            if (g != null) g.Dispose();
            if (bmp != null) bmp.Dispose();
            if (placementChanged && !SetWindowPlacement(hwnd, ref origWp)) {
                if (tmp != null) {
                    try { System.IO.File.Delete(tmp); } catch {}
                }
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        }
    }
}
'@
`

function parseCaptureOutput(raw: string): CaptureResult | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'NOT_FOUND' || trimmed === 'INVALID_SIZE' || trimmed === 'PIDMISMATCH') {
    return null
  }
  const firstComma = trimmed.indexOf(',')
  const secondComma = trimmed.indexOf(',', firstComma + 1)
  if (firstComma === -1 || secondComma === -1) return null

  const width = Number(trimmed.slice(0, firstComma))
  const height = Number(trimmed.slice(firstComma + 1, secondComma))
  const thirdPart = trimmed.slice(secondComma + 1)

  if (!width || !height || !thirdPart) return null

  // Third part is a temp file path (JPEG) — read and convert to base64
  try {
    const fs = require('fs')
    const buf = fs.readFileSync(thirdPart)
    const base64 = buf.toString('base64')
    // Clean up temp file
    try { fs.unlinkSync(thirdPart) } catch {}
    return { base64, width, height, displayWidth: width, displayHeight: height, originX: 0, originY: 0 }
  } catch {
    try { require('fs').unlinkSync(thirdPart) } catch {}
    return null
  }
}

function runPs(script: string): string {
  return runPowerShellSync(script, 15000)
}

/**
 * Capture a window screenshot by its exact title.
 * Uses PrintWindow which works even for occluded/background windows.
 */
export function captureWindow(title: string): CaptureResult | null {
  const escaped = title.replace(/'/g, "''")
  const script = `${CAPTURE_BY_TITLE_PS}\n[WinCap]::Capture('${escaped}')`
  const raw = runPs(script)
  return parseCaptureOutput(raw)
}

/**
 * Capture a window screenshot by its HWND handle.
 */
export function captureWindowByHwnd(hwnd: number, expectedPid?: number): CaptureResult | null {
  const script = `${CAPTURE_BY_HWND_PS}\n[WinCapH]::Capture([IntPtr]::new(${hwnd}), ${expectedPid ?? 0})`
  const raw = runPs(script)
  return parseCaptureOutput(raw)
}

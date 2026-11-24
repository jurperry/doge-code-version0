/**
 * Window-level screenshot capture using Win32 PrintWindow API.
 * Captures windows even when occluded or minimized.
 *
 * Per-monitor-v2 DPI awareness keeps window rectangles in physical pixels.
 * Verified PopCap/WinForms DPI-unaware windows can render into a logical-sized
 * corner of that physical bitmap; only those captures are normalized.
 */

import { runComputerUsePowerShell } from './elevatedPowerShell.js'
import { isWindowMinimized } from './nativeWindows.js'
import { windowsActionSignal } from './powerShell.js'

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
    [DllImport("user32.dll", SetLastError=true)]
    static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll", SetLastError=true)]
    static extern bool SetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPLACEMENT {
        public int Length, Flags, ShowCmd;
        public POINT MinPosition, MaxPosition;
        public RECT NormalPosition;
    }
${NORMALIZE_UNAWARE_CAPTURE_CS}
    public static string Capture(IntPtr hwnd, uint expectedPid, bool allowPlacementChange) {
        SetProcessDPIAware();
        if (!IsWindow(hwnd)) return "NOT_FOUND";
        if (expectedPid != 0) {
            uint actualPid = 0;
            GetWindowThreadProcessId(hwnd, out actualPid);
            if (actualPid != expectedPid) return "PIDMISMATCH";
        }

        uint dpiX, dpiY;
        GetCaptureDpi(hwnd, out dpiX, out dpiY);
        if (!IsIconic(hwnd)) return CaptureImage(hwnd, dpiX, dpiY);
        if (!allowPlacementChange) return "MINIMIZED";

        // Restore off-screen without taking focus. Screen capture stays bounded
        // so even a hung PrintWindow cannot prevent restoring the placement.
        var original = new WINDOWPLACEMENT { Length = Marshal.SizeOf(typeof(WINDOWPLACEMENT)) };
        if (!GetWindowPlacement(hwnd, ref original)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var rect = original.NormalPosition;
        int width = rect.R - rect.L, height = rect.B - rect.T;
        if (width <= 0 || height <= 0) return "INVALID_SIZE";
        original.Flags |= 4; // WPF_ASYNCWINDOWPLACEMENT
        var temporary = original;
        temporary.ShowCmd = 4; // SW_SHOWNOACTIVATE
        temporary.NormalPosition = new RECT { L = -32000, T = -32000, R = -32000 + width, B = -32000 + height };
        if (!SetWindowPlacement(hwnd, ref temporary)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            for (int i = 0; i < 12 && IsIconic(hwnd); i++) System.Threading.Thread.Sleep(25);
            if (IsIconic(hwnd)) return "MINIMIZED";
            System.Threading.Thread.Sleep(100);
            string output = null;
            Exception failure = null;
            var worker = new System.Threading.Thread(() => {
                try { output = CaptureImage(hwnd, dpiX, dpiY); }
                catch (Exception error) { failure = error; }
            }) { IsBackground = true };
            worker.Start();
            if (!worker.Join(2000)) return "CAPTURE_TIMEOUT";
            if (failure != null) throw failure;
            return output;
        } finally {
            uint currentPid;
            if (GetWindowThreadProcessId(hwnd, out currentPid) != 0 && (expectedPid == 0 || currentPid == expectedPid)) {
                if (!SetWindowPlacement(hwnd, ref original)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        }
    }

    static string CaptureImage(IntPtr hwnd, uint dpiX, uint dpiY) {
        Bitmap bmp = null;
        Graphics g = null;
        IntPtr hdc = IntPtr.Zero;

        try {
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

            using (var data = new System.IO.MemoryStream()) {
                bmp.Save(data, ImageFormat.Jpeg);
                return w + "," + h + "," + Convert.ToBase64String(data.ToArray());
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

export async function captureWindowByHwnd(hwnd: number, expectedPid?: number, allowPlacementChange = true): Promise<CaptureResult | null> {
  windowsActionSignal.getStore()?.throwIfAborted()
  const minimized = allowPlacementChange && isWindowMinimized(hwnd)
  const script = `${CAPTURE_BY_HWND_PS}\n[WinCapH]::Capture([IntPtr]::new(${hwnd}), ${expectedPid ?? 0}, $${minimized})`
  // Once we move a minimized window, let the bounded capture restore it.
  const raw = await (minimized
    ? windowsActionSignal.exit(() => runComputerUsePowerShell(script, 8000))
    : runComputerUsePowerShell(script, 3000))
  windowsActionSignal.getStore()?.throwIfAborted()
  const [w, h, base64] = raw.split(',')
  const width = Number(w)
  const height = Number(h)
  if (!width || !height || !base64) return null
  return { base64, width, height, displayWidth: width, displayHeight: height, originX: 0, originY: 0 }
}

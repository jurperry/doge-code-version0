/**
 * Windows ESC hotkey abort mechanism.
 *
 * Uses WH_KEYBOARD_LL (low-level keyboard hook) to intercept Escape key
 * system-wide. This is the Windows equivalent of macOS's CGEventTap approach.
 *
 * Requirements:
 * - A hidden message window with a running message loop
 * - WH_KEYBOARD_LL hook installed via SetWindowsHookEx
 * - Hook callback runs in the thread that installed it
 *
 * Because Node.js/Bun is single-threaded, we run the hook in a PowerShell
 * background process and communicate via a named pipe.
 */

import { logForDebugging } from '../../debug.js'

let psProcess: ReturnType<typeof Bun.spawn> | undefined
let registered = false
let onEscapeCallback: (() => void) | undefined
let pipeListenerInterval: ReturnType<typeof setInterval> | undefined

const PIPE_NAME = 'cu-esc-hook'

/**
 * Install a low-level keyboard hook in a PowerShell background process.
 * The process monitors for Escape key presses and writes to a named pipe.
 */
export function registerWin32EscHotkey(onEscape: () => void): boolean {
  if (process.platform !== 'win32') return false
  if (registered) {
    onEscapeCallback = onEscape
    return true
  }

  onEscapeCallback = onEscape

  // PowerShell script: install WH_KEYBOARD_LL, watch for Escape, signal via named pipe
  const hookScript = `
Add-Type @'
using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

public class EscHook {
    public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public const int WH_KEYBOARD_LL = 13;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const int VK_ESCAPE = 0x1B;
    public const uint WM_QUIT = 0x0012;

    private static IntPtr hookId = IntPtr.Zero;
    private static HookProc hookCallback;
    private static string pipeName;

    public static void Install(string name) {
        pipeName = name;
        hookCallback = new HookProc(HookCallback);
        hookId = SetWindowsHookEx(WH_KEYBOARD_LL, hookCallback, IntPtr.Zero, 0);
        if (hookId == IntPtr.Zero) {
            Console.Error.WriteLine("HOOK_FAILED:" + Marshal.GetLastWin32Error());
            return;
        }
        Console.WriteLine("HOOK_INSTALLED");
        Console.Out.Flush();
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int vkCode = Marshal.ReadInt32(lParam);
            int msgType = wParam.ToInt32();
            if (vkCode == VK_ESCAPE && (msgType == WM_KEYDOWN || msgType == WM_SYSKEYDOWN)) {
                try {
                    using (var client = new NamedPipeClientStream(".", pipeName, System.IO.Pipes.PipeDirection.Out)) {
                        client.Connect(100);
                        byte[] msg = Encoding.UTF8.GetBytes("ESC");
                        client.Write(msg, 0, msg.Length);
                        client.Flush();
                    }
                } catch {}
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    public static void Uninstall() {
        if (hookId != IntPtr.Zero) {
            UnhookWindowsHookEx(hookId);
            hookId = IntPtr.Zero;
        }
    }
}
'@

$pipeName = '${PIPE_NAME}'
[EscHook]::Install($pipeName)

# Message loop: required for WH_KEYBOARD_LL to function
$msgLoop = @"
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MsgPump {
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int px; public int py; }
    [DllImport("user32.dll")] public static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG lpMsg);
    public const int WM_QUIT = 0x0012;
    public static void Run() {
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0)) {
            if (m.message == WM_QUIT) break;
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
    }
}
'@
[MsgPump]::Run()
`

  try {
    // Create named pipe server to receive ESC signals
    const pipePath = `\\\\.\\pipe\\${PIPE_NAME}`

    // Start PowerShell hook process
    psProcess = Bun.spawn(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', hookScript],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    // Read stdout to check if hook installed
    const reader = psProcess.stdout.getReader()

    // Guard against double-release of the reader lock
    let lockReleased = false
    const releaseLock = () => {
      if (!lockReleased) {
        lockReleased = true
        reader.releaseLock()
      }
    }

    const timeout = setTimeout(releaseLock, 3000)

    reader.read().then(({ value, done }) => {
      clearTimeout(timeout)
      if (done) { releaseLock(); return }
      const text = new TextDecoder().decode(value).trim()
      if (text.includes('HOOK_INSTALLED')) {
        registered = true
        logForDebugging('[cu-esc-win32] Keyboard hook installed successfully')
        startPipeListener(pipePath)
      } else if (text.includes('HOOK_FAILED')) {
        logForDebugging('[cu-esc-win32] Hook installation failed', { level: 'warn' })
        cleanup()
      }
      releaseLock()
    }).catch(() => {
      clearTimeout(timeout)
      releaseLock()
    })

    return true
  } catch (err) {
    logForDebugging(`[cu-esc-win32] Registration error: ${err}`, { level: 'error' })
    cleanup()
    return false
  }
}

function startPipeListener(pipePath: string): void {
  // Guard against overlapping spawns — if the previous pipe read is still
  // running (e.g. PowerShell hung), skip this tick instead of queuing more.
  let pipeBusy = false

  // Poll for pipe connections — 250ms interval balances responsiveness with CPU usage
  pipeListenerInterval = setInterval(async () => {
    if (!registered) {
      clearInterval(pipeListenerInterval)
      pipeListenerInterval = undefined
      return
    }
    if (pipeBusy) return // previous read still in-flight
    pipeBusy = true
    try {
      // Use PowerShell to read from the pipe (simpler than Node pipe API)
      const result = Bun.spawnSync({
        cmd: ['powershell', '-NoProfile', '-NonInteractive', '-Command',
          `try { $c = New-Object System.IO.Pipes.NamedPipeServerStream('${PIPE_NAME}', [System.IO.Pipes.PipeDirection]::In, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous); $c.WaitForConnection(100); if ($c.IsConnected) { $r = New-Object System.IO.StreamReader($c); $r.ReadToEnd(); $c.Dispose() } else { $c.Dispose() } } catch {}`,
        ],
        stdout: 'pipe',
        stderr: 'pipe',
        timeoutMs: 3000,
      })
      const output = new TextDecoder().decode(result.stdout).trim()
      if (output === 'ESC' && onEscapeCallback) {
        logForDebugging('[cu-esc-win32] ESC detected, triggering abort')
        onEscapeCallback()
      }
    } catch {
      // Pipe read failed, continue polling
    } finally {
      pipeBusy = false
    }
  }, 250)
}

/**
 * Unregister the Windows ESC hotkey.
 */
export function unregisterWin32EscHotkey(): void {
  if (!registered) return
  cleanup()
  logForDebugging('[cu-esc-win32] Unregistered')
}

function cleanup(): void {
  registered = false
  if (pipeListenerInterval) {
    clearInterval(pipeListenerInterval)
    pipeListenerInterval = undefined
  }
  if (psProcess) {
    try {
      psProcess.kill()
    } catch {}
    psProcess = undefined
  }
}

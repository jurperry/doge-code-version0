/**
 * Windows ESC hotkey abort mechanism.
 *
 * Uses WH_KEYBOARD_LL (low-level keyboard hook) to intercept Escape key
 * system-wide. The hook lives in a PowerShell process with a message loop;
 * Node owns the named-pipe server and its lifecycle.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { logForDebugging } from '../../debug.js'

let psProcess: ReturnType<typeof Bun.spawn> | undefined
let pipeServer: Server | undefined
const pipeConnections = new Set<Socket>()
let registered = false
let generation = 0
let pending: Promise<boolean> | undefined
let onEscapeCallback: (() => void) | undefined

const PIPE_NAME = `cu-esc-hook-${process.pid}`

async function readHandshake(proc: ReturnType<typeof Bun.spawn>): Promise<boolean> {
  const read = async (stream: ReadableStream<Uint8Array>): Promise<boolean> => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      let text = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return false
        text += decoder.decode(value, { stream: true })
        if (text.includes('HOOK_INSTALLED')) return true
        if (text.includes('HOOK_FAILED')) return false
      }
    } finally {
      reader.releaseLock()
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(proc.stdout),
      read(proc.stderr),
      proc.exited.then(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3000) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Install the hook and wait until its handshake proves it is usable. */
export async function registerWin32EscHotkey(onEscape: () => void): Promise<boolean> {
  if (process.platform !== 'win32') return false
  if (registered) {
    onEscapeCallback = onEscape
    return true
  }
  onEscapeCallback = onEscape
  if (pending) return pending
  const ticket = ++generation
  const hookScript = `
Add-Type @'
using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.Diagnostics;

public class EscHook {
    public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandle(string lpModuleName);

    public const int WH_KEYBOARD_LL = 13;
    public const int WM_KEYDOWN = 0x0100;
    public const int WM_SYSKEYDOWN = 0x0104;
    public const int VK_ESCAPE = 0x1B;
    public const uint LLKHF_INJECTED = 0x10;

    private static IntPtr hookId = IntPtr.Zero;
    private static HookProc hookCallback;
    private static string pipeName;

    public static bool Install(string name) {
        pipeName = name;
        hookCallback = new HookProc(HookCallback);
        hookId = SetWindowsHookEx(WH_KEYBOARD_LL, hookCallback, GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName), 0);
        if (hookId == IntPtr.Zero) {
            Console.Error.WriteLine("HOOK_FAILED:" + Marshal.GetLastWin32Error());
            return false;
        }
        Console.WriteLine("HOOK_INSTALLED");
        Console.Out.Flush();
        return true;
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int vkCode = Marshal.ReadInt32(lParam);
            int msgType = wParam.ToInt32();
            if (vkCode == VK_ESCAPE && (msgType == WM_KEYDOWN || msgType == WM_SYSKEYDOWN)) {
                uint flags = (uint)Marshal.ReadInt32(lParam, 8);
                if ((flags & LLKHF_INJECTED) != 0) return CallNextHookEx(hookId, nCode, wParam, lParam);
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
if (-not [EscHook]::Install($pipeName)) { exit 1 }

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

  const operation = (async (): Promise<boolean> => {
    try {
      const pipePath = '\\\\.\\pipe\\' + PIPE_NAME
      startPipeListener(pipePath)
      const proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', hookScript], { stdout: 'pipe', stderr: 'pipe' })
      psProcess = proc
      const installed = await readHandshake(proc)
      if (generation !== ticket) return false
      if (!installed) {
        cleanup()
        return false
      }
      registered = true
      logForDebugging('[cu-esc-win32] Keyboard hook installed successfully')
      void proc.exited.then(() => {
        if (generation === ticket) cleanup()
      })
      return true
    } catch (error) {
      logForDebugging(`[cu-esc-win32] Registration error: ${error}`, { level: 'error' })
      if (generation === ticket) cleanup()
      return false
    }
  })()
  pending = operation
  try {
    return await operation
  } finally {
    if (pending === operation) pending = undefined
  }
}

function startPipeListener(pipePath: string): void {
  const server = createServer(socket => {
    pipeConnections.add(socket)
    socket.on('close', () => pipeConnections.delete(socket))
    socket.once('data', data => {
      if (pipeServer !== server) {
        socket.destroy()
        return
      }
      if (data.toString().trim() === 'ESC' && onEscapeCallback) {
        logForDebugging('[cu-esc-win32] ESC detected, triggering abort')
        onEscapeCallback()
      }
      socket.end()
    })
    socket.on('error', () => {})
  })
  pipeServer = server
  server.on('error', error => {
    if (pipeServer !== server) return
    logForDebugging(`[cu-esc-win32] Named pipe error: ${error}`, { level: 'warn' })
    cleanup()
  })
  server.listen(pipePath)
}

export function isWin32EscHotkeyRegistered(): boolean {
  return registered
}

/** Unregister is unconditional so pending registrations are cancelled too. */
export function unregisterWin32EscHotkey(): void {
  cleanup()
  logForDebugging('[cu-esc-win32] Unregistered')
}

function cleanup(): void {
  generation++
  pending = undefined
  registered = false
  onEscapeCallback = undefined
  for (const socket of pipeConnections) socket.destroy()
  pipeConnections.clear()
  pipeServer?.close()
  pipeServer = undefined
  const proc = psProcess
  psProcess = undefined
  try {
    proc?.kill()
  } catch {}
}

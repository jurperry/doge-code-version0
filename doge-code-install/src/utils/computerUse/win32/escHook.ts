/**
 * Windows ESC hotkey abort mechanism.
 *
 * Uses WH_KEYBOARD_LL (low-level keyboard hook) to intercept Escape key
 * system-wide. The hook lives in a PowerShell process with a message loop;
 * Node owns the named-pipe server and its lifecycle.
 *
 * Delivery is intentionally asynchronous: the low-level hook callback runs on
 * the hook thread, and a blocking named-pipe connect there both risks Windows'
 * LowLevelHooksTimeout and drops the Escape while the CLI main thread is busy
 * in a synchronous PowerShell action. The callback only enqueues; a dedicated
 * sender thread retries the pipe connection.
 *
 * Injected keys are NOT ignored wholesale: keyboard remappers, remote-desktop
 * clients and IMEs may synthesize the user's Escape. Only the CLI's own
 * model-synthesized Escape is suppressed, via a short-lived expectation
 * timestamp written by the real-input injection script immediately before the
 * model's key event (see platforms/win32.ts).
 */

import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logForDebugging } from '../../debug.js'

let psProcess: ReturnType<typeof Bun.spawn> | undefined
let pipeServer: Server | undefined
const pipeConnections = new Set<Socket>()
let registered = false
let generation = 0
let pending: Promise<Win32EscRegistrationResult> | undefined
let onEscapeCallback: (() => void) | undefined

export type Win32EscRegistrationResult = 'ok' | 'failed' | 'cancelled'

const PIPE_NAME = `cu-esc-hook-${process.pid}`
const EXPECT_FILE = join(tmpdir(), `doge-cu-esc-expect-${process.pid}.txt`)
/** The hook ignores an injected Escape only while this timestamp is fresh. */
const EXPECTED_ESCAPE_WINDOW_MS = 3000
const HANDSHAKE_TIMEOUT_MS = 10_000
let activePipeName = PIPE_NAME

/** Absolute path: Electron/Explorer launches do not always inherit a usable
 *  PATH for `powershell`, and a stale PowerShell 7 shim must not win. */
function powershellPath(): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const absolute = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return process.platform === 'win32' && existsSync(absolute) ? absolute : 'powershell'
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function readHandshake(proc: ReturnType<typeof Bun.spawn>): Promise<boolean> {
  const read = async (): Promise<boolean> => {
    const reader = proc.stdout.getReader()
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
      read(),
      proc.exited.then(() => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), HANDSHAKE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Install the hook and wait until its handshake proves it is usable. */
export async function registerWin32EscHotkey(onEscape: () => void): Promise<Win32EscRegistrationResult> {
  if (process.platform !== 'win32') return 'failed'
  if (registered) {
    onEscapeCallback = onEscape
    return 'ok'
  }
  onEscapeCallback = onEscape
  if (pending) return pending
  const ticket = ++generation
  // A fresh pipe name per registration avoids re-listening on a path whose
  // previous server is still closing (Node close is async; Bun's named-pipe
  // relisten can race). Ticket 1 keeps the historic name so external
  // diagnostics that resolve `<pid>` still work for a fresh session.
  const pipeName = ticket === 1 ? PIPE_NAME : `${PIPE_NAME}-${ticket}`
  const hookScript = `
Add-Type @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

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
    public const long EXPECTED_ESCAPE_WINDOW_MS = ${EXPECTED_ESCAPE_WINDOW_MS};

    private static IntPtr hookId = IntPtr.Zero;
    private static HookProc hookCallback;
    private static string pipeName;
    private static string expectFile;
    private static readonly BlockingCollection<string> queue = new BlockingCollection<string>();

    public static bool Install(string name, string expectedPath) {
        pipeName = name;
        expectFile = expectedPath;
        StartSender();
        hookCallback = new HookProc(HookCallback);
        hookId = SetWindowsHookEx(WH_KEYBOARD_LL, hookCallback, GetModuleHandle(Process.GetCurrentProcess().MainModule.ModuleName), 0);
        if (hookId == IntPtr.Zero) {
            Console.Error.WriteLine("HOOK_FAILED:" + Marshal.GetLastWin32Error());
            return false;
        }
        return true;
    }

    private static void StartSender() {
        var sender = new Thread(() => {
            foreach (var message in queue.GetConsumingEnumerable()) {
                // The expectation check runs here, not in the low-level hook
                // callback: a slow AV scan of %TEMP% must never delay the hook
                // past LowLevelHooksTimeout. FIFO order keeps a user Escape
                // queued behind the model's Escape from being swallowed.
                if (IsModelSynthesized()) {
                    ConsumeExpected();
                    continue;
                }
                for (int attempt = 0; attempt < 3; attempt++) {
                    try {
                        using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out)) {
                            client.Connect(2000);
                            byte[] bytes = Encoding.UTF8.GetBytes(message);
                            client.Write(bytes, 0, bytes.Length);
                            client.Flush();
                        }
                        break;
                    } catch {
                        Thread.Sleep(60);
                    }
                }
            }
        });
        sender.IsBackground = true;
        sender.Name = "cu-esc-sender";
        sender.Start();
    }

    private static bool IsModelSynthesized() {
        try {
            if (!File.Exists(expectFile)) return false;
            long stamp;
            if (!long.TryParse(File.ReadAllText(expectFile).Trim(), out stamp)) return false;
            long delta = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - stamp;
            return delta >= 0 && delta <= EXPECTED_ESCAPE_WINDOW_MS;
        } catch {
            return false;
        }
    }

    /** One model Escape consumes one expectation; the next user Escape aborts. */
    private static void ConsumeExpected() {
        try { File.Delete(expectFile); } catch {}
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int vkCode = Marshal.ReadInt32(lParam);
            int msgType = wParam.ToInt32();
            if (vkCode == VK_ESCAPE && (msgType == WM_KEYDOWN || msgType == WM_SYSKEYDOWN)) {
                queue.TryAdd("ESC");
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }
}

public class MsgPump {
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int px; public int py; }
    [DllImport("user32.dll")] public static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG lpMsg);
    public const int WM_QUIT = 0x0012;
    public static void Run() {
        // Print the handshake only after the pump is on the stack. Printing in
        // Install() lets the model/user inject Escape during the Add-Type gap,
        // when the hook is installed but no message loop is pumping yet.
        Console.WriteLine("HOOK_INSTALLED");
        Console.Out.Flush();
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0)) {
            if (m.message == WM_QUIT) break;
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
    }
}
'@

$pipeName = ${psQuote(pipeName)}
$expectFile = ${psQuote(EXPECT_FILE)}
if (-not [EscHook]::Install($pipeName, $expectFile)) { exit 1 }
[MsgPump]::Run()
`

  const operation = (async (): Promise<Win32EscRegistrationResult> => {
    try {
      const pipePath = '\\\\.\\pipe\\' + pipeName
      startPipeListener(pipePath)
      const proc = Bun.spawn([powershellPath(), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', hookScript], {
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      })
      psProcess = proc
      let stderrText = ''
      void (async () => {
        const reader = proc.stderr.getReader()
        const decoder = new TextDecoder()
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            stderrText += decoder.decode(value, { stream: true })
          }
        } catch {}
      })()
      const installed = await readHandshake(proc)
      if (generation !== ticket) return 'cancelled'
      if (!installed) {
        logForDebugging(`[cu-esc-win32] Handshake failed${stderrText ? `: ${stderrText.trim().slice(-400)}` : ''}`, { level: 'warn' })
        cleanup()
        return 'failed'
      }
      registered = true
      activePipeName = pipeName
      logForDebugging('[cu-esc-win32] Keyboard hook installed successfully')
      void proc.exited.then(() => {
        if (generation === ticket) cleanup()
      })
      return 'ok'
    } catch (error) {
      logForDebugging(`[cu-esc-win32] Registration error: ${error}`, { level: 'error' })
      if (generation === ticket) cleanup()
      return 'failed'
    }
  })()
  pending = operation
  try {
    return await operation
  } finally {
    if (pending === operation) pending = undefined
  }
}

/** The expectation file path used by the injection scripts in win32.ts. */
export function getWin32EscExpectFile(): string {
  return EXPECT_FILE
}

/** Current named-pipe name (ticket 1 is the historic `<pid>` name). */
export function getWin32EscPipeName(): string {
  return activePipeName
}

/** Suppress the next model-synthesized Escape without ignoring user-injected
 *  Escape from IMEs, keyboard remappers or remote-desktop clients.
 *
 *  Production writes this timestamp inside the injection PowerShell script,
 *  immediately before keybd_event. This helper is kept for the stand-alone
 *  regression test and any non-script caller. */
export function notifyWin32ExpectedEscape(): void {
  if (process.platform !== 'win32' || !registered) return
  try {
    const tmp = `${EXPECT_FILE}.tmp`
    writeFileSync(tmp, String(Date.now()))
    renameSync(tmp, EXPECT_FILE)
  } catch (error) {
    logForDebugging(`[cu-esc-win32] Could not record expected Escape: ${error}`, { level: 'warn' })
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
        try {
          onEscapeCallback()
        } catch (error) {
          logForDebugging(`[cu-esc-win32] ESC callback failed: ${error}`, { level: 'warn' })
        }
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
  activePipeName = PIPE_NAME
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
  try {
    rmSync(EXPECT_FILE, { force: true })
    rmSync(`${EXPECT_FILE}.tmp`, { force: true })
  } catch {}
}

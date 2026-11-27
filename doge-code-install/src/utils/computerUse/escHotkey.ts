import { logForDebugging } from '../debug.js'
import { releasePump, retainPump } from './drainRunLoop.js'
import { requireComputerUseSwift } from './swiftLoader.js'

/**
 * Global Escape → abort. Mirrors Cowork's `escAbort.ts` but without Electron:
 * CGEventTap via `@ant/computer-use-swift`. While registered, Escape is
 * consumed system-wide (PI defense — a prompt-injected action can't dismiss
 * a dialog with Escape).
 *
 * Lifecycle: register on fresh lock acquire (`wrapper.tsx` `acquireCuLock`),
 * re-check on every CU action (`ensureEscHotkey`), unregister on lock release
 * (`cleanup.ts`). The tap's CFRunLoopSource sits in .defaultMode on
 * CFRunLoopGetMain(), so we hold a drainRunLoop pump retain for the
 * registration's lifetime — same refcounted setInterval as the `@MainActor`
 * methods.
 *
 * `notifyExpectedEscape()` punches a hole for model-synthesized Escapes: the
 * executor's `key("escape")` calls it before posting the key. macOS schedules
 * a 100ms decay; Windows writes an expectation timestamp consumed by the
 * hook. User-injected Escape (IME / remapper / remote desktop) is NOT
 * suppressed — only the CLI's own model key action is.
 */

let registered = false
let lastFailureAt = 0
const RETRY_COOLDOWN_MS = 15_000

export async function registerEscHotkey(onEscape: () => void): Promise<boolean> {
  if (registered) {
    if (process.platform === 'win32') {
      const { isWin32EscHotkeyRegistered } = require('./win32/escHook.js') as typeof import('./win32/escHook.js')
      if (isWin32EscHotkeyRegistered()) return true
      registered = false
    } else {
      return true
    }
  }
  if (process.platform === 'win32' && Date.now() - lastFailureAt < RETRY_COOLDOWN_MS) {
    return false
  }

  // macOS: CGEventTap via Swift
  if (process.platform === 'darwin') {
    const cu = requireComputerUseSwift()
    if (!(cu as any).hotkey.registerEscape(onEscape)) {
      logForDebugging('[cu-esc] registerEscape returned false', { level: 'warn' })
      return false
    }
    retainPump()
    registered = true
    logForDebugging('[cu-esc] registered (macOS CGEventTap)')
    return true
  }

  // Windows: WH_KEYBOARD_LL via PowerShell
  if (process.platform === 'win32') {
    try {
      const { registerWin32EscHotkey, isWin32EscHotkeyRegistered } = require('./win32/escHook.js') as typeof import('./win32/escHook.js')
      const result = await registerWin32EscHotkey(onEscape)
      if (result === 'ok' && isWin32EscHotkeyRegistered()) {
        registered = true
        lastFailureAt = 0
        logForDebugging('[cu-esc] registered (Windows WH_KEYBOARD_LL)')
        return true
      }
      // A deliberate turn-end cancellation is not a failure and must not
      // impose the retry cooldown on the next CU turn. A helper that died
      // between handshake and this check is a failure.
      if (result === 'failed' || (result === 'ok' && !isWin32EscHotkeyRegistered())) {
        lastFailureAt = Date.now()
      }
      logForDebugging(`[cu-esc] Win32 hook registration ${result}`, { level: 'warn' })
      return false
    } catch (err) {
      lastFailureAt = Date.now()
      logForDebugging(`[cu-esc] Win32 hook error: ${err}`, { level: 'warn' })
      return false
    }
  }

  // Linux: not supported
  logForDebugging('[cu-esc] ESC hotkey not supported on this platform', { level: 'warn' })
  return false
}

/**
 * Cheap idempotent guard used before every CU action. Recovers when the
 * helper died after the lock was acquired, without spawning on healthy calls.
 */
export async function ensureEscHotkey(onEscape: () => void): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const { isWin32EscHotkeyRegistered } = require('./win32/escHook.js') as typeof import('./win32/escHook.js')
      if (registered && isWin32EscHotkeyRegistered()) return true
      registered = false
    } catch {
      registered = false
    }
  } else if (registered) {
    return true
  }
  return registerEscHotkey(onEscape)
}

export function unregisterEscHotkey(): void {
  if (process.platform === 'win32') {
    try {
      const { unregisterWin32EscHotkey } = require('./win32/escHook.js') as typeof import('./win32/escHook.js')
      unregisterWin32EscHotkey()
    } catch {}
    registered = false
    lastFailureAt = 0
    logForDebugging('[cu-esc] unregistered')
    return
  }
  if (!registered) return
  try {
    if (process.platform === 'darwin') {
      (requireComputerUseSwift() as any).hotkey.unregister()
    }
  } finally {
    if (process.platform === 'darwin') {
      releasePump()
    }
    registered = false
    logForDebugging('[cu-esc] unregistered')
  }
}

export function notifyExpectedEscape(): void {
  if (!registered) return
  if (process.platform === 'darwin') {
    ;(requireComputerUseSwift() as any).hotkey.notifyExpectedEscape()
  }
  // Windows: the expectation timestamp is written by the real-input injection
  // script itself (see platforms/win32.ts), immediately before keybd_event.
  // Writing it here would start the 3s window before the foreground guard
  // and Add-Type startup, and would suppress user Escape for SendMessage-only
  // key dispatch that never reaches the hook.
}

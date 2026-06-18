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
 * unregister on lock release (`cleanup.ts`). The tap's CFRunLoopSource sits
 * in .defaultMode on CFRunLoopGetMain(), so we hold a drainRunLoop pump
 * retain for the registration's lifetime — same refcounted setInterval as
 * the `@MainActor` methods.
 *
 * `notifyExpectedEscape()` punches a hole for model-synthesized Escapes: the
 * executor's `key("escape")` calls it before posting the CGEvent. Swift
 * schedules a 100ms decay so a CGEvent that never reaches the tap callback
 * doesn't eat the next user ESC.
 */

let registered = false

export function registerEscHotkey(onEscape: () => void): boolean {
  if (registered) return true

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
      const { registerWin32EscHotkey } = require('./win32/escHook.js') as typeof import('./win32/escHook.js')
      if (registerWin32EscHotkey(onEscape)) {
        registered = true
        logForDebugging('[cu-esc] registered (Windows WH_KEYBOARD_LL)')
        return true
      }
      logForDebugging('[cu-esc] Win32 hook registration failed', { level: 'warn' })
      return false
    } catch (err) {
      logForDebugging(`[cu-esc] Win32 hook error: ${err}`, { level: 'warn' })
      return false
    }
  }

  // Linux: not supported
  logForDebugging('[cu-esc] ESC hotkey not supported on this platform', { level: 'warn' })
  return false
}

export function unregisterEscHotkey(): void {
  if (!registered) return
  try {
    if (process.platform === 'darwin') {
      (requireComputerUseSwift() as any).hotkey.unregister()
    } else if (process.platform === 'win32') {
      try {
        const { unregisterWin32EscHotkey } = require('./win32/escHook.js') as typeof import('./win32/escHook.js')
        unregisterWin32EscHotkey()
      } catch {}
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
  // Windows: no hole-punching needed, WH_KEYBOARD_LL is passive (read-only)
}

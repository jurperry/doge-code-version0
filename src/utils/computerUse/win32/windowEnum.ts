/**
 * Window enumeration using Win32 EnumWindows API.
 * Returns visible windows with their HWND, PID, and title.
 */

import { parseIntegrityLevel, type IntegrityLevel } from './elevation.js'
import { enumerateWindows, foregroundWindow, processImage, processIntegrityRid, windowDetails, windowProcessId, windowText } from './nativeWindows.js'

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

function titledWindows(visibleOnly: boolean) {
  return enumerateWindows(visibleOnly).flatMap(({ hwnd, visible }) => {
    const title = windowText(hwnd)
    const pid = title.trim() ? windowProcessId(hwnd) : 0
    return pid ? [{ hwnd, pid, title, visible }] : []
  })
}

export function listWindows(includeProcessImage = false): WindowInfo[] {
  const images = new Map<number, string>()
  return titledWindows(true).map(({ hwnd, pid, title }) => {
    if (!includeProcessImage) return { hwnd, pid, title }
    if (!images.has(pid)) images.set(pid, processImage(pid))
    const path = images.get(pid)
    return { hwnd, pid, title, ...(path ? { path } : {}) }
  })
}

export function listWindowDetails(visibleOnly = true): WindowDetails[] {
  const foreground = foregroundWindow()
  const processes = new Map<number, { path: string; il: IntegrityLevel }>()
  return titledWindows(visibleOnly).map(window => {
    let identity = processes.get(window.pid)
    if (!identity) {
      identity = { path: processImage(window.pid), il: parseIntegrityLevel(String(processIntegrityRid(window.pid))) }
      processes.set(window.pid, identity)
    }
    return { ...window, ...identity, ...windowDetails(window.hwnd), foreground: window.hwnd === foreground }
  })
}

import { dlopen, JSCallback, read, type Pointer } from 'bun:ffi'
import { win32 as path } from 'node:path'
import type { DisplayInfo, FrontmostAppInfo } from '../platforms/types.js'

const FILETIME_EPOCH_MS = 11_644_473_600_000
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const GA_ROOT = 2

function loadWindows() {
  const user = dlopen('user32.dll', {
    EnumWindows: { args: ['ptr', 'isize'], returns: 'i32' },
    EnumChildWindows: { args: ['isize', 'ptr', 'isize'], returns: 'i32' },
    EnumDisplayMonitors: { args: ['ptr', 'ptr', 'ptr', 'isize'], returns: 'i32' },
    GetMonitorInfoW: { args: ['isize', 'ptr'], returns: 'i32' },
    MonitorFromWindow: { args: ['isize', 'u32'], returns: 'isize' },
    SetThreadDpiAwarenessContext: { args: ['isize'], returns: 'isize' },
    GetForegroundWindow: { args: [], returns: 'isize' },
    WindowFromPoint: { args: ['u64'], returns: 'isize' },
    GetAncestor: { args: ['isize', 'u32'], returns: 'isize' },
    GetWindowThreadProcessId: { args: ['isize', 'ptr'], returns: 'u32' },
    GetWindowTextW: { args: ['isize', 'ptr', 'i32'], returns: 'i32' },
    GetWindowRect: { args: ['isize', 'ptr'], returns: 'i32' },
    GetClassNameW: { args: ['isize', 'ptr', 'i32'], returns: 'i32' },
    GetWindowDpiAwarenessContext: { args: ['isize'], returns: 'isize' },
    GetAwarenessFromDpiAwarenessContext: { args: ['isize'], returns: 'i32' },
    IsWindowVisible: { args: ['isize'], returns: 'i32' },
    IsIconic: { args: ['isize'], returns: 'i32' },
  }).symbols
  const kernel = dlopen('kernel32.dll', {
    OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'isize' },
    CloseHandle: { args: ['isize'], returns: 'i32' },
    GetLastError: { args: [], returns: 'u32' },
    QueryFullProcessImageNameW: { args: ['isize', 'u32', 'ptr', 'ptr'], returns: 'i32' },
    GetProcessTimes: { args: ['isize', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
    CreateToolhelp32Snapshot: { args: ['u32', 'u32'], returns: 'isize' },
    Process32FirstW: { args: ['isize', 'ptr'], returns: 'i32' },
    Process32NextW: { args: ['isize', 'ptr'], returns: 'i32' },
  }).symbols
  const security = dlopen('advapi32.dll', {
    OpenProcessToken: { args: ['isize', 'u32', 'ptr'], returns: 'i32' },
    GetTokenInformation: { args: ['isize', 'i32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
    GetSidSubAuthorityCount: { args: ['ptr'], returns: 'ptr' },
    GetSidSubAuthority: { args: ['ptr', 'u32'], returns: 'ptr' },
  }).symbols
  return { user, kernel, security }
}

let libraries: ReturnType<typeof loadWindows> | undefined
const windows = () => libraries ??= loadWindows()

export function windowProcessId(hwnd: number): number {
  if (!hwnd) return 0
  const value = Buffer.alloc(4)
  return windows().user.GetWindowThreadProcessId(hwnd, value) ? value.readUInt32LE() : 0
}

function withProcess<T>(pid: number, fallback: T, read: (handle: number | bigint) => T): T {
  const { kernel } = windows()
  const handle = kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!handle) return fallback
  try { return read(handle) } finally { kernel.CloseHandle(handle) }
}

function processIdentity(pid: number) {
  if (!pid) return null
  return withProcess(pid, null, handle => {
    const { kernel } = windows()
    const image = Buffer.alloc(32768 * 2)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(image.length / 2)
    if (!kernel.QueryFullProcessImageNameW(handle, 0, image, length)) return null
    const id = image.toString('utf16le', 0, length.readUInt32LE() * 2)
    const created = Buffer.alloc(8)
    const other = Buffer.alloc(8)
    const startedAt = kernel.GetProcessTimes(handle, created, other, other, other)
      ? Number(created.readBigUInt64LE() / 10_000n) - FILETIME_EPOCH_MS : 0
    return { id, appName: path.basename(id, path.extname(id)), pid, startedAt }
  })
}

export function processImage(pid: number): string {
  return processIdentity(pid)?.id ?? ''
}

export function processIntegrityRid(pid: number): number {
  const { kernel, security } = windows()
  return withProcess(pid, -1, handle => {
    const value = Buffer.alloc(8)
    if (!security.OpenProcessToken(handle, 0x0008, value)) return kernel.GetLastError() === 5 ? -2 : -1
    const token = value.readBigUInt64LE()
    try {
      const length = Buffer.alloc(4)
      security.GetTokenInformation(token, 25, null, 0, length) // TokenIntegrityLevel
      const size = length.readUInt32LE()
      if (size < 16 || size > 1024) return -1
      const data = Buffer.alloc(size)
      if (!security.GetTokenInformation(token, 25, data, size, length)) return -1
      const sid = Number(data.readBigUInt64LE()) as Pointer
      const count = security.GetSidSubAuthorityCount(sid)
      if (!count) return -1
      const subAuthorities = read.u8(count)
      if (!subAuthorities) return -1
      const rid = security.GetSidSubAuthority(sid, subAuthorities - 1)
      return rid ? read.i32(rid) : -1
    } finally { kernel.CloseHandle(token) }
  })
}

/** Keep the ancestry check for embedded windows and reject reused parent PIDs. */
function isProcessAncestor(child: NonNullable<ReturnType<typeof processIdentity>>, ancestorPid: number): boolean {
  const { kernel } = windows()
  const snapshot = kernel.CreateToolhelp32Snapshot(2, 0) // TH32CS_SNAPPROCESS
  if (Number(snapshot) === -1) return false
  const parents = new Map<number, number>()
  try {
    // PROCESSENTRY32W on Win64. The pointer-sized heap ID is at offset 16.
    const entry = Buffer.alloc(568)
    entry.writeUInt32LE(entry.length)
    for (let found = kernel.Process32FirstW(snapshot, entry); found; found = kernel.Process32NextW(snapshot, entry)) {
      parents.set(entry.readUInt32LE(8), entry.readUInt32LE(32))
    }
  } finally { kernel.CloseHandle(snapshot) }
  let current = child
  for (let depth = 0; depth < 32; depth++) {
    const pid = parents.get(current.pid)
    if (!pid || pid === current.pid) return false
    const parent = processIdentity(pid)
    if (!parent?.startedAt || !current.startedAt || parent.startedAt > current.startedAt) return false
    if (pid === ancestorPid) return true
    current = parent
  }
  return false
}

function readTarget(hwnd: number): FrontmostAppInfo | null {
  const pid = windowProcessId(hwnd)
  const target = processIdentity(pid)
  if (!target) return null
  const root = Number(windows().user.GetAncestor(hwnd, GA_ROOT))
  const hostPid = windowProcessId(root || hwnd)
  if (!hostPid || windowProcessId(hwnd) !== pid) return null
  if (hostPid === pid) return target
  const host = processIdentity(hostPid)
  if (!host || host.id === target.id) return target
  return {
    ...target,
    hostId: host.id,
    hostName: host.appName,
    hostPid,
    hostStartedAt: host.startedAt,
    hostTrusted: isProcessAncestor(target, hostPid),
  }
}

export function foregroundWindow(): number {
  return Number(windows().user.GetForegroundWindow())
}

export function foregroundTarget(): FrontmostAppInfo | null {
  return readTarget(foregroundWindow())
}

export function targetAtPoint(x: number, y: number): FrontmostAppInfo | null {
  // Win64 passes the two signed int32 fields of POINT by value in one register.
  const point = (BigInt(Math.round(y) >>> 0) << 32n) | BigInt(Math.round(x) >>> 0)
  const { user } = windows()
  const previous = user.SetThreadDpiAwarenessContext(-4)
  if (!previous) return null
  let hwnd: number
  try { hwnd = Number(user.WindowFromPoint(point)) } finally { user.SetThreadDpiAwarenessContext(previous) }
  return readTarget(hwnd)
}

export function windowText(hwnd: number, kind: 'title' | 'class' = 'title'): string {
  const { user } = windows()
  const buffer = Buffer.alloc(1026)
  const getter = kind === 'title' ? user.GetWindowTextW : user.GetClassNameW
  const length = getter(hwnd, buffer, buffer.length / 2)
  return buffer.toString('utf16le', 0, length * 2)
}

export function enumerateWindows(visibleOnly: boolean) {
  const { user } = windows()
  const result: { hwnd: number; visible: boolean }[] = []
  const visit = new JSCallback((handle: number | bigint) => {
    const hwnd = Number(handle)
    const visible = user.IsWindowVisible(hwnd) !== 0
    if (visible || !visibleOnly) result.push({ hwnd, visible })
    return 1
  }, { args: ['isize', 'isize'], returns: 'i32' })
  try {
    if (!user.EnumWindows(visit.ptr, 0)) throw new Error('Windows could not enumerate the desktop windows.')
  } finally { visit.close() }
  return result
}

export function windowDetails(hwnd: number) {
  const { user } = windows()
  const dpi = user.GetAwarenessFromDpiAwarenessContext(user.GetWindowDpiAwarenessContext(hwnd))
  return { className: windowText(hwnd, 'class'), dpiAwareness: dpi >= 0 ? dpi : null, minimized: user.IsIconic(hwnd) !== 0 }
}

export function isWindowMinimized(hwnd: number): boolean {
  return windows().user.IsIconic(hwnd) !== 0
}

export function windowRectangle(hwnd: number): { width: number; height: number } | null {
  const { user } = windows()
  const rect = Buffer.alloc(16)
  const previous = user.SetThreadDpiAwarenessContext(-4)
  if (!previous) return null
  try {
    if (!user.GetWindowRect(hwnd, rect)) return null
    const width = rect.readInt32LE(8) - rect.readInt32LE(0)
    const height = rect.readInt32LE(12) - rect.readInt32LE(4)
    return width > 0 && height > 0 ? { width, height } : null
  } finally { user.SetThreadDpiAwarenessContext(previous) }
}

export function childWindowClasses(hwnd: number): string[] {
  const classes: string[] = []
  const visit = new JSCallback((handle: number | bigint) => {
    classes.push(windowText(Number(handle), 'class'))
    return 1
  }, { args: ['isize', 'isize'], returns: 'i32' })
  try { windows().user.EnumChildWindows(hwnd, visit.ptr, 0) } finally { visit.close() }
  return classes
}

export function monitorForWindow(hwnd: number): number | undefined {
  const handle = Number(windows().user.MonitorFromWindow(hwnd, 2)) // MONITOR_DEFAULTTONEAREST
  return enumerateDisplays().find(display => display.handle === handle)?.displayId
}

export function enumerateDisplays(): (DisplayInfo & { handle: number })[] {
  const { user } = windows()
  const displays: (DisplayInfo & { handle: number })[] = []
  const info = Buffer.alloc(40) // MONITORINFO
  info.writeUInt32LE(info.length)
  const previous = user.SetThreadDpiAwarenessContext(-4) // PER_MONITOR_AWARE_V2
  if (!previous) throw new Error('Windows could not switch to physical-pixel coordinates.')
  const visit = new JSCallback((handle: number | bigint) => {
    if (user.GetMonitorInfoW(handle, info)) {
      const originX = info.readInt32LE(4)
      const originY = info.readInt32LE(8)
      displays.push({ handle: Number(handle), displayId: displays.length, originX, originY,
        width: info.readInt32LE(12) - originX, height: info.readInt32LE(16) - originY,
        isPrimary: (info.readUInt32LE(36) & 1) !== 0, scaleFactor: 1 })
    }
    return 1
  }, { args: ['isize', 'ptr', 'ptr', 'isize'], returns: 'i32' })
  try {
    if (!user.EnumDisplayMonitors(null, null, visit.ptr, 0) || displays.length === 0) {
      throw new Error('Windows could not enumerate the desktop displays.')
    }
  } finally {
    user.SetThreadDpiAwarenessContext(previous)
    visit.close()
  }
  return displays
}

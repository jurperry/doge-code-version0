import { CString, dlopen, type Pointer, toArrayBuffer } from 'bun:ffi'
import type { DesktopState } from './uacWait.js'

function loadProbe() {
  const win = dlopen('user32.dll', {
    GetThreadDesktop: { args: ['u32'], returns: 'isize' },
    GetUserObjectInformationW: { args: ['isize', 'i32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
  }).symbols
  const kernel = dlopen('kernel32.dll', {
    GetCurrentThreadId: { args: [], returns: 'u32' },
    ProcessIdToSessionId: { args: ['u32', 'ptr'], returns: 'i32' },
    OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'isize' },
    CloseHandle: { args: ['isize'], returns: 'i32' },
  }).symbols
  const security = dlopen('advapi32.dll', {
    IsWellKnownSid: { args: ['ptr', 'i32'], returns: 'i32' },
  }).symbols
  const wts = dlopen('wtsapi32.dll', {
    WTSEnumerateProcessesA: { args: ['ptr', 'u32', 'u32', 'ptr', 'ptr'], returns: 'i32' },
    WTSFreeMemory: { args: ['ptr'], returns: 'void' },
  }).symbols
  const value = Buffer.alloc(4)
  if (!kernel.ProcessIdToSessionId(process.pid, value)) throw new Error('Could not identify the Windows session.')
  const session = value.readUInt32LE()
  const processes = Buffer.alloc(8)

  function hasConsent(): boolean {
    // AppInfo consent may deny ProcessIdToSessionId to a medium-IL caller.
    // WTS supplies the session ID in each record without opening the process.
    if (!wts.WTSEnumerateProcessesA(null, 0, 1, processes, value)) return false
    const address = Number(processes.readBigUInt64LE()) as Pointer
    const count = value.readUInt32LE()
    try {
      if (!address || count === 0) return false
      // WTS_PROCESS_INFOA on Win64: session, PID, process-name pointer, SID pointer.
      const entries = Buffer.from(toArrayBuffer(address, 0, count * 24))
      for (let offset = 0; offset < entries.length; offset += 24) {
        if (entries.readUInt32LE(offset) !== session) continue
        const name = Number(entries.readBigUInt64LE(offset + 8)) as Pointer
        const sid = Number(entries.readBigUInt64LE(offset + 16)) as Pointer
        if (!name || new CString(name).toString().toLowerCase() !== 'consent.exe') continue
        if (sid) {
          if (security.IsWellKnownSid(sid, 22)) return true // WinLocalSystemSid
          continue
        }
        // On a standard token WTS may redact the system process SID. A local
        // ordinary process with the same name is queryable and doesn't count.
        const handle = kernel.OpenProcess(0x1000, 0, entries.readUInt32LE(offset + 4))
        if (!handle) return true
        kernel.CloseHandle(handle)
      }
      return false
    } finally {
      wts.WTSFreeMemory(address)
    }
  }

  return (): DesktopState => {
    const desktop = win.GetThreadDesktop(kernel.GetCurrentThreadId())
    // UOI_IO asks about our own desktop, so no access to the secure desktop is needed.
    const interactive = desktop && win.GetUserObjectInformationW(desktop, 6, value, value.length, null) && value.readInt32LE() !== 0
    if (hasConsent()) return 'uac'
    return interactive ? 'ready' : 'unavailable'
  }
}

let probe: ReturnType<typeof loadProbe> | undefined

export function desktopState(): DesktopState {
  return (probe ??= loadProbe())()
}

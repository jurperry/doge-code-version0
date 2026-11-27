/** Reclaim descendants even when shell tools start their own process group. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'

export function descendantPids(rootPid: number, processList: string): number[] {
  const children = new Map<number, number[]>()
  for (const line of processList.trim().split(/\r?\n/)) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(parent) || pid <= 0) continue
    children.set(parent, [...children.get(parent) ?? [], pid])
  }
  const seen = new Set<number>([rootPid])
  const descendants: number[] = []
  const visit = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      visit(child)
      descendants.push(child)
    }
  }
  visit(rootPid)
  return descendants
}

export function killPosixProcessTree(rootPid: number): void {
  try {
    const listing = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 })
    for (const pid of descendantPids(rootPid, listing)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
    }
  } catch { /* use process group fallback */ }
  try { process.kill(-rootPid, 'SIGKILL') } catch {
    try { process.kill(rootPid, 'SIGKILL') } catch { /* already exited */ }
  }
}

function windowsDescendantPids(rootPid: number): number[] {
  try {
    const listing = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    return descendantPids(rootPid, listing)
  } catch {
    return []
  }
}

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', () => { try { child.kill() } catch { /* already exited */ } })
    for (const pid of windowsDescendantPids(child.pid)) {
      spawn('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
    }
  } else {
    killPosixProcessTree(child.pid)
  }
  child.stdin?.destroy()
}

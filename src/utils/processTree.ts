/** Reclaim descendants even when shell tools start their own process group. */
import { execFileSync } from 'node:child_process'

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

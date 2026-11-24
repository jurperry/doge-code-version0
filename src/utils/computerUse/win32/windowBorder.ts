import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionId } from '../../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../envUtils.js'
import { isLockHeldLocally } from '../computerUseLock.js'
import { isWindowForeground, setNativeWindowBorder, visibleWindowFrame, windowProcessId } from './nativeWindows.js'

const SAMPLE_INTERVAL_MS = 80
const GREEN = 0x0000c800 // COLORREF 0x00BBGGRR
const SYSTEM_BORDER_COLOR = 0xffffffff
const BINDING_FILE = 'computer-use-binding.json'

type Target = { hwnd: number; pid: number }
type IndicatorBounds = ReturnType<typeof visibleWindowFrame>

let target: Target | undefined
let timer: ReturnType<typeof setInterval> | undefined
let lastPayload: string | undefined

function publish(bounds: IndicatorBounds): void {
  const payload = JSON.stringify({ sessionId: getSessionId(), pid: process.pid, bounds })
  if (payload === lastPayload) return
  const file = join(getClaudeConfigHomeDir(), BINDING_FILE)
  const staging = join(getClaudeConfigHomeDir(), BINDING_FILE + '.' + process.pid + '.tmp')
  try {
    writeFileSync(staging, payload)
    renameSync(staging, file)
    lastPayload = payload
  } catch {
    try { rmSync(staging, { force: true }) } catch { /* best effort */ }
  }
}

function pollBounds(): void {
  if (!target || !isLockHeldLocally()) return
  try {
    const { hwnd, pid } = target
    const bounds = windowProcessId(hwnd) === pid && isWindowForeground(hwnd) ? visibleWindowFrame(hwnd) : null
    publish(bounds)
  } catch {
    publish(null)
  }
}

export function showBoundWindowIndicator(hwnd: number, pid: number): void {
  if (target?.hwnd === hwnd && target.pid === pid) return
  hideBoundWindowIndicator()
  target = { hwnd, pid }
  if (process.env.DOGE_APP_COMPUTER_USE_BORDER === '1') {
    if (!isLockHeldLocally()) {
      target = undefined
      return
    }
    pollBounds()
    timer = setInterval(pollBounds, SAMPLE_INTERVAL_MS)
    timer.unref()
  } else {
    try { if (windowProcessId(hwnd) === pid) setNativeWindowBorder(hwnd, GREEN) } catch { /* best effort */ }
  }
}

export function hideBoundWindowIndicator(): void {
  if (!target) return
  const { hwnd, pid } = target
  target = undefined
  if (timer) {
    clearInterval(timer)
    timer = undefined
    if (isLockHeldLocally()) publish(null)
    lastPayload = undefined
  } else {
    try { if (windowProcessId(hwnd) === pid) setNativeWindowBorder(hwnd, SYSTEM_BORDER_COLOR) } catch { /* best effort */ }
  }
}

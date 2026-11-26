import { isWindowForeground, targetAtPoint, visibleWindowFrame, windowProcessId } from '../src/utils/computerUse/win32/nativeWindows.js'
import { runComputerUsePowerShell } from '../src/utils/computerUse/win32/elevatedPowerShell.js'
import { bindWindow, platform, prepareWindowsTarget, unbindWindow } from '../src/utils/computerUse/platforms/win32.js'

export async function activateWindowsFixture(options: { hwnd: number; pid: number; appId: string; x?: number; y?: number }): Promise<void> {
  const { hwnd, pid, appId } = options
  const frame = visibleWindowFrame(hwnd)
  if (!frame) throw new Error('The fixture has no visible frame for physical activation')
  const point = { x: frame.x + (options.x ?? 60), y: frame.y + (options.y ?? 60) }
  if (windowProcessId(hwnd) !== pid) throw new Error('The fixture window identity changed before activation')
  unbindWindow()
  await prepareWindowsTarget(undefined, 'click', pid)
  const topmost = await runComputerUsePowerShell(`
Add-Type @'
using System;using System.Runtime.InteropServices;
public class CuFixturePlacement {
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@
[CuFixturePlacement]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0043)
`, 5000)
  if (topmost !== 'True') throw new Error('Could not place the isolated fixture above other test windows')
  const hit = targetAtPoint(point.x, point.y)
  if (!hit?.pid || (hit.pid !== pid && hit.hostPid !== pid)) {
    throw new Error(`Unexpected fixture activation target: expected=${pid}, hwnd=${hwnd}, frame=${JSON.stringify(frame)}, point=${JSON.stringify(point)}, hit=${JSON.stringify(hit)}`)
  }
  await prepareWindowsTarget(undefined, 'click', hit.pid)
  await platform.input.click(point.x, point.y, 'left', 1, false, false, hit.pid)
  bindWindow(hwnd, pid, appId)
  if (!isWindowForeground(hwnd)) throw new Error('The fixture did not become foreground after its physical activation click')
}

/**
 * Isolated WPF input e2e. Creates its own WPF window and never touches a user
 * application. All artifacts live under test/ and are removed in finally.
 *
 * Regression target: AnyCast-style `HwndWrapper[...]` windows must be
 * classified as WPF and receive real mouse/key input. The old classifier
 * treated them as plain Win32 windows, so every SendMessage click was a no-op.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const box = join(process.cwd(), 'test', 'tmp-cu-wpf-fixture')
const hwndFile = join(box, 'hwnd.txt')
const logFile = join(box, 'events.log')
const fixtureScript = join(box, 'fixture.ps1')
process.env.CLAUDE_CONFIG_DIR = join(box, 'config')
process.env.CLAUDE_CODE_TMPDIR = box
process.env.TEMP = box
process.env.TMP = box

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

rmSync(box, { recursive: true, force: true })
mkdirSync(box, { recursive: true })

writeFileSync(fixtureScript, String.raw`param(
  [string]$HwndFile = '',
  [string]$LogFile = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$window = New-Object System.Windows.Window
$window.Title = 'Doge CU WPF fixture'
$window.Width = 640
$window.Height = 480
$window.WindowStartupLocation = 'CenterScreen'
$button = New-Object System.Windows.Controls.Button
$button.Content = 'Click target'
$button.HorizontalAlignment = 'Stretch'
$button.VerticalAlignment = 'Stretch'
$button.Add_Click({ Add-Content -Path $LogFile -Value 'click' -Encoding utf8 })
$window.Add_PreviewMouseDown({
  param($sender, $evt)
  $p = $evt.GetPosition($window)
  Add-Content -Path $LogFile -Value ("previewdown " + [int]$p.X + ',' + [int]$p.Y + ' src=' + $evt.OriginalSource.GetType().Name) -Encoding utf8
})
$window.Add_PreviewKeyDown({
  param($sender, $evt)
  Add-Content -Path $LogFile -Value ("keydown " + $evt.Key) -Encoding utf8
})
$window.Content = $button
$window.Show()
$helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
[System.IO.File]::WriteAllText($HwndFile, $helper.Handle.ToString())
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMinutes(5)
$timer.Add_Tick({ $window.Close() })
$timer.Start()
[System.Windows.Threading.Dispatcher]::Run()
`, 'utf8')

const fixture = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript, '-HwndFile', hwndFile, '-LogFile', logFile], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let fixtureErr = ''
fixture.stderr.on('data', chunk => { fixtureErr += chunk })

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

try {
  for (let i = 0; i < 100 && !existsSync(hwndFile); i++) await pause(100)
  if (!existsSync(hwndFile)) throw new Error(`WPF fixture did not appear (${fixtureErr.slice(-500)})`)
  const hwnd = Number(readFileSync(hwndFile, 'utf8').trim())
  const { platform, bindWindow, unbindWindow, getBoundInputChannel } = await import('../src/utils/computerUse/platforms/win32.js')
  const { activateObservedWindow } = await import('../src/utils/computerUse/win32/windowGuard.js')

  bindWindow(hwnd, fixture.pid)
  const channel = getBoundInputChannel()
  check('WPF HwndWrapper classified as real-input', channel.framework === 'wpf' && channel.realMouse && channel.realKeyboard, JSON.stringify(channel))

  if (!fixture.pid || !await activateObservedWindow(hwnd, fixture.pid)) {
    throw new Error('Could not bring the isolated WPF fixture to the foreground before testing real input.')
  }
  await platform.input.click(320, 270, 'left', 1)
  await pause(700)
  const clicked = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  check('real-input click reaches the WPF button', clicked.includes('click'), clicked.trim())
  check('click arrives as native mouse input', clicked.includes('previewdown'), clicked.trim())

  await platform.input.key('escape', 'press')
  await pause(300)
  const keyed = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  check('real-input key reaches the WPF window', keyed.includes('keydown Escape'), keyed.trim())

  // Production Esc path: the model's Escape is marked by the injection script
  // itself; a user keybd_event has no expectation and must abort.
  const { registerWin32EscHotkey, unregisterWin32EscHotkey, getWin32EscExpectFile } = await import('../src/utils/computerUse/win32/escHook.js')
  let escapes = 0
  const escRegistered = await registerWin32EscHotkey(() => { escapes++ })
  check('Esc helper registers for the WPF fixture', escRegistered === 'ok')
  try {
    await pause(250)
    await platform.input.key('escape', 'press')
    await pause(400)
    check('model Escape is suppressed and its expectation consumed', escapes === 0 && !existsSync(getWin32EscExpectFile()))

    const injectScript = join(box, 'inject-user-esc.ps1')
    writeFileSync(injectScript, String.raw`Add-Type @'
using System;
using System.Runtime.InteropServices;
public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }
'@
[K]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[K]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
`, 'utf8')
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', injectScript], { windowsHide: true })
    for (let i = 0; i < 40 && escapes === 0; i++) await pause(50)
    check('user Escape still aborts after the model expectation', escapes === 1)

    await platform.input.keys(['shift', 'escape'])
    await pause(400)
    check('Escape chord is suppressed, not treated as an abort', escapes === 1)
  } finally {
    unregisterWin32EscHotkey()
  }
  unbindWindow()
} catch (error) {
  failures++
  console.error('WPF input e2e crashed:', error)
} finally {
  try { fixture.kill() } catch {}
  await pause(400)
  rmSync(box, { recursive: true, force: true })
}
console.log(failures === 0 ? `\nALL PASS (${checks})` : `\n${failures} FAIL / ${checks}`)
process.exitCode = failures === 0 ? 0 : 1

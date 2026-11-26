/**
 * Isolated Windows input e2e. Creates its own WinForms fixture and never
 * resolves or closes a user application. All artifacts live under test/ and
 * are removed in finally.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const ELEVATED = process.env.CU_FIXTURE_ELEVATED === '1'
// Attach the user's existing permanent broker for launch only, then isolate later config.
// Its runtime PID/log files remain user-owned and the permanent broker is never stopped.
const USE_EXISTING_PERMANENT = process.env.CU_FIXTURE_USE_EXISTING_PERMANENT === '1'
if (USE_EXISTING_PERMANENT && !ELEVATED) throw new Error('CU_FIXTURE_USE_EXISTING_PERMANENT requires CU_FIXTURE_ELEVATED=1')
const TMP_DIR = join(process.cwd(), 'test', ELEVATED ? 'tmp-cu-input-fixture-elevated' : 'tmp-cu-input-fixture')
const LOG_FILE = join(TMP_DIR, 'events.jsonl')
const HWND_FILE = join(TMP_DIR, 'hwnd.txt')
const EXIT_FILE = join(TMP_DIR, 'exit.txt')
if (!USE_EXISTING_PERMANENT) process.env.CLAUDE_CONFIG_DIR = join(TMP_DIR, 'config')
process.env.CLAUDE_CODE_TMPDIR = TMP_DIR
process.env.TEMP = TMP_DIR
process.env.TMP = TMP_DIR
process.env.CU_FIXTURE_LOG = LOG_FILE
process.env.CU_FIXTURE_HWND = HWND_FILE

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const fixtureCs = String.raw`
using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class CuInputControl : UserControl {
    public CuInputControl() {
        SetStyle(ControlStyles.Selectable, true);
        TabStop = true;
        BackColor = System.Drawing.Color.White;
        Dock = DockStyle.Fill;
        KeyPress += (sender, e) => CuLog.Write("keypress", "code=" + ((int)e.KeyChar));
        KeyDown += (sender, e) => CuLog.Write("keydown", "key=" + e.KeyCode + ";ctrl=" + ((ModifierKeys & Keys.Control) != 0));
        KeyUp += (sender, e) => CuLog.Write("keyup", "key=" + e.KeyCode + ";ctrl=" + ((ModifierKeys & Keys.Control) != 0));
        MouseDown += (sender, e) => CuLog.Write("mousedown", "button=" + e.Button + ";clicks=" + e.Clicks + ";x=" + e.X + ";y=" + e.Y + ";shift=" + ((ModifierKeys & Keys.Shift) != 0));
        MouseUp += (sender, e) => CuLog.Write("mouseup", "button=" + e.Button);
        MouseWheel += (sender, e) => CuLog.Write("wheel", "delta=" + e.Delta);
    }
}
public class CuFixtureForm : Form {
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0207 || m.Msg == 0x0208) CuLog.Write("middle", "msg=" + m.Msg);
        if (m.Msg == 0x0201 || m.Msg == 0x0202) {
            int x = (short)(m.LParam.ToInt64() & 0xFFFF);
            int y = (short)((m.LParam.ToInt64() >> 16) & 0xFFFF);
            CuLog.Write("leftmsg", "msg=" + m.Msg + ";x=" + x + ";y=" + y);
        }
        if (m.Msg == 0x0115 || m.Msg == 0x0114) CuLog.Write("scroll", "msg=" + m.Msg + ";param=" + m.WParam.ToInt64());
        base.WndProc(ref m);
    }
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        var input = new CuInputControl();
        Controls.Add(input);
        input.Focus();
        File.WriteAllText(Environment.GetEnvironmentVariable("CU_FIXTURE_HWND"), Handle.ToString(), Encoding.UTF8);
    }
}
public static class CuLog {
    public static void Write(string kind, string detail) {
        string line = "{\"kind\":\"" + kind + "\",\"detail\":\"" + detail.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"}\n";
        File.AppendAllText(Environment.GetEnvironmentVariable("CU_FIXTURE_LOG"), line, new UTF8Encoding(false));
    }
}
`
const fixtureScript = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
${fixtureCs}
'@
$form = New-Object CuFixtureForm
$form.Text = 'Doge CU isolated input fixture'
$form.Width = 640
$form.Height = 480
$form.StartPosition = 'CenterScreen'
[void]$form.Show()
$lifetime = New-Object System.Windows.Forms.Timer
$lifetime.Interval = 300000
$lifetime.add_Tick({ $form.Close() })
$lifetime.Start()
[System.Windows.Forms.Application]::Run($form)
`

type Event = { kind: string; detail: string }
function events(path = LOG_FILE): Event[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}
function clearEvents(): void {
  writeFileSync(LOG_FILE, '', 'utf8')
}
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}; events=${JSON.stringify(events())}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

let proc: ReturnType<typeof Bun.spawn> | undefined
let overlayProc: ReturnType<typeof Bun.spawn> | undefined
let secondaryProc: ReturnType<typeof Bun.spawn> | undefined
let secondaryPid = 0
let fixturePid = 0
let overlayHighPid = 0
let unbind: (() => void) | undefined
try {
  mkdirSync(TMP_DIR, { recursive: true })
  rmSync(EXIT_FILE, { force: true })
  rmSync(HWND_FILE, { force: true })
  clearEvents()
  if (ELEVATED) {
    const sourcePath = join(TMP_DIR, 'fixture.cs')
    const fixturePath = join(TMP_DIR, 'fixture.exe')
    const program = String.raw`
public static class CuFixtureProgram {
    [STAThread] public static void Main() {
        var form = new CuFixtureForm();
        form.Text = "Doge CU isolated input fixture";
        form.Width = 640;
        form.Height = 480;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.Show();
        var deadline = DateTime.UtcNow.AddMinutes(5);
        var lifetime = new Timer { Interval = 100 };
        lifetime.Tick += (sender, args) => {
            if (DateTime.UtcNow >= deadline || File.Exists(${JSON.stringify(EXIT_FILE)})) form.Close();
        };
        lifetime.Start();
        Application.Run(form);
    }
}
`
    const elevatedCs = fixtureCs
      .replaceAll('Environment.GetEnvironmentVariable("CU_FIXTURE_LOG")', JSON.stringify(LOG_FILE))
      .replaceAll('Environment.GetEnvironmentVariable("CU_FIXTURE_HWND")', JSON.stringify(HWND_FILE))
    writeFileSync(sourcePath, `${elevatedCs}\n${program}`, 'utf8')
    const { runPowerShell } = await import('../src/utils/computerUse/win32/powerShell.js')
    await runPowerShell(`
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
& $compiler /nologo /target:winexe /out:'${fixturePath.replace(/'/g, "''")}' /reference:System.Windows.Forms.dll /reference:System.Drawing.dll '${sourcePath.replace(/'/g, "''")}'
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the elevated input fixture' }
`, 20_000)
    if (USE_EXISTING_PERMANENT) {
      const { getPermanentElevationStatus } = await import('../src/utils/computerUse/win32/permanentElevation.js')
      const status = getPermanentElevationStatus()
      if (!status.enabled || status.needsRepair) throw new Error('This unattended mode requires an existing permanent Computer Use authorization')
      const { ensureElevatedPowerShell, runComputerUsePowerShell, setComputerUseTargetElevated } = await import('../src/utils/computerUse/win32/elevatedPowerShell.js')
      await ensureElevatedPowerShell()
      setComputerUseTargetElevated(true)
      const rawPid = await runComputerUsePowerShell(`Start-Process -FilePath '${fixturePath.replace(/'/g, "''")}' -PassThru -ErrorAction Stop | Select-Object -ExpandProperty Id`)
      fixturePid = Number(rawPid.trim())
      process.env.CLAUDE_CONFIG_DIR = join(TMP_DIR, 'config')
      setComputerUseTargetElevated(false)
    } else {
      const rawPid = await runPowerShell(`Start-Process -FilePath '${fixturePath.replace(/'/g, "''")}' -Verb RunAs -PassThru -ErrorAction Stop | Select-Object -ExpandProperty Id`, 60_000)
      fixturePid = Number(rawPid.trim())
    }
  } else {
    proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-STA', '-Command', fixtureScript], {
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env },
    })
    fixturePid = proc.pid
  }
  if (!Number.isInteger(fixturePid) || fixturePid <= 0) throw new Error('Fixture did not return a process ID')
  await waitFor(() => existsSync(HWND_FILE) && readFileSync(HWND_FILE, 'utf8').trim().length > 0, 'fixture HWND')

  const { bindWindow, unbindWindow, getBoundHwnd, platform, prepareWindowsTarget } = await import('../src/utils/computerUse/platforms/win32.js')
  const { sendClick, sendMouseButton, sendScroll } = await import('../src/utils/computerUse/win32/windowMessage.js')
  const { activateObservedWindow } = await import('../src/utils/computerUse/win32/windowGuard.js')
  const { runPowerShell: runLocalPowerShell } = await import('../src/utils/computerUse/win32/powerShell.js')
  const { runComputerUsePowerShell } = await import('../src/utils/computerUse/win32/elevatedPowerShell.js')
  const runPowerShell = ELEVATED ? runComputerUsePowerShell : runLocalPowerShell
  const { createCliExecutor } = await import('../src/utils/computerUse/executor.js')
  const hwnd = Number(readFileSync(HWND_FILE, 'utf8').trim())
  bindWindow(hwnd, fixturePid, 'fixture.app')
  unbind = unbindWindow
  if (ELEVATED) await prepareWindowsTarget()
  const executor = createCliExecutor({
    getMouseAnimationEnabled: () => false,
    getHideBeforeActionEnabled: () => false,
  })
  const boundShot = await executor.screenshot({ allowedBundleIds: ['fixture.app'] })
  check('bound-window PrintWindow returns valid local-space dimensions', boundShot.base64.length > 0
    && boundShot.width > 0 && boundShot.height > 0 && boundShot.originX === 0 && boundShot.originY === 0)
  const boundZoom = await executor.zoom({ x: 0, y: 0, w: 20, h: 20 }, ['fixture.app'], 0, { x: 0, y: 0 })
  check('bound-window zoom returns a non-empty crop', boundZoom.base64.length > 0 && boundZoom.width > 0 && boundZoom.height > 0)

  const boundPath = join(TMP_DIR, 'bound.jpg')
  writeFileSync(boundPath, Buffer.from(boundShot.base64, 'base64'))
  const pixel = await runPowerShell(`
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile('${boundPath.replace(/'/g, "''")}')
$p = $bmp.GetPixel([Math]::Min(100, $bmp.Width - 1), [Math]::Min(100, $bmp.Height - 1))
$bmp.Dispose()
"$($p.R),$($p.G),$($p.B)"
`)
  const channels = pixel.split(',').map(Number)
  check('bound-window capture contains the white fixture rather than a black frame', channels.every(value => value > 200), pixel)

  const bottomRight = await runPowerShell(`
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile('${boundPath.replace(/'/g, "''")}')
$x = [Math]::Floor($bmp.Width * 0.9)
$y = [Math]::Floor($bmp.Height * 0.9)
$p = $bmp.GetPixel($x, $y)
$dimensions = "$($bmp.Width),$($bmp.Height)"
$bmp.Dispose()
"$($p.R),$($p.G),$($p.B);$dimensions"
`)
  const [bottomPixel, actualDimensions] = bottomRight.split(';')
  check('DPI-unaware capture normalizes content across the full declared canvas', bottomPixel.split(',').map(Number).every(value => value > 200), bottomPixel)
  check('encoded JPEG dimensions match the declared screenshot dimensions', actualDimensions === `${boundShot.width},${boundShot.height}`, `${actualDimensions} vs ${boundShot.width},${boundShot.height}`)

  const geometry = await runPowerShell(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuFixtureGeometry {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
}
'@
[CuFixtureGeometry]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$r = New-Object CuFixtureGeometry+RECT
$p = New-Object CuFixtureGeometry+POINT
[CuFixtureGeometry]::GetWindowRect([IntPtr]${hwnd}, [ref]$r) | Out-Null
[CuFixtureGeometry]::ClientToScreen([IntPtr]${hwnd}, [ref]$p) | Out-Null
$monitor = [CuFixtureGeometry]::MonitorFromWindow([IntPtr]${hwnd}, 2)
$dpiX = [uint32]0
$dpiY = [uint32]0
[CuFixtureGeometry]::GetDpiForMonitor($monitor, 0, [ref]$dpiX, [ref]$dpiY) | Out-Null
$awareness = [CuFixtureGeometry]::GetAwarenessFromDpiAwarenessContext([CuFixtureGeometry]::GetWindowDpiAwarenessContext([IntPtr]${hwnd}))
"$($p.X - $r.L),$($p.Y - $r.T),$dpiX,$awareness"
`)
  const geometryParts = geometry.split(',').map(Number)
  const [clientOffsetX, clientOffsetY, windowDpi, windowAwareness] = geometryParts
  check('fixture exercises the DPI-unaware non-96-DPI capture path', windowAwareness === 0 && windowDpi > 96, `awareness=${windowAwareness}, monitorDpi=${windowDpi}`)
  const clickPoint = {
    x: Math.round(boundShot.displayWidth! * 0.75),
    y: Math.round(boundShot.displayHeight! * 0.75),
  }
  const expectedClient = {
    x: Math.round((clickPoint.x - clientOffsetX) * 96 / windowDpi),
    y: Math.round((clickPoint.y - clientOffsetY) * 96 / windowDpi),
  }
  clearEvents()
  await sendClick(hwnd, clickPoint.x, clickPoint.y, 'left', fixturePid)
  const coordinatedDown = events().find(event => event.kind === 'leftmsg' && event.detail.startsWith('msg=513'))
  const actualClient = coordinatedDown
    ? { x: Number(coordinatedDown.detail.match(/;x=(\d+)/)?.[1]), y: Number(coordinatedDown.detail.match(/;y=(\d+)/)?.[1]) }
    : null
  check('background SendMessage maps physical screenshot coordinates to the DPI-unaware client', JSON.stringify(actualClient) === JSON.stringify(expectedClient), `expected=${JSON.stringify(expectedClient)}, actual=${JSON.stringify(actualClient)}`)

  await runPowerShell(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuFixtureCursor {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
'@
[CuFixtureCursor]::SetProcessDPIAware() | Out-Null
$r = New-Object CuFixtureCursor+RECT
[CuFixtureCursor]::GetWindowRect([IntPtr]${hwnd}, [ref]$r) | Out-Null
[CuFixtureCursor]::SetCursorPos($r.L + 120, $r.T + 90) | Out-Null
`)
  const liveCursor = await executor.getCursorPosition()
  check('cursor_position reads the live cursor in bound-window coordinates', liveCursor.x === 120 && liveCursor.y === 90, JSON.stringify(liveCursor))

  await runPowerShell(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuFixtureWindow {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
[CuFixtureWindow]::ShowWindow([IntPtr]${hwnd}, 6) | Out-Null
`)
  const minimizedShot = await executor.screenshot({ allowedBundleIds: ['fixture.app'] })
  const minimizedPath = join(TMP_DIR, 'minimized.jpg')
  writeFileSync(minimizedPath, Buffer.from(minimizedShot.base64, 'base64'))
  const minimizedPixel = await runPowerShell(`
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile('${minimizedPath.replace(/'/g, "''")}')
$p = $bmp.GetPixel([Math]::Floor($bmp.Width * 0.9), [Math]::Floor($bmp.Height * 0.9))
$bmp.Dispose()
"$($p.R),$($p.G),$($p.B)"
`)
  check('minimized capture preserves normalized content as well as window state', minimizedPixel.split(',').map(Number).every(value => value > 200), minimizedPixel)
  const minimized = await runPowerShell(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuFixtureMin {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
[CuFixtureMin]::IsIconic([IntPtr]${hwnd})
`)
  check('minimized-window capture restores the original minimized state', minimizedShot.base64.length > 0 && minimized.trim() === 'True', minimized)
  let activation = await activateObservedWindow(hwnd, fixturePid)
  if (!activation) {
    const { activateWindowsFixture } = await import('./windows-fixture-activation.js')
    await activateWindowsFixture({ hwnd, pid: fixturePid, appId: 'fixture.app' })
    activation = true
  }
  check('fixture can be foregrounded again after minimized capture', activation)

  // Foregrounding the form does not focus its child input after a restore.
  clearEvents()
  await executor.click(60, 60, 'left', 1)
  await waitFor(() => events().some(e => e.kind === 'mousedown'), 'focus restored child control')
  clearEvents()
  await executor.type('A中😀!', { viaClipboard: false })
  await waitFor(() => events().filter(e => e.kind === 'keypress').length >= 5, 'Unicode keypress events')
  const chars = String.fromCharCode(...events().filter(e => e.kind === 'keypress').map(e => Number(e.detail.slice('code='.length))))
  check('real Unicode input preserves ASCII, Chinese and emoji', chars === 'A中😀!', JSON.stringify(chars))

  clearEvents()
  const longText = '中😀'.repeat(400)
  await executor.type(longText, { viaClipboard: false })
  await waitFor(() => events().filter(e => e.kind === 'keypress').length >= longText.length, 'long Unicode input via stdin', 20_000)
  const longChars = String.fromCharCode(...events().filter(e => e.kind === 'keypress').map(e => Number(e.detail.slice('code='.length))))
  check('long Unicode input avoids command-line expansion and preserves every code unit', longChars === longText, `${longChars.length}/${longText.length} code units`)

  clearEvents()
  await executor.key('ctrl+a')
  await waitFor(() => events().some(e => e.kind === 'keydown' && e.detail === 'key=A;ctrl=True')
    && events().some(e => e.kind === 'keyup' && e.detail === 'key=ControlKey;ctrl=False'), 'Ctrl+A and modifier release')
  check('real chord keeps Ctrl held while A is pressed and releases it afterward', true)

  for (const count of [2, 3] as const) {
    clearEvents()
    await executor.click(60, 60, 'left', count)
    await waitFor(() => events().filter(e => e.kind === 'mousedown').length >= count, `${count}-click events`)
    const downEvents = events().filter(e => e.kind === 'mousedown' && e.detail.startsWith('button=Left'))
    const downs = downEvents.length
    const ups = events().filter(e => e.kind === 'mouseup' && e.detail === 'button=Left').length
    const systemCounts = downEvents.map(e => Number(e.detail.match(/clicks=(\d+)/)?.[1]))
    check(`${count}-click emits exactly ${count} down/up pairs`, downs === count && ups === count, `down=${downs}, up=${ups}`)
    const nativeSequenceOk = count === 2
      ? systemCounts.at(-1) === 2
      : systemCounts.length === 3 && systemCounts[0] === 1 && systemCounts[1] === 2
    check(`${count}-click reaches the expected Windows click sequence`, nativeSequenceOk, `counts=${systemCounts.join(',')}`)
    const clickedCursor = await executor.getCursorPosition()
    check(`${count}-click leaves the live cursor at the requested window point`, clickedCursor.x === 60 && clickedCursor.y === 60, JSON.stringify(clickedCursor))
  }

  clearEvents()
  await executor.click(60, 60, 'middle', 1)
  await waitFor(() => events().some(e => e.kind === 'mouseup' && e.detail === 'button=Middle'), 'real middle-button release')
  check('middle-click delivers physical middle-button down/up to the child control',
    events().some(e => e.kind === 'mousedown' && e.detail.startsWith('button=Middle;')), JSON.stringify(events()))

  clearEvents()
  await sendClick(hwnd, 60, 60, 'middle', fixturePid)
  const middle = events().filter(e => e.kind === 'middle').map(e => e.detail).join(',')
  check('background middle-click emits WM_MBUTTONDOWN/UP', middle.includes('msg=519') && middle.includes('msg=520'), middle)

  clearEvents()
  await executor.click(75, 75, 'left', 1, ['shift'])
  await waitFor(() => events().some(e => e.kind === 'mousedown'), 'modified bound click')
  check('bound Shift-click delivers the physical modifier to the WinForms child',
    events().some(e => e.kind === 'mousedown' && e.detail.endsWith(';shift=True')), JSON.stringify(events()))

  clearEvents()
  await executor.mouseDown()
  await executor.mouseUp()
  await waitFor(() => events().some(e => e.kind === 'mousedown') && events().some(e => e.kind === 'mouseup'), 'paired WinForms mouse down/up')
  check('WinForms decomposed press and release use the real mouse channel', events().filter(e => e.kind === 'mousedown' || e.kind === 'mouseup').length === 2)

  clearEvents()
  await sendMouseButton(hwnd, 75, 75, 'left', 'down', fixturePid)
  await sendMouseButton(hwnd, 75, 75, 'left', 'up', fixturePid)
  await waitFor(() => events().filter(e => e.kind === 'leftmsg').length >= 2, 'paired background mouse down/up')
  const leftMessages = events().filter(e => e.kind === 'leftmsg').map(e => e.detail).join(',')
  check('background mouse-down and mouse-up use the same SendMessage channel', leftMessages.includes('msg=513') && leftMessages.includes('msg=514'), leftMessages)

  for (const [dx, dy, msg, param, label] of [
    [0, 1, 277, 1, 'down'],
    [0, -1, 277, 0, 'up'],
    [-1, 0, 276, 0, 'left'],
    [1, 0, 276, 1, 'right'],
  ] as const) {
    clearEvents()
    await sendScroll(hwnd, dx || dy, dx ? 'horizontal' : 'vertical', fixturePid)
    await waitFor(() => events().some(e => e.kind === 'scroll'), `scroll ${label}`)
    const actual = events().find(e => e.kind === 'scroll')!.detail
    check(`scroll ${label} uses the native direction`, actual === `msg=${msg};param=${param}`, actual)
  }

  const { handleToolCall, DEFAULT_GRANT_FLAGS } = await import('@ant/computer-use-mcp')
  const { getComputerUseHostAdapter } = await import('../src/utils/computerUse/hostAdapter.js')
  const adapter = getComputerUseHostAdapter()
  const switched = await handleToolCall(adapter, 'switch_display', { display: 'auto' }, {
    allowedApps: [{ bundleId: 'fixture.app', displayName: 'Native fixture', grantedAt: 1, tier: 'full' }],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    userDeniedBundleIds: [],
    coordinateMode: 'pixels',
    lastScreenshot: boundShot,
    onDisplayPinned: () => {},
  })
  check('switch_display(auto) leaves window mode through the real tool handler', !switched.isError && getBoundHwnd() === null)

  const originalListAll = platform.display.listAll
  let displayEnumerations = 0
  platform.display.listAll = () => {
    displayEnumerations++
    return originalListAll()
  }
  let globalShot
  try {
    globalShot = await executor.screenshot({ allowedBundleIds: ['fixture.app'] })
  } finally {
    platform.display.listAll = originalListAll
  }
  check('full-display capture needs no separate synchronous display enumeration', displayEnumerations === 0, String(displayEnumerations))
  check('full-display capture uses the display rather than the old window dimensions', globalShot.base64.length > 0
    && globalShot.displayWidth! > boundShot.displayWidth! && globalShot.displayHeight! > boundShot.displayHeight!)

  const rect = await runPowerShell(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuGlobalRect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    public static bool SetProcessDPIAware() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        if (!AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4))) throw new System.Exception("Per-monitor-v2 required");
        return true;
    }
}
'@
[CuGlobalRect]::SetProcessDPIAware() | Out-Null
$r = New-Object CuGlobalRect+RECT
if (-not [CuGlobalRect]::GetWindowRect([IntPtr]${hwnd}, [ref]$r)) { throw 'GetWindowRect failed' }
"$($r.L),$($r.T)"
`)
  const [windowLeft, windowTop] = rect.split(',').map(Number)
  const globalPoint = (x: number, y: number) => ({ x: windowLeft + x, y: windowTop + y })
  const imageCoordinate = (point: { x: number; y: number }, shot = globalShot): [number, number] => [
    Math.round((point.x - shot.originX) * shot.width / shot.displayWidth!),
    Math.round((point.y - shot.originY) * shot.height / shot.displayHeight!),
  ]

  await executor.moveMouse(0, 0)
  const corner = await executor.getCursorPosition()
  check('global mouse_move reaches the physical screen top-left', corner.x === 0 && corner.y === 0, JSON.stringify(corner))

  clearEvents()
  const globalClick = globalPoint(90, 100)
  const hitTarget = platform.apps.getAppAtPoint?.(globalClick.x, globalClick.y)
  check('global target resolver returns the actual/root window identity', !!hitTarget?.id.toLowerCase().endsWith(ELEVATED ? 'fixture.exe' : 'powershell.exe'), JSON.stringify(hitTarget))
  await executor.click(globalClick.x, globalClick.y, 'left', 1)
  await waitFor(() => events().some(e => e.kind === 'mousedown'), 'global click')
  const globalDown = events().find(e => e.kind === 'mousedown')
  const globalClient = globalDown
    ? { x: Number(globalDown.detail.match(/;x=(\d+)/)?.[1]), y: Number(globalDown.detail.match(/;y=(\d+)/)?.[1]) }
    : null
  const expectedGlobalClient = {
    x: Math.round((90 - clientOffsetX) * 96 / windowDpi),
    y: Math.round((100 - clientOffsetY) * 96 / windowDpi),
  }
  check('global click applies no stale bound-window offset and preserves DPI mapping', JSON.stringify(globalClient) === JSON.stringify(expectedGlobalClient), `expected=${JSON.stringify(expectedGlobalClient)}, actual=${JSON.stringify(globalClient)}`)

  clearEvents()
  await executor.moveMouse(globalClick.x, globalClick.y)
  await executor.mouseDown()
  await executor.mouseUp()
  await waitFor(() => events().some(e => e.kind === 'mousedown') && events().some(e => e.kind === 'mouseup'), 'global down/up')
  check('global mouse down/up work without an HWND', events().filter(e => e.kind === 'mousedown').length === 1
    && events().filter(e => e.kind === 'mouseup').length === 1)

  clearEvents()
  const dragEnd = globalPoint(140, 160)
  await executor.drag(globalClick, dragEnd)
  await waitFor(() => events().some(e => e.kind === 'mousedown') && events().some(e => e.kind === 'mouseup'), 'global drag')
  const dragCursor = await executor.getCursorPosition()
  check('global drag reaches its destination and releases the button', events().filter(e => e.kind === 'mousedown').length === 1
    && events().filter(e => e.kind === 'mouseup').length === 1 && dragCursor.x === dragEnd.x && dragCursor.y === dragEnd.y, JSON.stringify(dragCursor))

  clearEvents()
  await executor.scroll(globalClick.x, globalClick.y, 0, 1)
  await waitFor(() => events().some(e => e.kind === 'wheel'), 'global wheel')
  check('global scroll reaches the foreground control', events().some(e => e.kind === 'wheel' && e.detail === 'delta=-120'), JSON.stringify(events()))

  clearEvents()
  await executor.type('G全😀', { viaClipboard: false })
  await waitFor(() => events().filter(e => e.kind === 'keypress').length >= 4, 'global Unicode input')
  const globalChars = String.fromCharCode(...events().filter(e => e.kind === 'keypress').map(e => Number(e.detail.slice('code='.length))))
  check('global Unicode input works without a bound HWND', globalChars === 'G全😀', JSON.stringify(globalChars))

  clearEvents()
  await executor.key('ctrl+a')
  await waitFor(() => events().some(e => e.kind === 'keydown' && e.detail === 'key=A;ctrl=True')
    && events().some(e => e.kind === 'keyup' && e.detail === 'key=ControlKey;ctrl=False'), 'global Ctrl+A')
  check('global key chords reach the foreground control and release modifiers', true)

  clearEvents()
  await executor.holdKey(['ctrl', 'a'], 60)
  await waitFor(() => events().some(e => e.kind === 'keydown' && e.detail === 'key=A;ctrl=True')
    && events().some(e => e.kind === 'keyup' && e.detail === 'key=ControlKey;ctrl=False'), 'global key hold')
  check('global holdKey uses the same unbound press/release channel', true)

  check('global clipboard read does not require a bound HWND or modify its contents', typeof (await executor.readClipboard()) === 'string')

  const frontmost = await executor.getFrontmostApp()
  if (!frontmost) throw new Error('Fixture foreground identity was not available for global batch')
  if (ELEVATED) {
    const { getProcessIL } = await import('../src/utils/computerUse/win32/elevation.js')
    const { isComputerUseTargetElevated } = await import('../src/utils/computerUse/win32/elevatedPowerShell.js')
    check('fixture and the current action really have different integrity levels', getProcessIL(fixturePid) === 'high', getProcessIL(fixturePid))
    check('global keyboard preparation selects the elevated helper', isComputerUseTargetElevated())
  }
  const standaloneClick = globalPoint(95, 105)
  clearEvents()
  const standalone = await handleToolCall(adapter, 'left_click', { coordinate: imageCoordinate(standaloneClick) }, {
    allowedApps: [{ bundleId: frontmost.bundleId, displayName: frontmost.displayName, grantedAt: 1, tier: 'full' }],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    userDeniedBundleIds: [],
    coordinateMode: 'pixels',
    lastScreenshot: globalShot,
  })
  check('standalone full-display left_click closes the authorized input loop', !standalone.isError
    && events().some(event => event.kind === 'mousedown'), JSON.stringify(standalone.content))
  if (ELEVATED) {
    const { isComputerUseTargetElevated } = await import('../src/utils/computerUse/win32/elevatedPowerShell.js')
    check('standalone full-display left_click retains the elevated execution route', isComputerUseTargetElevated())
  } else {
    const { isComputerUseTargetElevated } = await import('../src/utils/computerUse/win32/elevatedPowerShell.js')
    check('ordinary full-display input remains on the local route', !isComputerUseTargetElevated())
  }
  const hover = await handleToolCall(adapter, 'mouse_move', { coordinate: imageCoordinate({ x: 0, y: 0 }) }, {
    allowedApps: [{ bundleId: frontmost.bundleId, displayName: frontmost.displayName, grantedAt: 1, tier: 'full' }],
    grantFlags: { ...DEFAULT_GRANT_FLAGS }, userDeniedBundleIds: [], coordinateMode: 'pixels', lastScreenshot: globalShot,
  })
  const hoverCursor = await executor.getCursorPosition()
  check('global hover follows the physical foreground integrity context', !hover.isError && hoverCursor.x === 0 && hoverCursor.y === 0, JSON.stringify(hover.content))
  if (ELEVATED && USE_EXISTING_PERMANENT && process.env.CU_FIXTURE_CLI_EXE) {
    clearEvents()
    const { runElevatedCliFixture } = await import('./computer-use-cli-fixture-driver.js')
    await runElevatedCliFixture({
      cliExe: process.env.CU_FIXTURE_CLI_EXE,
      app: join(TMP_DIR, 'fixture.exe'),
      coordinate: imageCoordinate(globalPoint(105, 115)),
      directory: TMP_DIR,
      cwd: process.cwd(),
      onDispatched: () => waitFor(() => events().some(event => event.kind === 'mousedown'), 'compiled CLI elevated click'),
    })
    const routeLog = readFileSync(join(TMP_DIR, 'compiled-cli-debug.txt'), 'utf8')
    check('compiled CLI selects the elevated helper for the full-display hit', /targetIL=high foregroundIL=high elevated=true/.test(routeLog))
    check('compiled CLI changes the elevated fixture through a real initialized model/MCP turn', events().some(event => event.kind === 'mousedown'))
  }
  if (ELEVATED) {
    const overlayLog = join(TMP_DIR, 'overlay-events.jsonl')
    const overlayHwnd = join(TMP_DIR, 'overlay-hwnd.txt')
    const overlayScript = fixtureScript
      .replaceAll('CU_FIXTURE_LOG', 'CU_FIXTURE_OVERLAY_LOG')
      .replaceAll('CU_FIXTURE_HWND', 'CU_FIXTURE_OVERLAY_HWND')
      .replace("$form.Text = 'Doge CU isolated input fixture'", "$form.Text = 'Doge CU medium overlay fixture'; $form.TopMost = $true")
      .replace('$form.Width = 640', '$form.Width = 320')
      .replace('$form.Height = 480', '$form.Height = 260')
    overlayProc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-STA', '-Command', overlayScript], {
      stdout: 'ignore', stderr: 'pipe',
      env: { ...process.env, CU_FIXTURE_OVERLAY_LOG: overlayLog, CU_FIXTURE_OVERLAY_HWND: overlayHwnd },
    })
    try {
      await waitFor(() => existsSync(overlayHwnd), 'medium overlay HWND')
      const { setComputerUseTargetElevated } = await import('../src/utils/computerUse/win32/elevatedPowerShell.js')
      setComputerUseTargetElevated(true)
      overlayHighPid = Number(await runComputerUsePowerShell(`Start-Process -FilePath '${join(TMP_DIR, 'fixture.exe').replace(/'/g, "''")}' -PassThru | Select-Object -ExpandProperty Id`))
      await waitFor(() => platform.apps.listRunning().some(window => window.pid === overlayHighPid), 'high foreground behind the medium overlay')
      const highForeground = platform.apps.getFrontmostApp()
      check('a high-integrity window is foreground behind the authorized medium hit target', highForeground?.pid === overlayHighPid, JSON.stringify(highForeground))
      const mixedPoint = globalPoint(320, 240)
      const hit = platform.apps.getAppAtPoint?.(mixedPoint.x, mixedPoint.y)
      check('the coordinate resolves to the authorized medium overlay', hit?.pid === overlayProc.pid, JSON.stringify(hit))
      const { isComputerUseTargetElevated } = await import('../src/utils/computerUse/win32/elevatedPowerShell.js')
      bindWindow(Number(readFileSync(overlayHwnd, 'utf8')), overlayProc.pid, hit!.id)
      try {
        await prepareWindowsTarget()
        writeFileSync(overlayLog, '', 'utf8')
        await sendClick(Number(readFileSync(overlayHwnd, 'utf8')), 60, 60, 'left', overlayProc.pid)
        await waitFor(() => events(overlayLog).some(event => event.kind === 'leftmsg' && event.detail.startsWith('msg=513')), 'medium bound-background message')
        check('a bound medium background message stays local under an unrelated high foreground', !isComputerUseTargetElevated()
          && platform.apps.getFrontmostApp()?.pid === overlayHighPid)
      } finally {
        unbindWindow()
      }
      const mixedShot = await executor.screenshot({ allowedBundleIds: [frontmost.bundleId, hit!.id] })
      writeFileSync(overlayLog, '', 'utf8')
      const denied = await handleToolCall(adapter, 'left_click', { coordinate: imageCoordinate(mixedPoint, mixedShot) }, {
        allowedApps: [{ bundleId: frontmost.bundleId, displayName: frontmost.displayName, grantedAt: 1, tier: 'full' }],
        grantFlags: { ...DEFAULT_GRANT_FLAGS }, userDeniedBundleIds: [], coordinateMode: 'pixels', lastScreenshot: mixedShot,
      })
      check('a high foreground cannot authorize an ungranted hit target', denied.telemetry?.error_kind === 'app_not_granted'
        && !events(overlayLog).some(event => event.kind === 'mousedown'), JSON.stringify(denied.content))
      check('an ungranted hit target does not trigger elevated preparation', !isComputerUseTargetElevated())
      writeFileSync(overlayLog, '', 'utf8')
      const mixed = await handleToolCall(adapter, 'left_click', { coordinate: imageCoordinate(mixedPoint, mixedShot) }, {
        allowedApps: [
          { bundleId: frontmost.bundleId, displayName: frontmost.displayName, grantedAt: 1, tier: 'full' },
          { bundleId: hit!.id, displayName: hit!.appName, grantedAt: 1, tier: 'full' },
        ],
        grantFlags: { ...DEFAULT_GRANT_FLAGS },
        userDeniedBundleIds: [],
        coordinateMode: 'pixels',
        lastScreenshot: mixedShot,
      })
      check('a high foreground selects the broker even when the authorized hit target is medium', isComputerUseTargetElevated())
      check('a high foreground with a medium hit target still uses a working physical-input route', !mixed.isError
        && events(overlayLog).some(event => event.kind === 'mousedown'), JSON.stringify(mixed.content))
    } finally {
      overlayProc.kill()
      await overlayProc.exited
      overlayProc = undefined
      await activateObservedWindow(hwnd, fixturePid)
    }
  }
  if (ELEVATED) globalShot = await executor.screenshot({ allowedBundleIds: [frontmost.bundleId] })
  const batchClick = globalPoint(100, 110)
  clearEvents()
  const batch = await handleToolCall(adapter, 'computer_batch', {
    actions: [
      { action: 'left_click', coordinate: imageCoordinate(batchClick) },
      { action: 'type', text: '批😀' },
      { action: 'key', text: 'ctrl+a' },
      { action: 'screenshot' },
    ],
  }, {
    allowedApps: [{ bundleId: frontmost.bundleId, displayName: frontmost.displayName, grantedAt: 1, tier: 'full' }],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    userDeniedBundleIds: [],
    coordinateMode: 'pixels',
    lastScreenshot: globalShot,
  })
  const batchChars = String.fromCharCode(...events().filter(e => e.kind === 'keypress').map(e => Number(e.detail.slice('code='.length))))
  check('computer_batch executes global click, type, key and screenshot in one call', !batch.isError
    && batchChars.startsWith('批😀')
    && events().some(e => e.kind === 'keydown' && e.detail === 'key=A;ctrl=True')
    && events().some(e => e.kind === 'keyup' && e.detail === 'key=ControlKey;ctrl=False')
    && batch.content.some(item => item.type === 'image'), JSON.stringify({ text: batchChars, events: events(), result: batch.content[0] }))

  bindWindow(hwnd, fixturePid, 'fixture.app')
  const previousBinding = getBoundHwnd()
  if (ELEVATED) {
    const secondaryPath = join(TMP_DIR, 'fixture.exe').replace(/'/g, "''")
    const rawPid = await runComputerUsePowerShell(`Start-Process -FilePath '${secondaryPath}' -PassThru | Select-Object -ExpandProperty Id`)
    secondaryPid = Number(rawPid.trim())
  } else {
    secondaryProc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-STA', '-Command', fixtureScript], {
      stdout: 'inherit', stderr: 'inherit', env: { ...process.env },
    })
    secondaryPid = secondaryProc.pid
  }
  await waitFor(() => platform.apps.listRunning().some(window => window.pid === secondaryPid), 'second application window')
  const secondaryWindow = platform.apps.listRunning().find(window => window.pid === secondaryPid)!
  const secondaryHwnd = Number(secondaryWindow.id)
  let secondaryActivation = await activateObservedWindow(secondaryHwnd, secondaryPid)
  for (let i = 0; i < 3 && !secondaryActivation; i++) {
    await Bun.sleep(300)
    secondaryActivation = await activateObservedWindow(secondaryHwnd, secondaryPid)
  }
  check('new application can be foregrounded before target transition', secondaryActivation)
  await prepareWindowsTarget()
  check('a newly started foreground application releases the previous binding', previousBinding === hwnd && getBoundHwnd() === null, JSON.stringify({ previousBinding, current: getBoundHwnd(), secondaryPid }))
} catch (error) {
  failures++
  console.error('[FAIL] fixture e2e threw:', error)
} finally {
  try { unbind?.() } catch {}
  if (secondaryProc) {
    try { secondaryProc.kill() } catch {}
    await secondaryProc.exited
  }
  if (overlayProc) {
    try { overlayProc.kill() } catch {}
    await overlayProc.exited
  }
  if (proc) {
    try { proc.kill() } catch {}
    await proc.exited
  }
  if (ELEVATED) {
    // Both elevated fixtures listen for this file and exit their own message loops.
    writeFileSync(EXIT_FILE, 'exit', 'utf8')
    const pids = [fixturePid, overlayHighPid, secondaryPid].filter(pid => pid > 0)
    const { runPowerShell } = await import('../src/utils/computerUse/win32/powerShell.js')
    const { stopElevatedPowerShell } = await import('../src/utils/computerUse/win32/elevatedPowerShell.js')
    try {
      if (pids.length) await runPowerShell(`
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Elevated fixture did not acknowledge its exit file' }
    Start-Sleep -Milliseconds 100
}
`, 7000)
    } finally {
      await stopElevatedPowerShell()
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(TMP_DIR, { recursive: true, force: true })
      break
    } catch (error) {
      // Windows may retain a handle briefly after the elevated fixture exits.
      const code = (error as NodeJS.ErrnoException).code
      if (attempt === 49 || !['EACCES', 'EBUSY', 'EPERM'].includes(code ?? '')) throw error
      await Bun.sleep(100)
    }
  }
}

console.log(failures === 0 ? '\nFIXTURE E2E RESULT: ALL PASS' : `\nFIXTURE E2E RESULT: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

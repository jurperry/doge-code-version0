/**
 * Isolated Windows input e2e. Creates its own WinForms fixture and never
 * resolves or closes a user application. All artifacts live under test/ and
 * are removed in finally.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const TMP_DIR = join(process.cwd(), 'test', 'tmp-cu-input-fixture')
const LOG_FILE = join(TMP_DIR, 'events.jsonl')
const HWND_FILE = join(TMP_DIR, 'hwnd.txt')
process.env.CLAUDE_CONFIG_DIR = join(TMP_DIR, 'config')
process.env.CU_FIXTURE_LOG = LOG_FILE
process.env.CU_FIXTURE_HWND = HWND_FILE

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const fixtureScript = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
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
        MouseDown += (sender, e) => CuLog.Write("mousedown", "button=" + e.Button + ";clicks=" + e.Clicks);
        MouseUp += (sender, e) => CuLog.Write("mouseup", "button=" + e.Button);
    }
}
public class CuFixtureForm : Form {
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0207 || m.Msg == 0x0208) CuLog.Write("middle", "msg=" + m.Msg);
        if (m.Msg == 0x0201 || m.Msg == 0x0202) CuLog.Write("leftmsg", "msg=" + m.Msg);
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
'@
$form = New-Object CuFixtureForm
$form.Text = 'Doge CU isolated input fixture'
$form.Width = 640
$form.Height = 480
$form.StartPosition = 'CenterScreen'
[void]$form.Show()
[System.Windows.Forms.Application]::Run($form)
`

type Event = { kind: string; detail: string }
function events(): Event[] {
  if (!existsSync(LOG_FILE)) return []
  return readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
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
let unbind: (() => void) | undefined
try {
  mkdirSync(TMP_DIR, { recursive: true })
  clearEvents()
  proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-STA', '-Command', fixtureScript], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  await waitFor(() => existsSync(HWND_FILE) && readFileSync(HWND_FILE, 'utf8').trim().length > 0, 'fixture HWND')

  const { bindWindow, unbindWindow } = await import('../src/utils/computerUse/platforms/win32.js')
  const { ensureWindow } = await import('../src/utils/computerUse/win32/windowGuard.js')
  const { runPowerShellSync } = await import('../src/utils/computerUse/win32/powerShell.js')
  const { createCliExecutor } = await import('../src/utils/computerUse/executor.js')
  const hwnd = Number(readFileSync(HWND_FILE, 'utf8').trim())
  bindWindow(hwnd, proc.pid, undefined, 'fixture.app')
  unbind = unbindWindow
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
  const pixel = runPowerShellSync(`
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile('${boundPath.replace(/'/g, "''")}')
$p = $bmp.GetPixel([Math]::Min(100, $bmp.Width - 1), [Math]::Min(100, $bmp.Height - 1))
$bmp.Dispose()
"$($p.R),$($p.G),$($p.B)"
`)
  const channels = pixel.split(',').map(Number)
  check('bound-window capture contains the white fixture rather than a black frame', channels.every(value => value > 200), pixel)

  runPowerShellSync(`
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
  const minimized = runPowerShellSync(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class CuFixtureMin {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
[CuFixtureMin]::IsIconic([IntPtr]${hwnd})
`)
  check('minimized-window capture restores the original minimized state', minimizedShot.base64.length > 0 && minimized.trim() === 'True', minimized)
  const activation = ensureWindow(hwnd, true, proc.pid)
  check('fixture can be foregrounded again after minimized capture', activation.status === 'ok')

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
  }

  clearEvents()
  await executor.click(60, 60, 'middle', 1)
  await waitFor(() => events().filter(e => e.kind === 'middle').length >= 2, 'middle-button messages')
  const middle = events().filter(e => e.kind === 'middle').map(e => e.detail).join(',')
  check('middle-click emits WM_MBUTTONDOWN/UP, not right-click', middle.includes('msg=519') && middle.includes('msg=520'), middle)

  clearEvents()
  await executor.mouseDown()
  await executor.mouseUp()
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
    await executor.scroll(60, 60, dx, dy)
    await waitFor(() => events().some(e => e.kind === 'scroll'), `scroll ${label}`)
    const actual = events().find(e => e.kind === 'scroll')!.detail
    check(`scroll ${label} uses the native direction`, actual === `msg=${msg};param=${param}`, actual)
  }
} catch (error) {
  failures++
  console.error('[FAIL] fixture e2e threw:', error)
} finally {
  try { unbind?.() } catch {}
  if (proc) {
    try { proc.kill() } catch {}
    await proc.exited
  }
  rmSync(TMP_DIR, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nFIXTURE E2E RESULT: ALL PASS' : `\nFIXTURE E2E RESULT: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

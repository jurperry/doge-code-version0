import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TMP_DIR = join(process.cwd(), 'test', 'tmp-cu-host-target')
const LOG_FILE = join(TMP_DIR, 'events.txt')
const CHILD_HWND_FILE = join(TMP_DIR, 'child-hwnd.txt')
const CHILD_PID_FILE = join(TMP_DIR, 'child-pid.txt')
const EMBEDDED_FILE = join(TMP_DIR, 'embedded.txt')
const RENDERER_EXE = join(TMP_DIR, 'renderer.exe')
const HOST_TITLE = 'Doge CU host target fixture'
process.env.TEMP = TMP_DIR
process.env.TMP = TMP_DIR

const childCs = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;
public class CuRendererControl : UserControl {
    public CuRendererControl() {
        Dock = DockStyle.Fill;
        BackColor = Color.White;
        MouseDown += (sender, e) => File.AppendAllText(CuRendererPaths.Log, "mousedown\n", new UTF8Encoding(false));
    }
}
public class CuRendererForm : Form {
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        Controls.Add(new CuRendererControl());
        File.WriteAllText(CuRendererPaths.Hwnd, Handle.ToString(), Encoding.UTF8);
    }
}
public static class CuRendererPaths {
    public static readonly string Log = ${JSON.stringify(LOG_FILE)};
    public static readonly string Hwnd = ${JSON.stringify(CHILD_HWND_FILE)};
}
public static class CuRendererProgram {
    [STAThread] public static void Main() {
        var form = new CuRendererForm { Text = "Doge CU renderer", Width = 600, Height = 400, StartPosition = FormStartPosition.CenterScreen };
        form.Show();
        var lifetime = new Timer { Interval = 120000 };
        lifetime.Tick += (sender, args) => form.Close();
        lifetime.Start();
        Application.Run(form);
    }
}
`

const hostScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CuHostNative {
    [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
'@
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:CU_HOST_TITLE
$form.Width = 640
$form.Height = 480
$form.StartPosition = 'Manual'
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$hostX = $screen.WorkingArea.Right - 640
$hostY = $screen.WorkingArea.Bottom - 480
$form.Location = [System.Drawing.Point]::new($hostX, $hostY)
$form.Show()
if ($env:CU_HOST_SPAWNS_CHILD -eq '1') {
    $child = Start-Process -FilePath $env:CU_CHILD_EXE -PassThru
    [System.IO.File]::WriteAllText($env:CU_CHILD_PID_FILE, [string]$child.Id)
}
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (-not (Test-Path -LiteralPath $env:CU_CHILD_HWND) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
if (-not (Test-Path -LiteralPath $env:CU_CHILD_HWND)) { throw 'Renderer HWND was not created' }
$childHwnd = [IntPtr]::new([long](Get-Content -LiteralPath $env:CU_CHILD_HWND -Raw))
[CuHostNative]::SetParent($childHwnd, $form.Handle) | Out-Null
[CuHostNative]::MoveWindow($childHwnd, 0, 0, $form.ClientSize.Width, $form.ClientSize.Height, $true) | Out-Null
[CuHostNative]::ShowWindow($childHwnd, 5) | Out-Null
[CuHostNative]::SetForegroundWindow($form.Handle) | Out-Null
[System.IO.File]::WriteAllText($env:CU_EMBEDDED_FILE, 'ready')
[System.Windows.Forms.Application]::Run($form)
`

function events(): string[] {
  return existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean) : []
}
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(50)
  }
}

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

let host: ReturnType<typeof Bun.spawn> | undefined
let child: ReturnType<typeof Bun.spawn> | undefined
let childPid = 0
try {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
  writeFileSync(LOG_FILE, '', 'utf8')
  const sourcePath = join(TMP_DIR, 'renderer.cs')
  writeFileSync(sourcePath, childCs, 'utf8')
  const { runPowerShellSync } = await import('../src/utils/computerUse/win32/powerShell.js')
  runPowerShellSync(`
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
& $compiler /nologo /target:winexe /out:'${RENDERER_EXE.replace(/'/g, "''")}' /reference:System.Windows.Forms.dll /reference:System.Drawing.dll '${sourcePath.replace(/'/g, "''")}'
if ($LASTEXITCODE -ne 0) { throw 'Could not compile renderer fixture' }
`, 20_000)

  const { platform } = await import('../src/utils/computerUse/platforms/win32.js')
  const { ensureWindow } = await import('../src/utils/computerUse/win32/windowGuard.js')
  const { listWindows } = await import('../src/utils/computerUse/win32/windowEnum.js')
  const { createCliExecutor } = await import('../src/utils/computerUse/executor.js')
  const { getComputerUseHostAdapter } = await import('../src/utils/computerUse/hostAdapter.js')
  const { handleToolCall, DEFAULT_GRANT_FLAGS } = await import('@ant/computer-use-mcp')
  const executor = createCliExecutor({ getMouseAnimationEnabled: () => false, getHideBeforeActionEnabled: () => false })
  const adapter = getComputerUseHostAdapter()

  for (const hostSpawnsChild of [true, false]) {
    for (const file of [LOG_FILE, CHILD_HWND_FILE, CHILD_PID_FILE, EMBEDDED_FILE]) rmSync(file, { force: true })
    if (!hostSpawnsChild) {
      child = Bun.spawn([RENDERER_EXE], { stdout: 'ignore', stderr: 'ignore' })
      writeFileSync(CHILD_PID_FILE, String(child.pid), 'utf8')
    }
    host = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-STA', '-Command', hostScript], {
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        CU_HOST_TITLE: HOST_TITLE,
        CU_HOST_SPAWNS_CHILD: hostSpawnsChild ? '1' : '0',
        CU_CHILD_EXE: RENDERER_EXE,
        CU_CHILD_HWND: CHILD_HWND_FILE,
        CU_CHILD_PID_FILE: CHILD_PID_FILE,
        CU_EMBEDDED_FILE: EMBEDDED_FILE,
      },
    })
    await waitFor(() => existsSync(EMBEDDED_FILE) && existsSync(CHILD_PID_FILE) && listWindows().some(window => window.title === HOST_TITLE), 'embedded host')
    childPid = Number(readFileSync(CHILD_PID_FILE, 'utf8').trim())
    const hostWindow = listWindows().find(window => window.title === HOST_TITLE)!
    assert.equal(ensureWindow(hostWindow.hwnd, true, host.pid).status, 'ok')
    const rect = runPowerShellSync(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class CuHostRect {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[CuHostRect]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$r = New-Object CuHostRect+Rect
[CuHostRect]::GetWindowRect([IntPtr]${hostWindow.hwnd}, [ref]$r) | Out-Null
"$($r.L),$($r.T)"
`)
    const [left, top] = rect.split(',').map(Number)
    const point = { x: left + 120, y: top + 100 }
    const target = platform.apps.getAppAtPoint?.(point.x, point.y)
    check(`actual and host processes differ (${hostSpawnsChild ? 'trusted' : 'untrusted'})`,
      !!target && target.pid === childPid && target.hostPid === host.pid && target.pid !== target.hostPid,
      JSON.stringify(target))
    check('renderer and host executable identities are both resolved',
      !!target?.id.toLowerCase().endsWith('renderer.exe') && !!target.hostId?.toLowerCase().endsWith('powershell.exe'),
      JSON.stringify(target))
    check(`host trust requires the process tree (${hostSpawnsChild ? 'trusted' : 'untrusted'})`, target?.hostTrusted === hostSpawnsChild, JSON.stringify(target))

    const foregroundTarget = await executor.getFrontmostApp()
    check(`foreground resolver shares host trust (${hostSpawnsChild ? 'trusted' : 'untrusted'})`, hostSpawnsChild ? foregroundTarget?.hostTrusted === true : foregroundTarget?.hostTrusted !== true, JSON.stringify(foregroundTarget))
    const shot = await executor.screenshot({ allowedBundleIds: [target!.hostId!] })
    const coordinate: [number, number] = [
      Math.round((point.x - shot.originX) * shot.width / shot.displayWidth!),
      Math.round((point.y - shot.originY) * shot.height / shot.displayHeight!),
    ]
    const result = await handleToolCall(adapter, 'left_click', { coordinate }, {
      allowedApps: [{ bundleId: target!.hostId!, displayName: 'Host', grantedAt: 1, tier: 'full' }],
      grantFlags: { ...DEFAULT_GRANT_FLAGS },
      userDeniedBundleIds: [],
      coordinateMode: 'pixels',
      lastScreenshot: shot,
    })
    if (hostSpawnsChild) {
      check('trusted host click passes the tool gate', !result.isError, JSON.stringify(result))
      if (!result.isError) await waitFor(() => events().includes('mousedown'), 'trusted host click')
      check('trusted embedded renderer receives the click', events().includes('mousedown'), JSON.stringify(events()))
    } else {
      await Bun.sleep(300)
      check('an externally owned child cannot inherit host authorization', result.telemetry?.error_kind === 'app_not_granted' && events().length === 0, JSON.stringify(result))
    }
    try { host.kill() } catch {}
    await host.exited
    host = undefined
    if (child) {
      try { child.kill() } catch {}
      await child.exited
      child = undefined
    } else if (childPid > 0) {
      try { process.kill(childPid, 9) } catch {}
    }
    childPid = 0
  }
} catch (error) {
  failures++
  console.error('[FAIL] host target e2e threw:', error)
} finally {
  if (host) { try { host.kill() } catch {}; await host.exited }
  if (child) { try { child.kill() } catch {}; await child.exited }
  if (childPid > 0) {
    try { process.kill(childPid, 9) } catch {}
    for (let i = 0; i < 20; i++) {
      try { process.kill(childPid, 0) } catch { break }
      await Bun.sleep(50)
    }
  }
  rmSync(TMP_DIR, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nHOST TARGET E2E RESULT: ALL PASS' : `\nHOST TARGET E2E RESULT: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

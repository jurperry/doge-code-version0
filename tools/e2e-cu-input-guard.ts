/** Isolated regression for exact Windows window discovery and binding. */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, win32 as windowsPath } from 'node:path'
import { DEFAULT_GRANT_FLAGS, handleToolCall } from '@ant/computer-use-mcp'
import { getComputerUseHostAdapter } from '../src/utils/computerUse/hostAdapter.js'
import { getBoundHwnd, getBoundRevision, platform, prepareWindowsTarget, unbindWindow } from '../src/utils/computerUse/platforms/win32.js'
import { runPowerShellSync } from '../src/utils/computerUse/win32/powerShell.js'
import { listWindows } from '../src/utils/computerUse/win32/windowEnum.js'

const box = join(process.cwd(), 'test', 'tmp-cu-exact-window')
const intended = join(box, 'granted', 'WordFixture.exe')
const foreign = join(box, 'other', 'WordFixture.exe')
const source = join(box, 'fixture.cs')
const fixture = `
using System;
using System.Windows.Forms;
using System.IO;
using System.Drawing;
class WindowFixture {
    [STAThread] static void Main(string[] args) {
        var form = new Form { Text = args.Length > 0 ? args[0] : "Granted fixture", Width = 420, Height = 300 };
        if (args.Length > 1) {
            form.BackColor = Color.White;
            var update = new Timer { Interval = 60 };
            update.Tick += (sender, e) => {
                if (File.Exists(args[1])) { form.BackColor = Color.DarkBlue; update.Stop(); }
            };
            form.MouseDown += (sender, e) => File.WriteAllText(args[1] + ".click", "received");
            update.Start();
        }
        var timeout = new Timer { Interval = 90000 };
        timeout.Tick += (sender, e) => form.Close();
        timeout.Start();
        Application.Run(form);
    }
}
`

function literal(path: string): string { return "'" + path.replaceAll("'", "''") + "'" }

async function waitForWindow(predicate: (window: ReturnType<typeof listWindows>[number]) => boolean) {
  for (let i = 0; i < 20; i++) {
    const window = listWindows(true).find(predicate)
    if (window) return window
    await Bun.sleep(100)
  }
  throw new Error('Fixture window did not appear')
}

function isIntended(path: string | undefined): boolean {
  return !!path && windowsPath.normalize(path).toLowerCase() === intended.toLowerCase()
}

const procs: ReturnType<typeof Bun.spawn>[] = []
mkdirSync(join(box, 'granted'), { recursive: true })
mkdirSync(join(box, 'other'), { recursive: true })
process.env.TEMP = box
process.env.TMP = box
process.env.CLAUDE_CONFIG_DIR = join(box, 'config')
try {
  writeFileSync(source, fixture, 'utf8')
  runPowerShellSync(`
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
& $compiler /nologo /target:winexe /out:${literal(intended)} /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ${literal(source)}
if ($LASTEXITCODE -ne 0) { throw 'Could not compile exact-window fixture' }
`, 20_000)
  copyFileSync(intended, foreign)
  const other = Bun.spawn([foreign, 'Private fixture'], { stdout: 'ignore', stderr: 'ignore' })
  procs.push(other)
  const foreignWindow = await waitForWindow(window => window.pid === other.pid)

  const adapter = getComputerUseHostAdapter()
  const overrides = {
    allowedApps: [{ bundleId: intended, displayName: 'Granted fixture', grantedAt: 1, tier: 'full' as const }],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    userDeniedBundleIds: [],
    coordinateMode: 'pixels' as const,
  }
  const forged = await handleToolCall(adapter, 'open_application', {
    app: intended, window_id: `${foreignWindow.hwnd}:${foreignWindow.pid}`,
  }, overrides)
  assert.equal(forged.isError, true)
  assert.equal(getBoundHwnd(), null)

  const opened = await handleToolCall(adapter, 'open_application', { app: intended }, overrides)
  assert.equal(opened.isError, undefined, JSON.stringify(opened.content))
  const first = await waitForWindow(window => isIntended(window.path))
  assert.equal(getBoundHwnd(), first.hwnd)
  assert.notEqual(first.pid, other.pid)

  const trigger = join(box, 'change-content')
  const secondProcess = Bun.spawn([intended, 'Second granted fixture', trigger], { stdout: 'ignore', stderr: 'ignore' })
  procs.push(secondProcess)
  const second = await waitForWindow(window => window.pid === secondProcess.pid)
  const invoke = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await handleToolCall(adapter, name, args, overrides)
    assert.equal(result.isError, undefined, JSON.stringify(result.content))
    const block = result.content[0]
    assert.equal(block.type, 'text')
    return JSON.parse(block.text)
  }
  const { windows, ungrantedCount } = await invoke('list_windows', { visible_only: false, granted_only: false })
  assert.ok(windows.every((window: { exe: string }) => isIntended(window.exe)))
  assert.deepEqual(new Set(windows.filter((window: { visible: boolean }) => window.visible).map((window: { title: string }) => window.title)), new Set(['Granted fixture', 'Second granted fixture']))
  assert.ok(ungrantedCount >= 1)
  const limited = await invoke('list_windows', { limit: 1 })
  assert.equal(limited.count, 1)
  const detail = await invoke('get_window', { hwnd: second.hwnd })
  assert.equal(detail.pid, secondProcess.pid)
  assert.equal(detail.tier, 'full')
  assert.equal(detail.il, 'medium')
  assert.equal(typeof detail.className, 'string')
  assert.equal(detail.rootHwnd, second.hwnd)
  assert.ok(!('rect' in detail) && !('width' in detail))
  const beforeActivation = getBoundRevision()
  const activation = await invoke('activate_window', { hwnd: second.hwnd })
  assert.equal(activation.activated, true)
  assert.equal((await invoke('get_window', { hwnd: second.hwnd })).foreground, true)
  await prepareWindowsTarget(undefined, 'capture')
  assert.equal(getBoundHwnd(), first.hwnd)
  assert.equal(getBoundRevision(), beforeActivation)
  for (const name of ['get_window', 'activate_window']) {
    const denied = await handleToolCall(adapter, name, { hwnd: foreignWindow.hwnd }, overrides)
    assert.equal(denied.structuredContent?.code, 'app_not_granted')
    assert.ok(!JSON.stringify(denied).includes('Private fixture'))
  }
  const { desktop_info } = await invoke('list_granted_applications', { include_desktop: true })
  assert.equal(desktop_info.captureMode, 'bound_window')
  assert.ok(desktop_info.displays.some((screen: { isPrimary: boolean }) => screen.isPrimary))
  assert.ok(desktop_info.displays.every((screen: object) => !('width' in screen) && !('scaleFactor' in screen)))
  console.log('PASS window diagnostics, grant-only metadata, and foreground activation without rebinding')
  const selected = await handleToolCall(adapter, 'open_application', {
    app: intended, window_id: `${second.hwnd}:${second.pid}`,
  }, overrides)
  assert.equal(selected.isError, undefined, JSON.stringify(selected.content))
  assert.equal(getBoundHwnd(), second.hwnd)

  const capture = await handleToolCall(adapter, 'screenshot', {}, overrides)
  assert.ok(capture.screenshot, JSON.stringify(capture.content.filter(block => block.type === 'text')))
  const afterCapture = await handleToolCall(adapter, 'list_granted_applications', { include_desktop: true }, {
    ...overrides,
    lastScreenshot: capture.screenshot,
  })
  const afterCaptureInfo = JSON.parse(afterCapture.content[0].text).desktop_info
  assert.equal(afterCaptureInfo.lastScreenshot?.captureMode, 'bound_window')
  assert.equal(afterCaptureInfo.lastBindingRelease, null)
  const coordinates = [Math.round(capture.screenshot!.width / 2), Math.round(capture.screenshot!.height / 2)]
  const click = (snapshot: typeof capture.screenshot) => handleToolCall(adapter, 'left_click', { coordinate: coordinates },
    { ...overrides, lastScreenshot: snapshot, boundRevision: getBoundRevision() })
  writeFileSync(trigger, 'change', 'utf8')
  await Bun.sleep(350)
  const stale = await click(capture.screenshot)
  assert.equal(stale.structuredContent?.code, 'state_conflict', JSON.stringify(stale.content))
  assert.equal(existsSync(trigger + '.click'), false)
  const fresh = await handleToolCall(adapter, 'screenshot', {}, overrides)
  assert.ok(fresh.screenshot)
  const confirmed = await click(fresh.screenshot)
  assert.equal(confirmed.isError, undefined, JSON.stringify(confirmed.content))
  assert.equal(existsSync(trigger + '.click'), true)
  console.log('PASS 9×9 check blocks a changed bound window and accepts a fresh screenshot')

  secondProcess.kill()
  await secondProcess.exited
  await assert.rejects(platform.input.typeText('stale input'), /window no longer exists/)
  console.log('PASS exact launch, granted-only discovery, explicit selection, forged and stale target rejection')
} finally {
  unbindWindow()
  for (const proc of procs) { try { proc.kill() } catch {}; await proc.exited }
  for (const window of listWindows(true).filter(window => isIntended(window.path))) {
    try { process.kill(window.pid, 9) } catch {}
  }
  for (let i = 0; i < 20; i++) {
    try { rmSync(box, { recursive: true, force: true }); break } catch (error) {
      if (i === 19) throw error
      await Bun.sleep(100)
    }
  }
}

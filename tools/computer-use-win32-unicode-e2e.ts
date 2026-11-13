import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createCliExecutor } from '../src/utils/computerUse/executor.js'
import { bindWindow, getBoundInputChannel, unbindWindow } from '../src/utils/computerUse/platforms/win32.js'
import { handleToolCall } from '../packages/@ant/computer-use-mcp/src/toolCalls.js'
import { DEFAULT_GRANT_FLAGS, type ComputerUseHostAdapter } from '../packages/@ant/computer-use-mcp/src/types.js'

const box = join(process.cwd(), 'test', 'tmp-cu-win32-unicode')
const shortText = '你好，做个自我介绍'
const fixtureScript = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class CuNativeForm : Form {
    private IntPtr editHwnd;
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    protected override void OnShown(EventArgs e) {
        base.OnShown(e);
        const uint style = 0x40000000 | 0x10000000 | 0x00010000 | 0x00800000 | 0x0004 | 0x0040;
        editHwnd = CreateWindowEx(0, "EDIT", "", style, 10, 10, 600, 120, Handle,
            IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (editHwnd == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        SetFocus(editHwnd);
        File.WriteAllText(Environment.GetEnvironmentVariable("CU_FIXTURE_HWND"), Handle.ToString(), Encoding.UTF8);
        File.WriteAllText(Environment.GetEnvironmentVariable("CU_FIXTURE_EDIT_HWND"), editHwnd.ToString(), Encoding.UTF8);
    }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0111 && ((m.WParam.ToInt64() >> 16) & 0xFFFF) == 0x0400) {
            var sb = new StringBuilder(4096);
            GetWindowText(editHwnd, sb, sb.Capacity);
            File.WriteAllText(Environment.GetEnvironmentVariable("CU_FIXTURE_OUT"), sb.ToString(), new UTF8Encoding(false));
        }
        base.WndProc(ref m);
    }
}
'@
$form = New-Object CuNativeForm
$form.Text = 'Doge CU native EDIT fixture'
$form.Width = 640
$form.Height = 220
$form.StartPosition = 'CenterScreen'
[void]$form.Show()
[System.Windows.Forms.Application]::Run($form)
`

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
let proc: ReturnType<typeof Bun.spawn> | undefined
let editHwnd = 0
function nativeText(): string {
  try { return readFileSync(join(box, 'actual.txt'), 'utf8') } catch { return '' }
}
async function waitForText(expected: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (nativeText() === expected) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

try {
  rmSync(box, { recursive: true, force: true })
  mkdirSync(box, { recursive: true })
  proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-STA', '-Command', fixtureScript], {
    env: {
      ...process.env,
      CU_FIXTURE_HWND: join(box, 'hwnd.txt'),
      CU_FIXTURE_EDIT_HWND: join(box, 'edit-hwnd.txt'),
      CU_FIXTURE_OUT: join(box, 'actual.txt'),
      TEMP: box,
      TMP: box,
      TMPDIR: box,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  let hwnd = 0
  for (let i = 0; i < 100 && (!hwnd || !editHwnd); i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    try {
      hwnd = Number(readFileSync(join(box, 'hwnd.txt'), 'utf8').trim())
      editHwnd = Number(readFileSync(join(box, 'edit-hwnd.txt'), 'utf8').trim())
    } catch {}
  }
  if (!hwnd || !editHwnd) throw new Error('native EDIT fixture not found')
  bindWindow(hwnd, proc.pid, undefined, 'fixture.app')
  check('fixture is not Chromium', !getBoundInputChannel().chromium)
  const executor = createCliExecutor({ getMouseAnimationEnabled: () => false, getHideBeforeActionEnabled: () => false })
  const adapter: ComputerUseHostAdapter = {
    serverName: 'computer-use-batch-e2e',
    logger: { silly() {}, debug() {}, info() {}, warn() {}, error() {} },
    executor,
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  }
  const batch = await handleToolCall(adapter, 'computer_batch', {
    actions: [{ action: 'type', text: shortText }, { action: 'screenshot' }],
  }, {
    allowedApps: [{ bundleId: 'fixture.app', displayName: 'Native EDIT fixture', grantedAt: 1, tier: 'full' }],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    userDeniedBundleIds: [],
    coordinateMode: 'pixels',
  })
  check('computer_batch dispatches text and returns an in-batch screenshot', !batch.isError
    && batch.content.some(item => item.type === 'image'), JSON.stringify(batch.content[0]))
  const shortMatched = await waitForText(shortText)
  check('real Unicode input preserves the Chinese prompt in native EDIT', shortMatched, JSON.stringify(nativeText()))
  if (process.env.KEEP_CU_TEST === '1') {
    const shot = await executor.screenshot({ allowedBundleIds: ['fixture.app'] })
    writeFileSync(join(box, 'native-edit.jpg'), Buffer.from(shot.base64, 'base64'))
  }
} catch (error) {
  failures++
  console.error('[FAIL] native EDIT Unicode e2e threw:', error)
} finally {
  if (proc) {
    try { proc.kill() } catch {}
    await proc.exited
  }
  try { unbindWindow() } catch {}
  if (process.env.KEEP_CU_TEST !== '1') rmSync(box, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nWIN32 UNICODE E2E RESULT: ALL PASS' : `\nWIN32 UNICODE E2E RESULT: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

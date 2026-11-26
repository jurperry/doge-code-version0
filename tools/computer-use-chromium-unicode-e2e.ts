import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { createCliExecutor } from '../src/utils/computerUse/executor.js'
import { bindWindow, getBoundInputChannel, unbindWindow } from '../src/utils/computerUse/platforms/win32.js'
import { handleToolCall, DEFAULT_GRANT_FLAGS } from '@ant/computer-use-mcp'
import { getComputerUseHostAdapter } from '../src/utils/computerUse/hostAdapter.js'
import { runPowerShellSync } from '../src/utils/computerUse/win32/powerShell.js'
import { activateWindowsFixture } from './windows-fixture-activation.js'

const box = join(process.cwd(), 'test', 'tmp-cu-chromium-unicode')
const shortText = '你好，做个自我介绍'
const longText = `${shortText}A中😀!`.repeat(20)
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function actualText(): string {
  try { return readFileSync(join(box, 'actual.txt'), 'utf8') } catch { return '' }
}
async function waitForText(expected: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (actualText() === expected) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

const main = `const { app, BrowserWindow } = require('electron')
app.setPath('userData', process.env.CU_FIXTURE_PROFILE)
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('unsafe-swiftshader')
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 520,
    height: 300,
    show: true,
    webPreferences: { contextIsolation: false, sandbox: false, nodeIntegration: true }
  })
  win.loadFile(process.env.CU_FIXTURE_HTML)
})
`
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>CU Chromium Unicode Fixture</title></head>
<body><textarea id="target" autofocus style="width:90%;font-size:24px"></textarea><script>
const target = document.getElementById('target')
target.focus()
target.addEventListener('input', () => {
  document.title = target.value
  require('fs').writeFileSync(process.env.CU_FIXTURE_OUT, target.value, 'utf8')
})
</script></body></html>
`

const electronExe = process.env.CU_ELECTRON_EXE ?? createRequire(join(process.cwd(), '..', 'doge-code-app', 'package.json'))('electron') as string
let proc: ReturnType<typeof Bun.spawn> | undefined
try {
  rmSync(box, { recursive: true, force: true })
  mkdirSync(box, { recursive: true })
  writeFileSync(join(box, 'main.cjs'), main)
  writeFileSync(join(box, 'index.html'), html)
  proc = Bun.spawn([
    electronExe,
    join(box, 'main.cjs'),
  ], {
    env: {
      ...process.env,
      CU_FIXTURE_PROFILE: join(box, 'profile'),
      CU_FIXTURE_HTML: join(box, 'index.html'),
      CU_FIXTURE_OUT: join(box, 'actual.txt'),
      TEMP: box,
      TMP: box,
      TMPDIR: box,
      ELECTRON_RUN_AS_NODE: undefined,
    } as Record<string, string>,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  let hwnd = 0
  for (let i = 0; i < 100 && !hwnd; i++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    hwnd = Number(runPowerShellSync(`(Get-Process -Id ${proc.pid}).MainWindowHandle`))
  }
  if (!hwnd) throw new Error('Chromium fixture window not found')
  bindWindow(hwnd, proc.pid, 'fixture.app')
  check('fixture uses the Chromium input channel', getBoundInputChannel().chromium)
  const executor = createCliExecutor({ getMouseAnimationEnabled: () => false, getHideBeforeActionEnabled: () => false })

  await activateWindowsFixture({ hwnd, pid: proc.pid, appId: 'fixture.app', x: 260, y: 160 })
  await executor.type(shortText, { viaClipboard: false })
  const shortMatched = await waitForText(shortText)
  check('short Chinese prompt is preserved exactly', shortMatched, JSON.stringify(actualText()))

  await executor.key('ctrl+a')
  await executor.key('backspace')
  await executor.type(longText, { viaClipboard: false })
  const longMatched = await waitForText(longText)
  const longActual = actualText()
  check('long mixed Unicode input remains intact', longMatched, `${longActual.length}/${longText.length} UTF-16 code units`)
  await executor.key('ctrl+a')
  await executor.key('backspace')
  const result = await handleToolCall(getComputerUseHostAdapter(), 'type', { text: '甲\n乙\r\n丙\r丁😀' }, {
    allowedApps: [{ bundleId: 'fixture.app', displayName: 'Chromium fixture', grantedAt: 1, tier: 'full' }],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    userDeniedBundleIds: [],
    coordinateMode: 'pixels',
  })
  const multilineMatched = await waitForText('甲\n乙\n丙\n丁😀')
  check('bound Chromium textarea receives each explicit line break without clipboard paste', !result.isError && multilineMatched, JSON.stringify(actualText()))
} catch (error) {
  failures++
  console.error('[FAIL] Chromium Unicode e2e threw:', error)
} finally {
  try { unbindWindow() } catch (error) {
    failures++
    console.error('[FAIL] unbind cleanup failed:', error)
  }
  if (proc) {
    try { proc.kill() } catch {}
    await proc.exited
  }
  if (process.env.KEEP_CU_TEST !== '1') rmSync(box, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nCHROMIUM UNICODE E2E RESULT: ALL PASS' : `\nCHROMIUM UNICODE E2E RESULT: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

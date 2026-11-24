/**
 * Computer Use → Android 模拟器 输入通道 端到端验证（Windows 实机）。
 *
 * 验证 2026-09-09 的自绘窗口（Qt）通道修复：绑定模拟器窗口后，鼠标必须
 * 走真实输入通道（SetCursorPos + mouse_event，前台卫兵保护），而旧行为是
 * 向顶层 HWND SendMessage —— Qt 不翻译，adb getevent 0 触摸事件。
 *
 * 前置：一台运行中的 Android 模拟器（窗口标题含 "Android Emulator"）+
 * adb 可用（默认 E:\Android\Sdk\platform-tools\adb.exe，PATH 里的 adb 兜底）。
 * 缺模拟器/adb 时相应检查报 SKIP 而非 FAIL。
 *
 * 运行：bun run tools/e2e-cu-emulator-input.ts
 * 影响面：会激活模拟器窗口并在客户机里点击/拖拽（对当前打开的应用无破坏性
 * 操作假设——测试 app 网格）。不写任何文件。
 */

process.env.CLAUDE_CONFIG_DIR = (() => {
  const { join } = require('path') as typeof import('path')
  return join(process.cwd(), 'test', 'tmp-cu-emu-e2e-config')
})()

const { mkdirSync, rmSync } = await import('fs')
const { join } = await import('path')

const TMP_DIR = process.env.CLAUDE_CONFIG_DIR

let failures = 0
let skips = 0
function check(label: string, ok: boolean, detail: string): void {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function skip(label: string, detail: string): void {
  console.log(`[SKIP] ${label}${detail ? ` — ${detail}` : ''}`)
  skips++
}

// ── adb helper ──────────────────────────────────────────────────────────────

const ADB_CANDIDATES = [
  'E:\\Android\\Sdk\\platform-tools\\adb.exe',
  'adb',
]

function findAdb(): string | null {
  for (const c of ADB_CANDIDATES) {
    try {
      const r = Bun.spawnSync({
        cmd: [c, 'version'],
        stdout: 'pipe',
        stderr: 'pipe',
        timeoutMs: 8000,
      })
      if (r.exitCode === 0) return c
    } catch {}
  }
  return null
}

async function adbShell(adb: string, args: string, timeoutMs: number): Promise<string> {
  const proc = Bun.spawn([adb, 'shell', args], { stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {}
  }, timeoutMs)
  try {
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out
  } finally {
    clearTimeout(timer)
  }
}

/** Start `getevent -c N -lt`, run `act()`, return the collected events. */
async function collectTouchEvents(
  adb: string,
  eventCount: number,
  act: () => Promise<void>,
): Promise<string> {
  const proc = Bun.spawn([adb, 'shell', `getevent -c ${eventCount} -lt`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await new Promise(r => setTimeout(r, 600))
  try {
    await act()
  } finally {
    // Give getevent time to flush and exit; kill as backstop.
  }
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {}
  }, 12000)
  try {
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out
  } finally {
    clearTimeout(timer)
  }
}

try {
  mkdirSync(TMP_DIR, { recursive: true })

  const { platform, bindWindow, getBoundInputChannel, unbindWindow } = await import(
    '../src/utils/computerUse/platforms/win32.js'
  )
  const { listWindows } = await import(
    '../src/utils/computerUse/win32/windowEnum.js'
  )

  // ── 1. 找到模拟器窗口并绑定 ─────────────────────────────────────────
  const windows = listWindows()
  const emuWin = windows.find(
    w => /Android Emulator/i.test(w.title) || /Pixel_\d/i.test(w.title),
  )
  if (!emuWin) {
    skip('emulator window found', 'no window titled "Android Emulator"/"Pixel_*" — start one to run this e2e')
  } else {
    check(
      'emulator window located',
      emuWin.hwnd > 0,
      `hwnd=${emuWin.hwnd} pid=${emuWin.pid} title="${emuWin.title.slice(0, 50)}"`,
    )
    bindWindow(emuWin.hwnd, emuWin.pid)

    // ── 2. 框架分类：Qt → selfDrawn → 真实输入通道 ────────────────────
    const channel = getBoundInputChannel()
    check(
      'Qt window classified self-drawn (real-input mouse channel)',
      channel.selfDrawn && channel.realMouse,
      JSON.stringify(channel),
    )

    // ── 3. 窗口尺寸（client 坐标基准）─────────────────────────────────
    const rectRaw = Bun.spawnSync({
      cmd: [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class ERect {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
\$r = New-Object ERect+RECT
[ERect]::GetWindowRect([IntPtr]${emuWin.hwnd}, [ref]\$r) | Out-Null
"\$(\$r.R - \$r.L),\$(\$r.B - \$r.T)"
`,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
      timeoutMs: 10000,
    })
    const [wStr, hStr] = new TextDecoder()
      .decode(rectRaw.stdout)
      .trim()
      .split(',')
    const w = Number(wStr)
    const h = Number(hStr)
    check('window rect readable', w > 200 && h > 200, `${w}x${h}`)

    // 客户机屏幕大约在窗口中央区域（避开工具栏/侧栏）
    const cx = Math.round(w * 0.5)
    const cy = Math.round(h * 0.55)

    // ── 4. adb 可用性 ──────────────────────────────────────────────────
    const adb = findAdb()
    if (!adb) {
      skip('adb available', 'no adb on machine — touch-event verification skipped')
    } else {
      // Note: `get-state` is a HOST-side adb subcommand, not a shell command
      // on modern emulator images — use `adb devices`.
      const devR = Bun.spawnSync({
        cmd: [adb, 'devices'],
        stdout: 'pipe',
        stderr: 'pipe',
        timeoutMs: 8000,
      })
      const devicesOut = new TextDecoder().decode(devR.stdout)
      check(
        'adb sees the emulator device',
        /^\s*emulator-\d+\s+device\b/m.test(devicesOut),
        devicesOut.trim().split('\n').slice(-1)[0],
      )

      // 这台 virtio 触摸屏走 MT 协议、无 BTN_TOUCH：
      // 按下 = ABS_MT_TRACKING_ID <非负>，抬起 = ABS_MT_TRACKING_ID ffffffff/-1。
      const touchDown = (s: string) => /ABS_MT_TRACKING_ID\s+0*0[0-9a-f]*\s*$/m.test(s) || /ABS_MT_TRACKING_ID\s+(?!ffffffff)[0-9a-f]{1,8}\s*$/m.test(s)
      const touchUp = (s: string) => /ABS_MT_TRACKING_ID\s+(ffffffff|-1\b)/m.test(s)

      // ── 5. 点击 → getevent 必须出现触摸事件（旧行为：0 个）──────────
      const clickEvents = await collectTouchEvents(adb, 10, () =>
        platform.input.click(cx, cy, 'left'),
      )
      check(
        'click produces guest touch events (ABS_MT position)',
        /ABS_MT_POSITION_[XY]/.test(clickEvents) && touchDown(clickEvents),
        clickEvents
          .split('\n')
          .filter(l => /ABS_MT/.test(l))
          .slice(0, 3)
          .map(l => l.trim().slice(-60))
          .join(' | ') || 'no events',
      )

      // ── 6. 拖拽 → 完整 down→move→up 序列到达客户机 ──────────────────
      const dragFrom = { x: Math.round(w * 0.4), y: Math.round(h * 0.6) }
      const dragTo = { x: Math.round(w * 0.6), y: Math.round(h * 0.45) }
      const dragEvents = await collectTouchEvents(adb, 80, () =>
        platform.input.drag(dragFrom, dragTo, 400),
      )
      const hasDown = touchDown(dragEvents)
      const hasUp = touchUp(dragEvents)
      const positions = (dragEvents.match(/ABS_MT_POSITION_X/g) ?? []).length
      check(
        'drag delivers down→interpolated moves→up to the guest',
        hasDown && hasUp && positions >= 4,
        `down=${hasDown} up=${hasUp} x-samples=${positions}`,
      )
    }

    unbindWindow()
  }
} catch (e) {
  check('e2e ran to completion', false, String(e))
} finally {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {}
}

console.log(
  failures === 0
    ? skips > 0
      ? `\nEmulator e2e passed (${skips} skipped).`
      : '\nAll emulator e2e checks passed.'
    : `\n${failures} check(s) FAILED.`,
)
process.exit(failures === 0 ? 0 : 1)

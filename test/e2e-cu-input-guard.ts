/**
 * Computer Use 输入前置卫兵 + 应用枚举 端到端验证脚本（Windows 实机）。
 *
 * 验证内容：
 *  1. listInstalledAppsWin32 拆阶段枚举：非空、含已知应用（notepad）、
 *     运行中窗口以 extraPaths（窗口标题）形式参与解析候选、耗时可控。
 *  2. apps.open('notepad') → HWND 绑定成功（含"已运行窗口优先绑定"路径）。
 *  3. 后台 SendMessage typeText：存活卫兵通过、文本真实进入 notepad。
 *  4. 杀掉 notepad 进程 → 输入卫兵按预期抛错（带 open_application 指引），
 *     绝不静默无效。
 *  5. 重新 open → 绑定恢复；最小化后 needForeground 路径能恢复窗口并置前。
 *
 * 运行：bun run test/e2e-cu-input-guard.ts
 * 影响面：会短暂打开/激活一个 notepad 窗口（第 5 步短暂抢占前台），结束即清理。
 * 不写任何文件到 C 盘测试目录之外；notepad 不落盘。
 */

process.env.CLAUDE_CONFIG_DIR = (() => {
  const { join } = require('path') as typeof import('path')
  return join(process.cwd(), 'test', 'tmp-cu-guard-e2e-config')
})()

const { mkdirSync, rmSync } = await import('fs')

const TMP_DIR = process.env.CLAUDE_CONFIG_DIR

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Read a notepad edit control's text via WM_GETTEXT (Edit child on classic
 *  notepad, RichEditD2DPT on the Win11 Store version). */
async function readNotepadText(hwnd: number): Promise<string> {
  const r = Bun.spawnSync({
    cmd: [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NpRead {
    public delegate bool EnumChildProc(IntPtr h, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumChildProc cb, IntPtr lp);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, StringBuilder l);
    public static StringBuilder buf = new StringBuilder(4096);
    public static void Read(IntPtr parent) {
        EnumChildWindows(parent, delegate(IntPtr h, IntPtr lp) {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            var cls = sb.ToString();
            if (cls == "Edit" || cls == "RichEditD2DPT" || cls == "RichEdit20W") {
                SendMessage(h, 0x000D, (IntPtr)4096, buf);
                return false;
            }
            return true;
        }, IntPtr.Zero);
    }
}
'@
[NpRead]::Read([IntPtr]${hwnd})
[NpRead]::buf.ToString()
`,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
    timeoutMs: 10000,
  })
  return new TextDecoder().decode(r.stdout).replace(/\0+$/, '')
}

/** Kill the process owning a window (used to simulate "user closed the app"). */
function killWindowProcess(pid: number): void {
  Bun.spawnSync({
    cmd: ['taskkill', '/PID', String(pid), '/T', '/F'],
    stdout: 'pipe',
    stderr: 'pipe',
    timeoutMs: 10000,
  })
}

try {
  mkdirSync(TMP_DIR, { recursive: true })

  const { platform, getBoundHwnd, bindWindow } = await import(
    '../src/utils/computerUse/platforms/win32.js'
  )
  const { ensureWindow } = await import(
    '../src/utils/computerUse/win32/windowGuard.js'
  )
  const { listInstalledAppsWin32 } = await import(
    '../src/utils/computerUse/win32/installedApps.js'
  )

  // ── 1. 应用枚举（问题 2 的核心修复）──────────────────────────────────
  const enumStart = Date.now()
  const installed = await listInstalledAppsWin32()
  const enumMs = Date.now() - enumStart
  check(
    'listInstalledAppsWin32 returns a non-trivial list',
    installed.length > 10,
    `${installed.length} apps in ${enumMs}ms`,
  )
  check(
    'enumeration completes in a sane time (<30s, was: 15s kill → empty)',
    enumMs < 30000,
    `${(enumMs / 1000).toFixed(1)}s`,
  )
  const notepadEntry = installed.find(
    a => a.displayName.toLowerCase() === 'notepad',
  )
  check(
    'notepad resolvable by display name',
    notepadEntry !== undefined,
    notepadEntry ? `id=${notepadEntry.id}` : 'missing',
  )

  // ── 1b. request_access 全链路（问题 2 的工具层回归）──────────────────
  // bindSessionContext → handleRequestAccess → resolveRequestedApps →
  // 新枚举列表解析 → （stub 掉弹窗）授权成功。旧行为：枚举被 15s 守卫杀掉
  // → 列表为空 → not_installed。
  let dispatch: ((name: string, args: unknown) => Promise<any>) | undefined
  let grantedApps: Array<{ bundleId: string; displayName: string; grantedAt: number }> = []
  {
    const { bindSessionContext, DEFAULT_GRANT_FLAGS } = await import(
      '@ant/computer-use-mcp'
    )
    const { getComputerUseHostAdapter } = await import(
      '../src/utils/computerUse/hostAdapter.js'
    )
    const { getChicagoCoordinateMode } = await import(
      '../src/utils/computerUse/gates.js'
    )
    const {
      checkComputerUseLock,
      tryAcquireComputerUseLock,
      releaseComputerUseLock,
    } = await import('../src/utils/computerUse/computerUseLock.js')

    const ctx = {
      getAllowedApps: () => grantedApps,
      getGrantFlags: () => DEFAULT_GRANT_FLAGS,
      getUserDeniedBundleIds: () => [],
      getSelectedDisplayId: () => undefined,
      isAborted: () => false,
      checkCuLock: async () => ({ holder: undefined, isSelf: false }),
      acquireCuLock: async () => {
        const r = await tryAcquireComputerUseLock()
        if (r.kind === 'blocked') throw new Error(`lock held by ${r.by}`)
      },
      onPermissionRequest: async (req: any) => ({
        granted: req.apps
          .filter((a: any) => a.resolved)
          .map((a: any) => ({
            bundleId: a.resolved.bundleId,
            displayName: a.resolved.displayName,
            grantedAt: Date.now(),
          })),
        denied: [],
        flags: DEFAULT_GRANT_FLAGS,
      }),
    }
    dispatch = bindSessionContext(
      getComputerUseHostAdapter(),
      getChicagoCoordinateMode(),
      ctx as any,
    ) as any
    const res = await dispatch('request_access', {
      apps: ['notepad'],
      reason: 'e2e resolution check',
    })
    const text = res.content?.[0]?.text ?? ''
    const parsed = JSON.parse(text)
    grantedApps = parsed.granted ?? []
    check(
      'request_access resolves notepad end-to-end (was: not_installed)',
      grantedApps.length === 1 && /notepad/i.test(grantedApps[0].displayName),
      JSON.stringify(grantedApps),
    )
  }

  // ── 2. open('notepad') → 绑定 ─────────────────────────────────────────
  await platform.apps.open('notepad')
  const hwnd = getBoundHwnd()
  check('open(notepad) binds an HWND', hwnd !== null && hwnd > 0, `hwnd=${hwnd}`)
  if (!hwnd) throw new Error('no bound hwnd — aborting further steps')

  // ── 3. 后台 SendMessage 输入（存活卫兵通过）────────────────────────────
  await platform.input.typeText('cu-guard-e2e')
  await new Promise(r => setTimeout(r, 600))
  const text = await readNotepadText(hwnd)
  check(
    'background SendMessage typeText lands in notepad (liveness guard passes)',
    text.includes('cu-guard-e2e'),
    JSON.stringify(text.slice(0, 60)),
  )

  // ── 3b. 卫兵微缓存下连续动作不炸 ──────────────────────────────────────
  await platform.input.typeText('-ok')
  await new Promise(r => setTimeout(r, 400))
  const text2 = await readNotepadText(hwnd)
  check(
    'second rapid action passes the guard micro-cache',
    text2.includes('cu-guard-e2e-ok'),
    JSON.stringify(text2.slice(0, 60)),
  )

  // ── 4. 进程被杀 → 卫兵必须报错而非静默 ────────────────────────────────
  // 先解除边框标记的干扰：直接杀 pid（bindWindow 时记录在 listWindows 里）
  const { listWindows } = await import(
    '../src/utils/computerUse/win32/windowEnum.js'
  )
  const win = listWindows().find(w => w.hwnd === hwnd)
  const pid = win?.pid
  if (pid) {
    killWindowProcess(pid)
    await new Promise(r => setTimeout(r, 800))
    let threw: Error | undefined
    try {
      await platform.input.typeText('should-not-appear')
    } catch (e) {
      threw = e as Error
    }
    check(
      'guard throws after the app is killed (actionable error, no silent no-op)',
      threw !== undefined && /no longer exists|open_application/i.test(threw.message),
      threw ? threw.message.slice(0, 90) : 'no error thrown',
    )
    const deadProbe = ensureWindow(hwnd, false)
    check('probe reports dead for the killed window', deadProbe.status === 'dead', JSON.stringify(deadProbe))

    // 工具层传播：同一状态下走 dispatch('type')，模型看到的应是 isError + 指引
    if (dispatch) {
      const toolRes = await dispatch('type', { text: 'x' })
      const toolText = toolRes?.content?.[0]?.text ?? ''
      check(
        'guard error surfaces as a model-facing tool error with guidance',
        toolRes?.isError === true && /no longer exists|open_application/i.test(toolText),
        toolText.slice(0, 90),
      )
    }
  } else {
    check('found notepad pid for kill test', false, 'window not enumerated')
  }

  // ── 5. 重新 open + 最小化 → 前台激活恢复 ──────────────────────────────
  await new Promise(r => setTimeout(r, 500))
  await platform.apps.open('notepad')
  const hwnd2 = getBoundHwnd()
  check('re-open rebinds a fresh HWND', hwnd2 !== null && hwnd2 > 0 && hwnd2 !== hwnd, `hwnd=${hwnd2}`)

  if (hwnd2) {
    // 最小化它，再走 needForeground 卫兵：应恢复 + 置前 + 校验通过
    Bun.spawnSync({
      cmd: [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class NpMin { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); }
'@
[NpMin]::ShowWindow([IntPtr]${hwnd2}, 6) | Out-Null
`,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
      timeoutMs: 10000,
    })
    await new Promise(r => setTimeout(r, 400))
    const minimized = ensureWindow(hwnd2, false)
    // liveness probe still alive（最小化 ≠ 死亡）
    check('minimized window still passes liveness probe', minimized.status === 'ok', JSON.stringify(minimized))

    const activated = ensureWindow(hwnd2, true)
    check(
      'foreground guard restores a minimized window and verifies frontmost',
      activated.status === 'ok',
      JSON.stringify(activated),
    )

    // 收尾：关掉这个 notepad（SendMessage WM_CLOSE）
    Bun.spawnSync({
      cmd: [
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class NpClose { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }
'@
[NpClose]::SendMessage([IntPtr]${hwnd2}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
`,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
      timeoutMs: 10000,
    })
  }
} catch (e) {
  check('e2e ran to completion', false, String(e))
} finally {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {}
}

console.log(failures === 0 ? '\nAll CU guard e2e checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

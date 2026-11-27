/**
 * Installed-app enumeration for Windows Computer Use.
 *
 * 替代旧的单一大脚本枚举（platforms/win32.ts 原实现）。旧实现的问题：
 *  - 一个脚本串行做注册表 + Get-AppxPackage + 递归快捷方式 + Get-StartApps，
 *    任何一段慢就把 15s 的 psAsync 守卫拖爆 → 进程被杀 → 输出为空 →
 *    request_access 弹窗里所有应用都显示 "(not installed)" 且久等无响应。
 *  - 快捷方式循环内每个 .lnk 都 New-Object 一次 WScript.Shell COM ——
 *    开始菜单几百个快捷方式时仅此一项就是数秒。
 *
 * 新实现：
 *  - 静态阶段并行（Promise.allSettled），各自带独立超时，一段慢/挂
 *    不拖垮其余阶段；运行中窗口每次请求重新枚举，不沿用启动时缓存；
 *  - 快捷方式阶段 hoist 单个 COM 对象；
 *  - Get-AppxPackage（慢）删除，UWP 用 Get-StartApps（快且 AppID 可直接
 *    shell:AppsFolder 启动）；
 *  - 新增 App Paths 注册表段与「运行中窗口」段 —— 模拟器 / Android Studio
 *    这类常以运行态存在、注册表 DisplayName 又对不上的应用，靠窗口标题
 *    （放进 extraPaths 参与包内路径匹配）也能被 request_access 解析到；
 *  - 静态阶段单飞（in-flight 去重）+ 60s TTL 缓存；运行中进程与窗口
 *    在每次授权时重新读取，避免启动阶段的陈旧身份进入授权。
 */

import type { InstalledApp } from '../platforms/types.js'
import { PROCESS_IMAGE_PS } from './processImage.js'

export interface RawAppEntry {
  displayName: string
  path: string
  /** Stable id — exe path preferred (launchable via Start-Process). */
  id: string
  /** Extra match tokens for the package's path-based resolver (window
   *  titles for running apps). */
  extraPaths?: string[]
}

// ── PowerShell helper ───────────────────────────────────────────────────────

async function psStage(
  script: string,
  timeoutMs: number,
): Promise<string> {
  const proc = Bun.spawn(
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', script],
    { stdout: 'pipe', stderr: 'pipe' },
  )
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

// ── Line parsing ────────────────────────────────────────────────────────────

/**
 * Parse `name|path|id|extra1;;extra2` lines. Extra segment optional.
 * Titles may themselves contain `|` (rare) — only the extra tail suffers,
 * which costs nothing but a weaker match token.
 */
export function parseAppLines(raw: string): RawAppEntry[] {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('|')
      const displayName = (parts[0] ?? '').trim()
      const path = (parts[1] ?? '').trim()
      const id = (parts[2] ?? '').trim()
      const extra = (parts[3] ?? '').trim()
      if (!displayName) return null
      return {
        displayName,
        path: path || id,
        id: id || path,
        extraPaths:
          extra && extra !== ''
            ? extra.split(';;').map(s => s.trim()).filter(Boolean)
            : undefined,
      } satisfies RawAppEntry
    })
    .filter((e): e is RawAppEntry => e !== null)
}

// ── Stages ──────────────────────────────────────────────────────────────────

const UTF8_PREFIX = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"

/** Registry Uninstall keys (3 hives) — the classic source, fast (<1s). */
async function stageRegistry(): Promise<RawAppEntry[]> {
  const raw = await psStage(
    `${UTF8_PREFIX}
$apps = @()
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($p in $paths) {
  Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object {
    $apps += "$($_.DisplayName)|$($_.InstallLocation)|$($_.PSChildName)"
  }
}
$apps
`,
    15000,
  )
  return parseAppLines(raw)
}

/** App Paths registry — exe-name → full path mapping (catches portable installs). */
async function stageAppPaths(): Promise<RawAppEntry[]> {
  const raw = await psStage(
    `${UTF8_PREFIX}
$keys = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'
)
foreach ($k in $keys) {
  Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {
    $exe = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).'(default)'
    if (-not $exe) { $exe = $_.PSChildName }
    if ($exe -and $exe.EndsWith('.exe')) {
      $name = [System.IO.Path]::GetFileNameWithoutExtension($_.PSChildName)
      "$name|$exe|$exe"
    }
  }
}
`,
    10000,
  )
  return parseAppLines(raw)
}

/**
 * Start Menu + Public Desktop shortcuts. WScript.Shell COM is hoisted out of
 * the loop — one instance resolves every .lnk (the old per-.lnk New-Object was
 * the single biggest cost with hundreds of shortcuts).
 */
async function stageShortcuts(): Promise<RawAppEntry[]> {
  const raw = await psStage(
    `${UTF8_PREFIX}
$shell = New-Object -ComObject WScript.Shell
$shortcutRoots = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:PUBLIC\\Desktop"
)
foreach ($smp in $shortcutRoots) {
  if (-not (Test-Path $smp)) { continue }
  Get-ChildItem $smp -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $lnk = $shell.CreateShortcut($_.FullName)
    if ($lnk.TargetPath -and $lnk.TargetPath.EndsWith('.exe')) {
      "$($_.BaseName)|$($lnk.TargetPath)|$($lnk.TargetPath)"
    }
  }
}
`,
    30000,
  )
  return parseAppLines(raw)
}

/**
 * Get-StartApps — UWP/MSIX entries with directly launchable AppIDs
 * (shell:AppsFolder\<AppID>). Replaces the old Get-AppxPackage source, which
 * was several times slower and produced PackageFamilyNames that still needed
 * an !App suffix to launch.
 */
async function stageStartApps(): Promise<RawAppEntry[]> {
  const raw = await psStage(
    `${UTF8_PREFIX}
Get-StartApps -ErrorAction SilentlyContinue | ForEach-Object {
  $name = $_.Name
  $appid = $_.AppID
  if ($appid -and ($appid -like '*!*' -or $appid -like '*:\\*')) {
    $launch = if ($appid -like '*.exe' -and (Test-Path -LiteralPath $appid -PathType Leaf)) { $appid } else { "shell:AppsFolder\\$appid" }
    "$name|$launch|$launch"
  }
}
`,
    15000,
  )
  return parseAppLines(raw)
}

const ENUM_WINDOWS_PS = `
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class CuRunEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    public static List<string> results = new List<string>();
    public static void Run() {
        results.Clear();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            StringBuilder sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            results.Add(pid + "\\u0001" + title.Replace("|", " "));
            return true;
        }, IntPtr.Zero);
    }
}
'@
[CuRunEnum]::Run()
[CuRunEnum]::results | ForEach-Object { $_ }
`

/**
 * Running windows → app entries. displayName = process name; exe path as id
 * when resolvable (elevated processes deny MainModule — those keep process
 * name as id, still resolvable by name but not launchable by path). Window
 * titles ride along as extraPaths so the package resolver can match
 * "MuMu模拟器" / "… — Android Studio" style requests against live windows.
 */
async function stageRunning(): Promise<RawAppEntry[]> {
  const raw = await psStage(
    `${UTF8_PREFIX}
${ENUM_WINDOWS_PS}
`,
    15000,
  )
  const byPid = new Map<number, string[]>()
  for (const line of raw.split('\n').map(l => l.trim()).filter(Boolean)) {
    const sep = line.indexOf('\u0001')
    if (sep === -1) continue
    const pid = Number(line.slice(0, sep))
    const title = line.slice(sep + 1)
    if (!Number.isInteger(pid) || pid <= 0 || !title) continue
    const titles = byPid.get(pid) ?? []
    titles.push(title)
    byPid.set(pid, titles)
  }
  if (byPid.size === 0) return []

  const pidList = [...byPid.keys()].join(',')
  const procRaw = await psStage(
    `${UTF8_PREFIX}
${PROCESS_IMAGE_PS}
Get-Process -Id ${pidList} -ErrorAction SilentlyContinue | ForEach-Object {
  $path = [CuProcessImage]::Get($_.Id)
  if (-not $path) { try { $path = $_.Path } catch {} }
  "$($_.Id)|$($_.ProcessName)|$path"
}
`,
    10000,
  )
  const procByPid = new Map<number, { name: string; path: string }>()
  for (const line of procRaw.split('\n').map(l => l.trim()).filter(Boolean)) {
    const parts = line.split('|')
    const pid = Number(parts[0])
    if (!Number.isInteger(pid) || pid <= 0) continue
    procByPid.set(pid, { name: (parts[1] ?? '').trim(), path: (parts[2] ?? '').trim() })
  }

  const entries: RawAppEntry[] = []
  for (const [pid, titles] of byPid) {
    const proc = procByPid.get(pid)
    if (!proc || !proc.name) continue
    const exePath = proc.path || ''
    entries.push({
      displayName: proc.name,
      path: exePath,
      id: exePath || proc.name,
      extraPaths: titles.slice(0, 3),
    })
  }
  return entries
}

// ── Merge (pure — unit-testable) ────────────────────────────────────────────

/**
 * Merge + dedupe raw entries by lowercase displayName. Prefer entries whose
 * id is an .exe path (directly launchable) — the winner accumulates losers'
 * paths as extraPaths so path-based resolution finds the app via any of its
 * known locations. Running-window entries merge their window titles into the
 * matched app's extraPaths (the load-bearing addition for emulator/Android
 * Studio requests: the model names what it sees in the window title).
 */
function launchablePathRank(path: string): number {
  if (!path.toLowerCase().endsWith('.exe')) return 0
  return /^shell:AppsFolder\\/i.test(path) ? 1 : 2
}

export function mergeInstalledEntries(entries: readonly RawAppEntry[]): InstalledApp[] {
  interface Accum {
    displayName: string
    id: string
    path: string
    extraPaths: string[]
  }
  const byName = new Map<string, Accum>()
  for (const entry of entries) {
    const key = entry.displayName.toLowerCase()
    if (!key) continue
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, {
        displayName: entry.displayName,
        id: entry.id,
        path: entry.path,
        extraPaths: [...(entry.extraPaths ?? [])],
      })
      continue
    }
    const existingRank = launchablePathRank(existing.id)
    const newRank = launchablePathRank(entry.id)
    const appendPaths = (paths: Array<string | undefined>) => {
      for (const p of paths) {
        if (p && p !== existing.path && !existing.extraPaths.includes(p)) {
          existing.extraPaths.push(p)
        }
      }
    }
    if (newRank > existingRank) {
      // Shortcut/running entry wins over registry — old winner's paths stay
      // as extraPaths for path-based matching.
      const loserPaths = [existing.path, existing.id !== existing.path ? existing.id : undefined]
      const loserExtras = [...existing.extraPaths]
      existing.displayName = entry.displayName
      existing.id = entry.id
      existing.path = entry.path || existing.path
      existing.extraPaths = [...(entry.extraPaths ?? [])]
      appendPaths([...loserPaths, ...loserExtras])
    } else {
      appendPaths([
        entry.path,
        entry.id !== entry.path ? entry.id : undefined,
        ...(entry.extraPaths ?? []),
      ])
    }
  }
  return [...byName.values()].map(acc => ({
    displayName: acc.displayName,
    path: acc.path,
    id: acc.id,
    ...(acc.extraPaths.length > 0 ? { extraPaths: acc.extraPaths } : {}),
  }))
}

// ── Cached entry point ──────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000
let cached: { apps: RawAppEntry[]; ts: number } | undefined
let inFlight: Promise<RawAppEntry[]> | undefined

async function listStaticApps(): Promise<RawAppEntry[]> {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.apps
  inFlight ??= (async () => {
    const settled = await Promise.allSettled([
      stageRegistry(),
      stageAppPaths(),
      stageShortcuts(),
      stageStartApps(),
    ])
    const all: RawAppEntry[] = []
    for (const r of settled) {
      if (r.status === 'fulfilled') all.push(...r.value)
    }
    return all
  })()
  try {
    const apps = await inFlight
    cached = { apps, ts: Date.now() }
    return apps
  } finally {
    inFlight = undefined
  }
}

/** Static install metadata is cached; live windows are refreshed per request. */
export async function listInstalledAppsWin32(): Promise<InstalledApp[]> {
  const [staticApps, runningApps] = await Promise.all([
    listStaticApps(),
    stageRunning().catch(() => []),
  ])
  return mergeInstalledEntries([...staticApps, ...runningApps])
}

# Doge Code 修复日志（下篇：Chapter 11-25）

上篇（Chapter 1-10）见 `debug_updates_1.md`。

---

## Chapter 11: Computer Use Windows mouse_move 修复与 cursor_position 坐标修复

### 问题描述

**发现日期**：2026-04-26
**严重程度**：中（功能缺失 + 坐标错误）
**影响范围**：所有 Windows 用户使用 Computer Use 的 `mouse_move` 和 `cursor_position` 工具

Computer Use 在 Windows HWND-bound 模式下存在两个问题：

1. **mouse_move 完全无效**：调用 `mouse_move` 后，窗口不响应任何 hover 事件（工具提示、悬停高亮、CSS hover 状态等），`cursor_position` 返回的坐标与 move 目标不一致
2. **cursor_position 返回 null**：调用 `cursor_position` 时返回 `{x: null, y: null, coordinateSpace: "image_pixels"}`

### 根本原因

#### 根因 1：moveMouse 是显式空操作

**文件**: `src/utils/computerUse/platforms/win32.ts` 第 291-296 行

```typescript
async moveMouse(x, y) {
  if (boundHwnd) {
    // Bound mode: no-op. Mouse position is meaningless for SendMessage operations.
    return  // ← 直接返回，不发送任何消息
  }
  ps(`[CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`)
},
```

HWND-bound 模式下，`moveMouse()` 直接 `return`，不发送任何窗口消息。虽然 `lastMouseX/Y` 在 `executor.ts` 中被更新，但目标窗口完全无感知。

**与 left_click 的对比**：

| 操作 | moveMouse | left_click |
|------|-----------|------------|
| 保存坐标 | ✅ `lastMouseX/Y` | ✅ `lastMouseX/Y` |
| 发送窗口消息 | ❌ 无 | ✅ `WM_MOUSEMOVE + WM_LBUTTONDOWN + WM_LBUTTONUP` |
| 真实光标移动 | ❌ 无 | ❌ 无 (SendMessage 模式) |

窗口只在 `sendClick()` 内部收到 `WM_MOUSEMOVE (0x0200)`，作为点击的前置消息。独立的 `mouse_move` 调用从不发送 `WM_MOUSEMOVE`。

#### 根因 2：cursor_position 返回真实光标位置

**文件**: `src/utils/computerUse/executor.ts` 第 374 行

```typescript
// 非 macOS 平台的 getInput() shim
mouseLocation: () => p.mouseLocation(),  // ← 调用 GetCursorPos
```

`mouseLocation()` 调用 `GetCursorPos` 获取真实光标位置，但 HWND-bound 模式下真实光标从不移动（通过 SendMessage 传递坐标，不移动物理光标）。导致：
- 模型执行 `mouse_move(960, 540)` 后，`cursor_position` 报告的光标位置不变
- 模型误以为移动失败

#### 根因 3：截图结果缺少 displayWidth/displayHeight 元数据

**文件**: `src/utils/computerUse/platforms/win32.ts` 截图相关函数

MCP 层的 `ScreenshotResult`（`packages/@ant/computer-use-mcp/src/executor.ts`）要求 `displayWidth`/`displayHeight`/`originX`/`originY` 字段用于坐标变换，但 win32 平台的截图函数只返回 `{ base64, width, height }`。

**坐标变换链**（`toolCalls.ts` `handleCursorPosition`）：

```typescript
const logical = await adapter.executor.getCursorPosition()  // { x: 960, y: 540 }
const localX = logical.x - shot.originX    // shot.originX = undefined → NaN
const localY = logical.y - shot.originY    // NaN
const x = Math.round(localX * (shot.width / shot.displayWidth))   // NaN / undefined → NaN
const y = Math.round(localY * (shot.height / shot.displayHeight)) // NaN
// JSON.stringify(NaN) → null → { x: null, y: null }
```

### 解决方法

#### 修复 1：moveMouse 发送 WM_MOUSEMOVE（windowMessage.ts + win32.ts）

**新增函数** `sendMouseMove()`：

```typescript
// src/utils/computerUse/win32/windowMessage.ts
export function sendMouseMove(hwnd: number, x: number, y: number): boolean {
  const script = `${WINMSG_TYPE}
$lp = [WinMsg]::MakeLParam(${x}, ${y})
[WinMsg]::SendMessage([IntPtr]${hwnd}, 0x0200, [IntPtr]0, $lp)
`
  return runPs(script) !== null
}
```

**修改** `moveMouse()`：

```typescript
// 修改前：空操作
async moveMouse(x, y) {
  if (boundHwnd) { return }  // no-op
  ps(`SetCursorPos(${x}, ${y})`)
},

// 修改后：发送 WM_MOUSEMOVE
async moveMouse(x, y) {
  if (boundHwnd) {
    if (ensureSendAccess()) {
      getWm().sendMouseMove(boundHwnd, Math.round(x), Math.round(y))
    }
    return
  }
  ps(`[CuWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`)
},
```

保留 `ensureSendAccess()` UIPI 权限检查，与 `click`/`typeText`/`key` 一致。

#### 修复 2：mouseLocation 返回逻辑坐标（executor.ts）

```typescript
// 修改前：返回真实光标位置
mouseLocation: () => p.mouseLocation(),

// 修改后：返回保存的逻辑坐标
mouseLocation: () => Promise.resolve({ x: lastMouseX, y: lastMouseY }),
```

HWND-bound 模式下真实光标不移动，`lastMouseX/Y` 是模型期望的逻辑位置。非 bound 模式下，`lastMouseX/Y` 与 `SetCursorPos` 的坐标一致，同样正确。

#### 修复 3：截图结果补全 display 元数据（types.ts + win32.ts + windowCapture.ts）

**平台类型扩展**：

```typescript
// src/utils/computerUse/platforms/types.ts
export interface ScreenshotResult {
  base64: string
  width: number
  height: number
  displayWidth?: number   // 新增
  displayHeight?: number  // 新增
  originX?: number        // 新增
  originY?: number        // 新增
  displayId?: number      // 新增
}
```

**全屏截图** (`captureScreen`)：

```typescript
// 修改前
return { base64: buf.toString('base64'), width: Number(wStr), height: Number(hStr) }

// 修改后
return {
  base64: buf.toString('base64'), width: Number(wStr), height: Number(hStr),
  displayWidth: Number(wStr), displayHeight: Number(hStr), originX: 0, originY: 0,
}
```

**HWND 截图** (`parseCaptureOutput`)：

```typescript
// 修改前
return { base64, width, height }

// 修改后
return { base64, width, height, displayWidth: width, displayHeight: height, originX: 0, originY: 0 }
```

**区域截图** (`captureRegion`)：

```typescript
// 修改后
return { base64, width, height, displayWidth: w, displayHeight: h, originX: x, originY: y }
```

Windows 上 `scaleFactor = 1`（无 DPI 缩放），因此 `displayWidth = width`，`displayHeight = height`。主显示器起始坐标为 `(0, 0)`。

### 修改的文件汇总

| 文件 | 修改内容 |
|------|---------|
| `src/utils/computerUse/win32/windowMessage.ts` | 新增 `sendMouseMove()` 函数 |
| `src/utils/computerUse/platforms/win32.ts` | `moveMouse()` 从 no-op 改为发送 WM_MOUSEMOVE；截图结果补全 display 元数据；input 对象添加 `sendMouseMove` 转发 |
| `src/utils/computerUse/executor.ts` | `mouseLocation()` 返回 `lastMouseX/Y` 逻辑坐标 |
| `src/utils/computerUse/platforms/types.ts` | `ScreenshotResult` 添加 `displayWidth`/`displayHeight`/`originX`/`originY`/`displayId` 可选字段 |
| `src/utils/computerUse/win32/windowCapture.ts` | `CaptureResult` 接口添加 display 元数据字段 |

### 测试验证

#### 测试场景 1：mouse_move 功能

```
1. request_access(["Desktop"]) → ✅ 授权成功
2. screenshot() → ✅ 获取屏幕截图
3. mouse_move([960, 540]) → ✅ "Moved."
4. cursor_position() → ✅ {x: 960, y: 540, coordinateSpace: "image_pixels"}

修复前：mouse_move 返回 "Moved." 但窗口无响应；cursor_position 返回 {x: null, y: null}
修复后：mouse_move 发送 WM_MOUSEMOVE；cursor_position 正确报告逻辑坐标
```

#### 测试场景 2：click 仍然正常

```
1. mouse_move([500, 300])
2. left_click([500, 300])
3. 验证 click 仍发送 WM_MOUSEMOVE + WM_LBUTTONDOWN + WM_LBUTTONUP
→ ✅ click 行为不变，坐标透传正常
```

### 已知限制

- `WM_MOUSEMOVE` 是合成消息，部分应用（尤其是 Electron/CEF 应用）可能不完全响应
- UIPI 阻止时（管理员目标窗口），`mouse_move` 无法发送 `WM_MOUSEMOVE`，静默失败（与 click 的 SendInput 回退行为一致）
- 在未执行任何 `mouse_move` 前调用 `cursor_position`，返回 `(0, 0)` 而非真实光标位置（edge case，实际使用中模型总是先截图再操作）

---

## Chapter 12: Computer Use Windows 应用发现与启动修复

### 修复日期

2026-04-26

### 问题描述

使用 `open_application` 工具打开 QQ 等部分应用程序时，工具报告 "Opened QQ" 成功，但 QQ 实际并未启动。而网易云音乐等程序可以正常打开。

### 根因分析

问题涉及两个层面：

#### 根因 1：`Select-Object -First 500` 截断了带正确路径的应用条目（主因）

`listInstalled()` 函数通过 PowerShell 从四个来源收集已安装应用：

| 来源 | 条目数 | 说明 |
|------|--------|------|
| Registry Uninstall | 368 | 标准 MSI/EXE 安装 |
| Get-AppxPackage (UWP) | 71 | Microsoft Store 应用 |
| Start Menu/Public Desktop .lnk | 201 | 快捷方式（含可执行文件路径） |
| Get-StartApps | 65 | 固定/推荐应用 |

收集完成后，PowerShell 命令末尾的 `$apps | Select-Object -Unique | Select-Object -First 500` 限制最多返回 500 个条目。但实际唯一条目数为 **640**，超出的 **140 个条目被截断**。

由于数据按 Registry → UWP → Shortcuts → Get-StartApps 顺序排列，Shortcuts 条目（201个）排在末尾。QQ 的正确条目 `QQ|D:\QQ.exe|D:\QQ.exe`（来自开始菜单快捷方式）很可能排在第 500 名之后被截掉。

截断后，QQ 只剩下 Registry 的坏条目：

```
来源: Registry (HKLM\...\Uninstall)
原始数据: QQ||QQ
解析结果: { displayName: "QQ", path: "", id: "QQ" }
```

`id: "QQ"` 不是有效的可执行文件路径，`open()` 函数无法通过此 bundleId 找到并启动 QQ。

#### 根因 2：同名应用未做路径质量去重

即使去除 500 条目限制，同名应用仍可能被后处理的低质量条目覆盖。例如 Registry 条目 `{id: "QQ", path: ""}` 和 Shortcut 条目 `{id: "D:\QQ.exe", path: "D:\QQ.exe"}` 都以 "QQ" 为 displayName。`resolveRequestedApps()` 中 `byLowerDisplayName` Map 使用 "last write wins" 策略，如果 Registry 条目在后面出现（实际上不会，但属于潜在风险），会覆盖正确的 Shortcut 条目。

### 数据验证

实际 PowerShell 数据源追踪结果：

```
[REGISTRY]   QQ | (空) | QQ           → id="QQ", path=""       (不可启动)
[SHORTCUT]   QQ | D:\QQ.exe | D:\QQ.exe → id="D:\QQ.exe", path="D:\QQ.exe" (可启动)
[STARTAPP]   QQ | QQ | QQ (filter: False) → 被 *:\* 过滤掉
```

### 修改的文件

1. **`src/utils/computerUse/platforms/win32.ts`** — `listInstalled()` 函数
2. **`packages/@ant/computer-use-mcp/src/toolCalls.ts`** — `resolveRequestedApps()` 函数

### 代码修改对比

#### 修改 1：移除 500 条目限制 (`win32.ts`)

**修改前**：

```powershell
$apps | Select-Object -Unique | Select-Object -First 500
```

**修改后**：

```powershell
$apps | Select-Object -Unique
```

#### 修改 2：添加 Public Desktop 快捷方式扫描 (`win32.ts`)

**修改前**：

```powershell
$startMenuPaths = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"
)
foreach ($smp in $startMenuPaths) {
```

**修改后**：

```powershell
$shortcutPaths = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "C:\\Users\\Public\\Desktop"
)
foreach ($smp in $shortcutPaths) {
```

#### 修改 3：同名应用智能去重 — 优先保留 .exe 路径条目 (`win32.ts`)

**修改前**：

```typescript
return raw.split('\n').filter(Boolean).map(line => {
  const [name, path, id] = line.trim().split('|', 3)
  return {
    id: (id ?? name ?? '').trim(),
    displayName: (name ?? '').trim(),
    path: (path ?? '').trim(),
  }
})
```

**修改后**：

```typescript
const entries = raw.split('\n').filter(Boolean).map(line => {
  const [name, path, id] = line.trim().split('|', 3)
  return {
    id: (id ?? name ?? '').trim(),
    displayName: (name ?? '').trim(),
    path: (path ?? '').trim(),
  }
})
// Deduplicate by displayName: prefer entries with .exe paths over
// registry entries with empty/non-exe paths (e.g. QQ||QQ from registry
// should lose to QQ|D:\QQ.exe|D:\QQ.exe from shortcuts).
const byName = new Map<string, { id: string; displayName: string; path: string }>()
for (const entry of entries) {
  const key = entry.displayName.toLowerCase()
  const existing = byName.get(key)
  if (!existing) {
    byName.set(key, entry)
  } else {
    // Prefer the entry whose id is an .exe path
    const existingIsExe = existing.id.toLowerCase().endsWith('.exe')
    const newIsExe = entry.id.toLowerCase().endsWith('.exe')
    if (newIsExe && !existingIsExe) {
      byName.set(key, entry)
    }
  }
}
return [...byName.values()]
```

#### 修改 4：改进模糊匹配评分逻辑 (`toolCalls.ts`)

**修改前** (`resolveRequestedApps()` 中的模糊匹配)：

```typescript
// Windows fuzzy matching: strip .exe suffix, try substring match
if (!resolved) {
  const clean = requested.toLowerCase().replace(/\.exe$/, '').trim();
  for (const [name, app] of byLowerDisplayName) {
    if (name.includes(clean) || clean.includes(name)) {
      resolved = app;
      break;
    }
  }
}
```

**修改后**：

```typescript
// Windows fuzzy matching: strip .exe suffix, try substring match
// Two-pass approach: first try scored matching (prevents "QQ" matching
// unrelated apps), then fall back to original loose matching to preserve
// macOS compatibility (e.g. "code" → "Visual Studio Code").
if (!resolved) {
  const clean = requested.toLowerCase().replace(/\.exe$/, '').trim();
  let bestScore = 0;
  let bestApp: InstalledApp | undefined;
  let looseMatch: InstalledApp | undefined;
  for (const [name, app] of byLowerDisplayName) {
    if (name === clean) {
      bestApp = app;
      looseMatch = app;
      break;
    }
    const shorter = Math.min(clean.length, name.length);
    if (shorter === 0) continue;
    if (name.includes(clean)) {
      const score = clean.length / name.length;
      if (score > bestScore) { bestScore = score; bestApp = app; }
      if (!looseMatch) looseMatch = app;
    } else if (clean.includes(name)) {
      if (!looseMatch) looseMatch = app;
      if (name.length >= clean.length * 0.6) {
        const score = name.length / clean.length;
        if (score > bestScore) { bestScore = score; bestApp = app; }
      }
    }
  }
  // Prefer scored match if strong enough; otherwise fall back to loose
  if (bestApp && bestScore > 0.3) {
    resolved = bestApp;
  } else if (looseMatch) {
    resolved = looseMatch;
  }
}
```

### 修复效果

修复前：
- `request_access(["QQ"])` → `bundleId: "QQ"`（无效，来自 Registry 空路径条目）
- `open_application("QQ")` → 报告成功但 QQ 未启动

修复后：
- `listInstalled()` 返回全部 640 个条目（不再截断）
- QQ 的 Shortcut 条目（`id: "D:\QQ.exe"`）优先于 Registry 条目（`id: "QQ"`）
- `request_access(["QQ"])` → `bundleId: "D:\QQ.exe"`（有效路径）
- `open_application("QQ")` → QQ 正常启动

### 影响范围

- 所有通过桌面快捷方式安装但未在注册表中记录有效 InstallLocation 的应用程序（如 QQ、绿色软件、便携应用等）
- 之前被 500 条目限制截断的所有应用程序（约 140 个）将重新可被发现和启动
- 模糊匹配更加鲁棒，防止短名称应用（如 QQ、微信等）被错误匹配到不相关应用

---

## Chapter 13: Computer Use 跨语言应用名匹配修复

### 修复日期

2026-04-26

### 问题描述

使用 `request_access` 或 `open_application` 时，通过英文名称（如 `"WeChat"`）无法找到中文 display name 的应用（如 `"微信"`），返回 `not_installed`。Chapter 12 的修复解决了 QQ 等应用因截断而无法启动的问题，但未覆盖中英文名称不匹配的场景。

### 根因分析

`resolveRequestedApps()` 的匹配逻辑完全基于 `displayName` 的子串比较：

1. **精确匹配**：`"wechat"` vs `"微信"` → 失败（不同字符集）
2. **子串匹配**：`"微信".includes("wechat")` → `false`；`"wechat".includes("微信")` → `false`
3. 两个字符串零字符重叠，无法匹配

另外，空格差异也会导致匹配失败：

```
请求: "OPPO互联"
displayName: "OPPO 互联" (OPPO 和互联之间有空格)

精确匹配: "oppo互联" !== "oppo 互联" → 失败
子串匹配: "oppo 互联".includes("oppo互联") → false → 失败
```

**关键遗漏 1**：注册表中 `InstallLocation` 字段包含英文路径（如 `D:\WeChat`），但去重时被丢弃：

```
Registry 条目: { displayName: "微信", path: "D:\WeChat", id: "{GUID}" }
Shortcut 条目: { displayName: "微信", path: "D:\Weixin\Weixin.exe", id: "D:\Weixin\Weixin.exe" }

去重后（.exe 优先）: { displayName: "微信", path: "D:\Weixin\Weixin.exe", id: "D:\Weixin\Weixin.exe" }
                       ↑ Registry 的 path "D:\WeChat" 被丢弃！
```

**关键遗漏 2**：精确匹配对空格/连字符敏感，无归一化处理。

### 解决方法

三层修改：

#### 修改 1：去重时合并路径（win32.ts）

在 `listInstalled()` 的去重逻辑中，当 shortcut 条目替换 registry 条目时，保留 registry 的 `path` 到新增的 `extraPaths` 字段：

**修改前**：

```typescript
if (newIsExe && !existingIsExe) {
  byName.set(key, entry)  // 直接替换，丢弃 registry 条目
}
```

**修改后**：

```typescript
if (newIsExe && !existingIsExe) {
  // Shortcut wins over registry — keep registry's path as extraPaths
  const mergedPaths: string[] = []
  if (existing.path && existing.path !== entry.path) mergedPaths.push(existing.path)
  if (entry.path && !mergedPaths.includes(entry.path)) mergedPaths.push(entry.path)
  byName.set(key, { ...entry, extraPaths: mergedPaths.length > 0 ? mergedPaths : undefined })
} else if (!newIsExe && existingIsExe) {
  // Registry loses to shortcut — keep registry's path as extraPaths on winner
  if (entry.path && entry.path !== existing.path) {
    const existingExtras = existing.extraPaths ?? []
    if (!existingExtras.includes(entry.path)) {
      existing.extraPaths = [...existingExtras, entry.path]
    }
  }
}
```

#### 修改 2：接口扩展（executor.ts）

`InstalledApp` 新增可选字段：

```typescript
export interface InstalledApp {
  bundleId: string
  displayName: string
  path: string
  extraPaths?: string[]  // 新增：来自被合并条目的额外路径（如 registry InstallLocation）
  iconDataUrl?: string
}
```

`listInstalled` 映射中透传 `extraPaths`：

```typescript
listInstalled: async () => (await platform!.apps.listInstalled()).map(a => ({
  bundleId: a.id, displayName: a.displayName, path: a.path,
  extraPaths: (a as any).extraPaths,
})),
```

#### 修改 3：归一化匹配（toolCalls.ts）

在精确匹配之后、子串匹配之前，新增去空格/连字符/下划线的归一化比较。处理 `"OPPO互联"` vs `"OPPO 互联"` 等空格差异：

```typescript
// Normalized match: strip spaces/dashes/hyphens for comparison.
if (!resolved) {
  const stripNorm = (s: string) => s.toLowerCase().replace(/[\s\-_]/g, '')
  const normRequested = stripNorm(requested)
  for (const [name, app] of byLowerDisplayName) {
    if (stripNorm(name) === normRequested) {
      resolved = app
      break
    }
  }
}
```

#### 修改 4：路径匹配回退（toolCalls.ts）

在 displayName 匹配失败后，新增路径段匹配回退。对 `app.path`、`app.bundleId` 和 `app.extraPaths` 的最后两个路径段进行评分匹配：

```typescript
// Path-based fallback: bridges cross-language gaps
if (!resolved) {
  const clean = requested.toLowerCase().replace(/\.exe$/, '').trim();
  let bestScore = 0;
  let bestApp: InstalledApp | undefined;
  for (const app of installed) {
    const pathParts: string[] = [];
    if (app.path) pathParts.push(app.path.toLowerCase());
    if (app.bundleId) pathParts.push(app.bundleId.toLowerCase());
    if (app.extraPaths) {
      for (const ep of app.extraPaths) pathParts.push(ep.toLowerCase());
    }
    for (const part of pathParts) {
      const segments = part.split(/[/\\]/);
      for (let si = Math.max(0, segments.length - 2); si < segments.length; si++) {
        const raw = (segments[si] || '').replace(/\.exe$/, '').trim();
        if (!raw) continue;
        if (raw === clean) {
          bestApp = app; bestScore = 1.0;
        } else if (raw.includes(clean)) {
          const score = clean.length / raw.length;
          if (score > bestScore) { bestScore = score; bestApp = app; }
        } else if (clean.includes(raw) && raw.length >= clean.length * 0.6) {
          const score = raw.length / clean.length;
          if (score > bestScore) { bestScore = score; bestApp = app; }
        }
      }
    }
  }
  if (bestApp && bestScore > 0.3) resolved = bestApp;
}
```

### 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `packages/@ant/computer-use-mcp/src/executor.ts` | `InstalledApp` 新增 `extraPaths?` 字段；映射透传 |
| `src/utils/computerUse/platforms/win32.ts` | 去重时合并路径到 `extraPaths` |
| `packages/@ant/computer-use-mcp/src/toolCalls.ts` | 新增路径段匹配回退（`resolveRequestedApps`） |

### 匹配流程示例

#### WeChat → 微信（修复后）

```
InstalledApp: {
  bundleId: "D:\Weixin\Weixin.exe",
  displayName: "微信",
  path: "D:\Weixin\Weixin.exe",
  extraPaths: ["D:\WeChat"]           ← 来自 registry 的 InstallLocation
}

request_access(["WeChat"]):
  1. displayName 精确: "wechat" vs "微信" → 失败
  2. displayName 子串: 无重叠 → 失败
  3. 路径匹配 (新增):
     - path "D:\Weixin\Weixin.exe" → 段 "weixin", "weixin" vs "wechat" → 不匹配
     - extraPaths ["D:\WeChat"] → 段 "d:", "wechat" vs "wechat" → 精确匹配! score=1.0 ✅
  → resolved = 微信应用 ✅
```

#### QQ（已修复场景不受影响）

```
InstalledApp: { displayName: "QQ", bundleId: "D:\QQ.exe" }
request_access(["QQ"]):
  1. displayName 精确: "qq" vs "qq" → 命中 ✅
  （归一化匹配和路径匹配不触发）
```

#### OPPO互联（归一化匹配命中）

```
InstalledApp: { displayName: "OPPO 互联", bundleId: "D:\Program Files\Oppo Connect\O+Connect.exe" }
request_access(["OPPO互联"]):
  1. displayName 精确: "oppo互联" !== "oppo 互联" → 失败（空格差异）
  2. 归一化匹配: stripNorm("OPPO 互联") = "oppo互联" === stripNorm("OPPO互联") = "oppo互联" → 命中 ✅
```

### macOS 影响评估

| 修改点 | macOS 影响 |
|--------|-----------|
| `InstalledApp.extraPaths` 接口 | ✅ 可选字段，macOS Swift 模块不返回，值为 `undefined` |
| `executor.ts` 映射透传 | ✅ macOS 走 `cu.apps.listInstalled()`，不经此分支 |
| `win32.ts` 去重合并 | ✅ 仅 Windows 平台代码 |
| `toolCalls.ts` 归一化匹配 | ✅ macOS displayName 通常无空格差异问题，精确匹配优先命中，归一化匹配作为安全兜底不影响已有行为 |
| `toolCalls.ts` 路径匹配 | ✅ macOS displayName 通常为英文名，精确匹配优先；路径匹配作为增强不影响已有行为 |

### 适用场景

此修复适用于所有 displayName 与可执行文件路径/安装目录不一致，或 displayName 含空格/连字符的应用：

| 请求名 | displayName | 匹配方式 |
|--------|------------|---------|
| `"WeChat"` | `"微信"` | extraPaths `"D:\WeChat"` 路径段精确匹配 |
| `"OPPO互联"` | `"OPPO 互联"` | 归一化匹配（去空格后精确命中） |
| `"Steam"` | `"Steam"` | displayName 精确匹配（无需路径匹配） |
| `"chrome"` | `"Google Chrome"` | displayName 子串匹配（已有逻辑） |
| `"VSCode"` | `"Visual Studio Code"` | 路径段 `"code"` 子串匹配 |

- Computer Use 跨语言应用名匹配修复：2026-04-26

---

## Chapter 14: Computer Use Windows DPI 缩放与坐标修复

**日期**: 2026-04-26
**问题**: Windows 高 DPI 显示（125%/150%/200%）下，截图尺寸和鼠标坐标不一致，导致截屏后能看到画面但点击/移动位置偏移

### 根因分析

三个独立的 bug 共同导致坐标偏移：

1. **DPI 感知缺失**: 所有 PowerShell 脚本以 DPI-unaware 模式运行，`GetWindowRect`、`Screen.Bounds`、`CopyFromScreen` 返回的是逻辑像素而非物理像素。例如 1920x1080 @150% 缩放时，截图只有 1280x720

2. **scaleFactor 硬编码为 1**: `display.getSize()` 和 `display.listAll()` 硬编码返回 `scaleFactor: 1`，未检测实际 DPI

3. **SendMessage 坐标未修正标题栏偏移**: `PrintWindow` 截图包含标题栏和边框（窗口矩形），但 `WM_MOUSEMOVE`/`WM_LBUTTONDOWN` 的 lParam 使用的是客户区坐标，两者之间存在标题栏高度+边框宽度的偏移

### 修复方案

#### 1. 所有坐标相关的 PowerShell 脚本添加 DPI 感知

在每个 PowerShell 脚本开头调用 `SetProcessDPIAware()`，使 `GetWindowRect`、`Screen.Bounds`、`CopyFromScreen`、`SetCursorPos` 都返回/使用物理像素。

**修改文件**:
- `windowCapture.ts` — `WinCap` 和 `WinCapH` 类中添加 `[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();` 并在 `Capture()` 开头调用
- `windowMessage.ts` — `WinMsg` 类中添加 `SetProcessDPIAware()` P/Invoke 和 `GetClientOffset()` 方法中的调用
- `platforms/win32.ts` — 添加 `DPI_AWARE_PS` 常量前缀；在 `CuWin32` 类中添加 `SetProcessDPIAware` P/Invoke；所有 `SetCursorPos`/`SendInput`/`GetCursorPos` 调用前加入 `[CuWin32]::SetProcessDPIAware()`

#### 2. 正确检测 DPI scale factor

`display.listAll()` 使用 `GetDeviceCaps(hdc, LOGPIXELSX)` 获取实际 DPI，计算 `scaleFactor = dpi / 96.0`。

**修改文件**: `platforms/win32.ts` — display section

#### 3. SendMessage 鼠标坐标修正客户区偏移

`sendMouseMove` 和 `sendClick` 中，通过 `GetWindowRect + ClientToScreen(0,0)` 计算标题栏和边框的偏移量（offsetX, offsetY），然后从窗口相对坐标中减去该偏移，得到正确的客户区坐标。

**修改文件**: `windowMessage.ts` — `GetClientOffset()` 方法、`sendMouseMove()`、`sendClick()`

#### 4. 修复 windowCapture.ts parseCaptureOutput 缺失字段

原 `parseCaptureOutput` 返回 `{ base64, width, height }` 缺少 `displayWidth`、`displayHeight`、`originX`、`originY` 字段，补充完整。

### 修改文件列表

| 文件 | 修改内容 |
|------|---------|
| `win32/windowCapture.ts` | `SetProcessDPIAware()` P/Invoke + 调用；`parseCaptureOutput` 补全字段 |
| `win32/windowMessage.ts` | `SetProcessDPIAware()`、`GetWindowRect`、`ClientToScreen` P/Invoke；`GetClientOffset()` 方法；`sendMouseMove`/`sendClick` 坐标修正 |
| `platforms/win32.ts` | `DPI_AWARE_PS` 常量；`CuWin32.SetProcessDPIAware`；display DPI 检测；captureScreen/captureRegion/cropScreenshot DPI 前缀；input 所有坐标操作 DPI 前缀 |

### 坐标流程（修复后）

```
截图(PrintWindow/GetWindowRect) → 物理像素尺寸 (e.g., 1920x1080)
    ↓
模型看到物理分辨率截图，生成物理像素坐标
    ↓
HWND 绑定路径: sendClick(hwnd, x, y)
  → GetClientOffset(hwnd): titleBarHeight, borderWidth
  → clientX = x - offsetX, clientY = y - offsetY
  → SendMessage(WM_LBUTTONDOWN, MakeLParam(clientX, clientY))
    ↓
UIPI 回退/全局路径: SetCursorPos(x, y) + SendInput
  → DPI-aware 模式下直接使用物理像素坐标
```

### 跨平台影响

| 修改 | 影响范围 |
|------|---------|
| `windowCapture.ts` | 仅 Windows |
| `windowMessage.ts` | 仅 Windows |
| `platforms/win32.ts` | 仅 Windows |
| `executor.ts` | 无修改 |
| macOS `darwin.ts` | 无影响 |

---

## Chapter 15: Electron/CEF 应用鼠标点击修复

### 问题描述

Computer Use 在 Windows 上操作 Electron/CEF 应用（如网易云音乐）时，鼠标移动和点击完全无效。

**根因分析**：

1. **Chromium 忽略 SendMessage 鼠标消息**：Electron/CEF 应用基于 Chromium 渲染引擎，其输入处理走真实的输入队列（raw input queue），不处理通过 `SendMessage(WM_LBUTTONDOWN/WM_MOUSEMOVE)` 发送的合成消息。现有的 `ensureSendAccess()` 检测只发送 `WM_NULL` 测试 UIPI，Electron 能响应 `WM_NULL`（有消息队列），所以返回 `sendMessageOk = true`，永远不会触发 SendInput 回退。

2. **UIPI 回退路径坐标错误**：当 UIPI 阻塞 SendMessage 时，回退代码直接将截图坐标（窗口相对）传给 `SetCursorPos()`，但 `SetCursorPos` 需要屏幕坐标。缺少 `GetWindowRect` 的坐标转换。

3. **moveMouse 无回退**：当 SendMessage 被阻塞时，`moveMouse` 静默返回，不做任何操作。

### 解决方法

#### 1. Chromium 窗口检测（bind time）

在 `bindWindow()` 绑定窗口时，使用 `EnumChildWindows` + `GetClassName` 枚举子窗口。如果发现子窗口类名以 `Chrome_RenderWidgetHostHWND` 或 `Chrome_WidgetWin_` 开头，标记 `isChromium = true`。

```
bindWindow(hwnd) → detectChromium(hwnd) → EnumChildWindows → GetClassName
  → 匹配 Chrome_RenderWidgetHostHWND / Chrome_WidgetWin_*
  → isChromium = true/false
```

#### 2. Chromium 窗口使用 SendInput + 屏幕坐标

当 `isChromium = true` 时，鼠标操作绕过 SendMessage，改用 SendInput：

- **moveMouse**: `GetWindowRect(hwnd)` → 屏幕坐标 `(left + x, top + y)` → `SetCursorPos(sx, sy)`
- **click**: `GetWindowRect(hwnd)` → 屏幕坐标 → `SetCursorPos` + `SendInput(MOUSEEVENTF_DOWN/UP)`
- **scroll**: `SendInput(MOUSEEVENTF_WHEEL)` 替代 `WM_VSCROLL/WM_HSCROLL`

所有操作将 `GetWindowRect` 和 `SetCursorPos`/`SendInput` 合并在同一个 PowerShell 调用中，避免额外的延迟。

#### 3. 修复 UIPI 回退坐标

UIPI 回退路径也使用新的 `sendInputClick()` 辅助函数，确保坐标正确转换为屏幕坐标。

### 修改的文件

- `src/utils/computerUse/platforms/win32.ts`
  - 新增 `isChromium` 会话变量
  - 新增 `detectChromium()` 函数（枚举子窗口检测 Chromium）
  - 新增 `sendInputClick()` 和 `sendInputMove()` 辅助函数（GetWindowRect + 坐标转换 + SendInput）
  - 修改 `input.moveMouse()` — 添加 `isChromium` 分支
  - 修改 `input.click()` — 添加 `isChromium` 分支 + 修复 UIPI 回退坐标
  - 修改 `input.scroll()` — 添加 `isChromium` 分支
  - 修改 `bindWindow()` — 调用 `detectChromium()`
  - 修改 `unbindWindow()` — 重置 `isChromium`

### 坐标转换流程

```
截图坐标 (x, y) — 相对于窗口左上角（PrintWindow 输出）
    ↓ GetWindowRect(hwnd) → (left, top)
屏幕坐标 = (left + x, top + y)
    ↓
SetCursorPos(sx, sy)  — 移动真实光标
SendInput(MOUSEEVENTF_DOWN/UP)  — 模拟真实点击
```

### 跨平台影响

| 修改 | 影响范围 |
|------|---------|
| `platforms/win32.ts` | 仅 Windows |
| `windowMessage.ts` | 无修改 |
| `windowCapture.ts` | 无修改 |
| macOS `darwin.ts` | 无影响 |

---

## Chapter 16: Windows 截图缩放与坐标精度修复

### 问题描述

在 Windows 系统上使用 Computer Use 时，鼠标移动/点击位置与模型预期不一致。根本原因有两个：

1. **scaleFactor 双重计算**：`display.listAll()` 返回物理像素尺寸（如 2560x1600），但同时报告 `scaleFactor=1.5`（DPI 缩放比）。`computeTargetDims` 假设输入是逻辑像素并乘以 scaleFactor，导致 `physW = 2560 × 1.5 = 3840`（实际物理只有 2560）。

2. **缺少预缩放**：Windows 截图以原始物理分辨率（2560x1600）发送给 API。API 的图片转码器发现超过 token 预算后在服务端缩放到未知尺寸，但 `scaleCoord` 仍使用原始 2560x1600 计算 → 坐标不匹配。macOS 通过 `targetImageSize` 预缩放避免此问题，Windows 路径跳过了这一步。

### 解决方法

**修复 1：`display.listAll()` scaleFactor 设为 1**

`SetProcessDPIAware()` 后 `Screen.Bounds` 返回的已经是物理像素，不需要再乘 scaleFactor。设为 1 避免 `computeTargetDims` 双重计算。

**修复 2：`captureScreen()` 添加 targetW/targetH 参数**

接收预计算的缩放目标尺寸，在 PowerShell 脚本中用 .NET `Graphics.DrawImage` 进行高质量双三次插值缩放。返回结果中 `width/height` 为缩放后尺寸，`displayWidth/displayHeight` 为原始物理尺寸，确保 `scaleCoord` 比率正确映射回物理坐标空间。

**修复 3：executor.ts 传递 targetW/targetH**

`resolvePrepareCapture` 和 `captureExcluding` 的 Windows 路径之前忽略 targetW/targetH 参数，现在正确传递给 `captureScreen()`。

### 坐标流对比

**修复前（错误）：**
```
display.listAll() → {width:2560, height:1600, scaleFactor:1.5}
computeTargetDims(2560, 1600, 1.5) → physW=3840 (错误! 双重计算)
截图: 2560×1600, 无缩放, API 服务端缩放到未知尺寸
scaleCoord ratio = displayWidth/width = 2560/2560 = 1.0
→ 模型看到缩放后的图像但 scaleCoord 用原始尺寸 → 坐标偏移
```

**修复后（正确）：**
```
display.listAll() → {width:2560, height:1600, scaleFactor:1}
computeTargetDims(2560, 1600, 1) → physW=2560 → targetImageSize(2560,1600) → [~1372, ~858]
截图: 捕获 2560×1600, PowerShell 内缩放到 ~1372×858
displayWidth=2560 (物理), width=1372 (缩放后), ratio=2560/1372≈1.87
scaleCoord: 模型坐标 × 1.87 → 物理像素坐标 → SetCursorPos 正确
```

### 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `src/utils/computerUse/platforms/win32.ts` | `display.listAll()` scaleFactor=1; `captureScreen()` 添加 targetW/targetH 缩放; 新增 `downscaleCapture()` 工具函数 |
| `src/utils/computerUse/executor.ts` | `resolvePrepareCapture` 和 `captureExcluding` 传递 targetW/targetH |
| `src/utils/computerUse/platforms/types.ts` | `ScreenshotPlatform.captureScreen` 签名添加可选 targetW/targetH |

### 跨平台影响

| 修改 | 影响范围 |
|------|---------|
| `platforms/win32.ts` | 仅 Windows |
| `executor.ts` Windows 路径 | 仅非 macOS（Windows/Linux） |
| `platforms/types.ts` | 类型签名扩展，向后兼容 |
| macOS Swift 路径 | 无影响 |

### 补充修复：截图响应中添加尺寸信息

截图工具返回给模型的响应中缺少图片尺寸信息，导致模型无法准确确定截图的像素尺寸，只能猜测（如假设 1920x1080）。

**修复**：在 `toolCalls.ts` 的 `handleScreenshot` 函数中，为截图响应添加文本说明：
```
Screenshot dimensions: {width}x{height} pixels. All mouse/click coordinates must be within this pixel space (0–{width}, 0–{height}).
```

模型看到此文本后可以精确知道截图尺寸，从而发送正确的像素坐标。

**修改文件**：`packages/@ant/computer-use-mcp/src/toolCalls.ts`（两处 return 均已修改）

## Chapter 17: PowerShell 可变结构体陷阱 — SendInput 点击/滚动无效

**日期**：2026-05-01

**问题**：鼠标点击（left_click）和滚动（scroll）操作无法生效。鼠标光标能正确移动到目标位置，但不会执行实际的点击操作。网易云音乐等 Electron 应用中点击播放按钮无反应。

**根因**：PowerShell 对嵌套结构体的属性赋值不会修改原始对象。在 PowerShell 中执行 `$i.mi.dwFlags = value` 时：
1. `$i.mi` 返回 MOUSEINPUT 结构体的一个**副本**（因为结构体是值类型）
2. `.dwFlags = value` 修改的是这个副本
3. 副本被丢弃，原始 `$i.mi.dwFlags` 仍然是 0

结果：`SendInput` 收到的是一个 `dwFlags = 0` 的鼠标事件，等同于空操作。

**验证测试**：
```powershell
# 方法1 (嵌套赋值 - 不工作):
$i.mi.dwFlags = [CuWin32]::MOUSEEVENTF_LEFTDOWN
# 结果: dwFlags=0 (副本被丢弃)

# 方法2 (单独结构体赋值 - 应该工作):
$mi = New-Object CuWin32+MOUSEINPUT
$mi.dwFlags = [CuWin32]::MOUSEEVENTF_LEFTDOWN
$i.mi = $mi
# 结果: dwFlags=2 (正确)
```

**彻底修复**：放弃 `SendInput` + INPUT 结构体，改用 `mouse_event` API。

`mouse_event` 接受简单参数（uint dwFlags, int dx, int dy, int dwData, IntPtr dwExtraInfo），完全不涉及结构体，从根本上避免了 PowerShell 的可变结构体陷阱。

修复前（不工作）：
```powershell
$i = New-Object CuWin32+INPUT
$i.mi.dwFlags = [CuWin32]::MOUSEEVENTF_LEFTDOWN  # 写入副本！
[CuWin32]::SendInput(1, @($i), ...)
```

修复后（简单可靠）：
```powershell
[CuWin32]::SetCursorPos($sx, $sy)
[CuWin32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)  # LEFTDOWN
[CuWin32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)  # LEFTUP
```

**影响的代码路径**：
- `sendInputClick()` — Chromium 窗口的点击（HWND 绑定和非绑定两处）
- `scroll()` — Chromium 窗口的滚动（HWND 绑定和非绑定两处）

**修改文件**：

| 文件 | 修改 |
|------|------|
| `src/utils/computerUse/platforms/win32.ts` | 添加 `mouse_event` P/Invoke；重写 4 处输入调用 |
| `debug_updates.md` | 本章记录 |

**技术说明**：`mouse_event` 是 Win32 的旧式鼠标输入 API，虽然在 MSDN 上标记为"已取代 by SendInput"，但功能完全等价且更简单。`SendInput` 的优势是支持批量输入，但在我们的场景中每次只发送一个事件，`mouse_event` 完全够用且避免了 PowerShell 结构体问题。

**验证**：重启 doge-code 后，在网易云音乐中点击播放按钮应能正常播放音乐。

---


## Chapter 18: DeepSeek Max Effort 支持修复

### 修复日期

2026-05-06

### 问题描述

DeepSeek 模型设置 `CLAUDE_CODE_EFFORT_LEVEL="max"` 后只显示 `high` effort，无法使用 `max` 思考程度。

### 根本原因

1. **API Provider 识别错误**：`getAPIProvider()` 只检查 `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`，不识别自定义 OpenAI 兼容 API，返回 `'firstParty'`。`get3PModelCapabilityOverride()` 在 `firstParty` 模式下直接返回 `undefined`，跳过能力声明检查。

2. **模型名称不匹配**：`ANTHROPIC_MODEL="deepseek-v4-pro[1m]"` 与 `ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro"` 不一致。

### 解决方法

修改 `get3PModelCapabilityOverride()`，当检测到 `ANTHROPIC_BASE_URL`（自定义 API 端点）时，即使 provider 识别为 `firstParty`，也继续检查能力声明：

```typescript
// src/utils/model/modelSupportOverrides.ts
const isCustomApi = process.env.ANTHROPIC_BASE_URL && provider === 'firstParty'
if (provider === 'firstParty' && !isCustomApi) {
  return undefined
}
```

### 正确配置

```powershell
# start_deepseek.ps1
Remove-Item Env:\CLAUDE_CODE_USE_FOUNDRY -ErrorAction SilentlyContinue  # 必须清除
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com"
$env:ANTHROPIC_MODEL = "deepseek-v4-pro"  # 不带 [1m] 后缀
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro"  # 与上面完全一致
$env:ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = "effort,max_effort,thinking,adaptive_thinking"
$env:CLAUDE_CODE_EFFORT_LEVEL = "max"
```

### 修改的文件

- `src/utils/model/modelSupportOverrides.ts` — 修改 `get3PModelCapabilityOverride()` 函数
- `start_deepseek.ps1` — 环境变量配置

---

## Chapter 19: Claude-to-IM 集成修复

### 修复日期

2026-05-06

### 问题描述

在 Windows 上使用 claude-to-im skill 连接微信时，存在三个问题：

1. **流不关闭**：Claude 生成回复后消息永不发送到微信
2. **工具调用缺失**：简化版 handler 只支持纯对话，无法使用 Read/Write/Bash 等工具
3. **多 provider 不支持**：简化版直接使用 Anthropic SDK，无法调用 OpenAI 格式 API（如 DeepSeek），导致 404 错误
4. **reasoning_content 丢失**：DeepSeek 推理模型多轮工具调用时报 400 错误

### 根本原因

1. **流不关闭**：`simpleStreamJson.ts` 发送 `result` 消息后没有关闭 stdin 或退出进程，SDK 的 `for await` 循环永远无法结束，消息无法被提取发送。

2. **工具缺失**：Bun 在 Windows 上加载 `print.ts` 时挂起，必须使用简化版本。但原始简化版是纯 API 包装器，无工具支持。

3. **多 provider 不支持**：简化版 `new Anthropic()` SDK 硬编码，忽略 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 环境变量。

4. **reasoning_content**：DeepSeek 要求多轮对话传回 `reasoning_content`，简化版未捕获此字段。

### 解决方法

#### 修复 1：流关闭

在 `simpleStreamJson.ts` 中发送 `result` 后立即关闭：

```typescript
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, ... }));
rl.close();
process.exit(0);
```

#### 修复 2：增强工具调用

创建 `simpleStreamJsonWithTools.ts`，实现完整的多轮工具调用循环，支持 6 个核心工具：Read、Write、Edit、Bash、Glob、Grep。移除硬编码的 `maxTurns = 10` 限制。

#### 修复 3：多 provider 路由

在两个 handler 中检查 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER`：

```typescript
const provider = process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER || 'anthropic';
if (provider === 'openai' && baseURL) {
  // 使用 fetch + SSE 解析调用 /v1/chat/completions
} else {
  // 使用 Anthropic SDK
}
```

工具格式双向转换：Anthropic `{ name, description, input_schema }` ↔ OpenAI `{ type: 'function', function: { name, description, parameters } }`。

#### 修复 4：reasoning_content 透传

在 OpenAI 格式流中捕获 `delta.reasoning_content`，累积到 `reasoningContent` 变量，在多轮对话的 assistant 消息中作为 `reasoning_content` 字段传回：

```typescript
if (delta?.reasoning_content) { reasoningContent += delta.reasoning_content; }
// ... 多轮传回
if (reasoningContent) { assistantMsg.reasoning_content = reasoningContent; }
```

### 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `src/cli/simpleStreamJson.ts` | 添加 `rl.close()` + `process.exit(0)`；添加 OpenAI provider 路由 + reasoning_content 捕获 |
| `src/cli/simpleStreamJsonWithTools.ts` | 新建：完整工具调用循环 + OpenAI 路由 + reasoning_content 透传 |
| `src/main.tsx` | 切换到 `simpleStreamJsonWithTools.ts` |

### 日志对比

**修复前（流不关闭）：**
```
[SIMPLE] Stream completed, sending result
{"type":"result","subtype":"success",...}
[llm-provider] Result received: subtype=success is_error=false
# 卡在这里，永远不会有下一行
```

**修复后（正常）：**
```
[SIMPLE] Stream completed, sending result
{"type":"result","subtype":"success",...}
[llm-provider] CLI exited: code=0 signal=null
[llm-provider] SDK for-await loop ended  ← 关键：循环结束
```

### Claude-to-IM 安装指南（Windows）

```bash
# 1. 安装 Skill
npx skills add op7418/Claude-to-IM-skill --yes

# 2. 构建核心库
cd ~/.doge/skills/claude-to-im-core && npm install && npx tsc -p tsconfig.build.json

# 3. 构建 Skill
cd ~/.doge/skills/claude-to-im && npm install && npm run build

# 4. 微信扫码绑定
cd ~/.doge/skills/claude-to-im && npm run weixin:login

# 5. 创建 ~/.claude-to-im/config.env
```

配置示例：
```bash
CTI_RUNTIME=claude
CTI_ENABLED_CHANNELS=weixin
CTI_DEFAULT_WORKDIR=C:/Users/你的用户名
CTI_DEFAULT_MODE=code
CTI_AUTO_APPROVE=true
CTI_CLAUDE_CODE_EXECUTABLE=C:/Users/你的用户名/.bun/bin/doge.exe
CTI_BUN_EXECUTABLE=E:/Bun_install/bun.exe
```

```bash
# 6. 启动
bash ~/.doge/skills/claude-to-im/scripts/daemon.sh start
```

---

## Chapter 20: 1M 超长上下文处理机制修复

### 修复日期

2026-05-06

### 问题描述

使用 1M 超长上下文时出现：
1. **卡死**：系统认为上下文已满，不断触发自动压缩
2. **上下文溢出**：autoCompact 阈值基于错误的 200k 计算
3. **[1m] 后缀无效**：`deepseek-chat[1m]` 仍识别为 102.4k

### 根本原因

#### 原因 1：betas 参数未同步到全局状态

`claude.ts` 的 `paramsFromContext()` 动态添加 `CONTEXT_1M_BETA_HEADER` 到 API 请求的 betas 中，但没有调用 `setSdkBetas()` 更新全局状态。autoCompact 检查时 `getSdkBetas()` 返回旧值，上下文窗口仍识别为 200k。

```
API 请求: betas = ['context-1m-2025-08-07']  ← 包含 1M header
getSdkBetas(): undefined                        ← 全局状态未更新
autoCompact: 上下文窗口 = 200k                   ← 错误！实际是 1M
```

#### 原因 2：[1m] 后缀检查优先级低于硬编码模型

`getContextWindowForModel()` 先检查 `deepseek` → 返回 102.4k，再检查 `[1m]` 后缀。用户设置 `deepseek-chat[1m]` 的意图被忽略。

### 解决方法

#### 修复 1：同步 betas 到全局状态

```typescript
// src/services/api/claude.ts — paramsFromContext()
lastRequestBetas = betasParams
setSdkBetas(betasParams)  // 新增：同步到全局状态
```

#### 修复 2：提升 [1m] 后缀优先级

```typescript
// src/utils/context.ts — getContextWindowForModel()
// 优先检查 [1m] 后缀（用户显式意图）
if (has1mContext(model)) return 1_000_000
// 然后才检查硬编码模型
if (modelLower.includes('deepseek')) return 102_400
```

### 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `src/services/api/claude.ts` | `paramsFromContext()` 中添加 `setSdkBetas(betasParams)` |
| `src/utils/context.ts` | `getContextWindowForModel()` 中将 `[1m]` 检查提前 |

### 修复效果

| | 修复前 | 修复后 |
|---|--------|--------|
| 模型 | `deepseek-chat[1m]` | `deepseek-chat[1m]` |
| getSdkBetas() | `undefined` | `['context-1m-2025-08-07']` |
| 上下文窗口 | 102,400 (Ch20) → 1,000,000 (Ch21) | 1,000,000 (正确) |
| autoCompact 阈值 | 89,400 (Ch20) → 967,000 (Ch21) | 967,000 tokens |
| 结果 | 在 89k 就触发压缩 | 在 987k 才触发压缩 |

### 使用方法

```bash
# 方法 1：[1m] 后缀（推荐）
export ANTHROPIC_MODEL="deepseek-chat[1m]"

# 方法 2：环境变量覆盖
export CLAUDE_CODE_MODEL_CONTEXT_WINDOW=1000000

# 方法 3：组合使用
export ANTHROPIC_MODEL="gpt-4o"
export CLAUDE_CODE_MODEL_CONTEXT_WINDOW=128000
```

### 上下文窗口检测优先级

1. `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` 环境变量（最高）
2. `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（ant-only）
3. `[1m]` 后缀（Ch20 修复后提升至此）
4. 硬编码第三方模型（DeepSeek 1M, GLM 128k, Gemini 1M 等）
5. `modelCapabilities` API 查询
6. `betas` 参数中的 `CONTEXT_1M_BETA_HEADER`
7. 默认值 200k

> 注：Ch21 进一步将 DeepSeek 硬编码值从 102.4k 更新为 1M，并为第三方 API 补全了 `[1m]` 后缀剥离和 PTL 错误识别。见 Chapter 21。

---

## Chapter 21: 第三方 API 上下文溢出修复

### 问题描述

**发现日期**：2026-05-08
**严重程度**：高（上下文压缩失败导致会话卡死）
**影响范围**：所有使用 OpenAI/Responses 格式 API 的第三方模型（DeepSeek、GLM、GPT 等）+ Opus 1M 场景

使用第三方模型（DeepSeek V4 Pro/Flash）或 Opus 配合 1M 上下文时，即使通过 `CLAUDE_CODE_MODEL_CONTEXT_WINDOW="1000000"` 或 `[1m]` 后缀正确设置了上下文窗口，自动压缩仍然失败或卡死。

### 根本原因

**问题 A: `[1m]` 后缀未剥离，直接发送给第三方 API**

`openaiCompat.ts:136-137` 和 `responsesCompat.ts:156-157` 直接使用 `ANTHROPIC_MODEL` 环境变量作为模型名发送给 API。如果用户设了 `ANTHROPIC_MODEL="deepseek-chat[1m]"`，`[1m]` 会原样发送给 DeepSeek API，导致模型名不识别。

**问题 B: OpenAI 格式的上下文溢出错误不被识别为 PTL**

当上下文超过 API 限制时，第三方 API 返回：
```json
{"error": {"message": "This model's maximum context length is 65536 tokens...", "type": "invalid_request_error", "code": "context_length_exceeded"}}
```

但 `errors.ts:563-575` 的 PTL 检测只识别 `"prompt is too long"` 字样。第三方 API 的错误被当作普通 API 错误处理，不触发 reactive compact、不触发 PTL 重试、不触发 `truncateHeadForPTLRetry`。

**问题 C: DeepSeek 上下文窗口硬编码过时**

`context.ts:96` 将 DeepSeek 上下文窗口硬编码为 `102_400`，但 DeepSeek V4 Pro/Flash 已支持 1M 上下文。

**问题 D: Token gap 解析不支持 OpenAI 格式**

`parsePromptTooLongTokenCounts()` 只识别 Anthropic 格式 `"137500 tokens > 135000"`，不识别 OpenAI 格式 `"maximum context length is XXXX tokens. However, your messages resulted in XXXX tokens"`。

### 修复内容

#### 修复 1: `[1m]` 后缀在所有 API 路径中自动剥离

Anthropic 原生路径已有 `normalizeModelStringForAPI()`（`model.ts:645`），在发送给 API 前剥离 `[1m]`/`[2m]` 后缀。但 OpenAI 和 Responses 兼容路径未调用此函数。

**修复方式**: 在 `openaiCompat.ts:139` 和 `responsesCompat.ts:159` 添加与 `normalizeModelStringForAPI()` 相同的正则：
```typescript
const targetModel = rawModel.replace(/\[(1|2)m\]/gi, '')
```

三条 API 路径现在都会剥离 `[1m]`：
- **Anthropic 路径**: `claude.ts:1738` 调用 `normalizeModelStringForAPI()`
- **OpenAI 路径**: `openaiCompat.ts:139` 内联正则
- **Responses 路径**: `responsesCompat.ts:159` 内联正则

#### 修复 2: OpenAI 格式上下文溢出错误映射

**文件**: `src/services/api/openaiCompat.ts:271-295`, `src/services/api/responsesCompat.ts:271-295`

在 HTTP 错误处理中增加对上下文溢出错误的识别，匹配以下模式：
- `context_length_exceeded`（OpenAI/DeepSeek error code）
- `context length`（通用描述）
- `maximum context`（OpenAI 消息）
- `too many tokens`（部分 provider）
- `token limit`（部分 provider）

匹配后抛出 `"Prompt is too long: ..."` 格式错误，与上游 PTL 检测链路完全兼容。

#### 修复 3: PTL 检测安全网

**文件**: `src/services/api/errors.ts:563-570`

在 PTL 错误检测中增加额外模式匹配作为安全网，即使错误通过其他路径也能被识别。

#### 修复 4: Token gap 解析扩展

**文件**: `src/services/api/errors.ts:88-130`

`parsePromptTooLongTokenCounts()` 新增 OpenAI 格式解析：
- Anthropic: `"prompt is too long: 137500 tokens > 135000 maximum"`
- OpenAI: `"maximum context length is 65536 tokens. However, your messages resulted in 70000 tokens"`
- 通用: `"XXXXX tokens ... maximum ... XXXXX tokens"`

#### 修复 5: DeepSeek 上下文窗口更新

**文件**: `src/utils/context.ts:96`

从 `102_400` 更新为 `1_000_000`，反映 DeepSeek V4 Pro/Flash 的实际上下文能力。

### 修复后的完整流程

```
1. 用户设置 ANTHROPIC_MODEL="deepseek-v4-pro[1m]"
   → getContextWindowForModel() 检测 [1m] → 返回 1,000,000
   → API 路径剥离 [1m] → 发给 API 的是 "deepseek-v4-pro"
   （Anthropic 路径: normalizeModelStringForAPI()）
   （OpenAI 路径: rawModel.replace(/\[(1|2)m\]/gi, '')）

2. 上下文增长到 ~967k tokens
   → tokenCountWithEstimation() 计算 token 数
   → shouldAutoCompact() 判断 >= threshold → 触发压缩

3. 如果 API 返回上下文溢出错误
   → openaiCompat.ts / responsesCompat.ts 检测 context_length_exceeded
   → 抛出 "Prompt is too long: ..." 格式错误
   → errors.ts 识别为 PTL → 触发 reactive compact / PTL 重试
   → truncateHeadForPTLRetry() 截断最旧消息组
   → 重试直到成功
```

### 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src/utils/context.ts` | DeepSeek 上下文窗口 102.4k → 1M |
| `src/services/api/openaiCompat.ts` | `[1m]` 剥离 + PTL 错误映射 |
| `src/services/api/responsesCompat.ts` | `[1m]` 剥离 + PTL 错误映射 |
| `src/services/api/errors.ts` | PTL 检测安全网 + OpenAI 格式 token gap 解析 |
| `CLAUDE.md` | 文档更新（DeepSeek 1M + Ch21） |
| `debug_updates_2.md` | Ch21 修复日志 + Ch20 交叉引用 |

---

## Chapter 22: 持久化配置覆盖启动环境变量导致 [1m] 后缀丢失

### 修复日期

2026-05-08

### 问题描述

启动脚本中设置了 `$env:ANTHROPIC_MODEL = "deepseek-v4-pro[1m]"`，但 doge-code 启动后模型显示为 `deepseek-v4-pro`（不带 `[1m]`），且 `process.env.ANTHROPIC_MODEL` 实际值也为 `deepseek-v4-pro`。

### 根本原因

**文件**: `src/utils/managedEnv.ts` `applyPersistedCustomApiEndpointEnv()` 第 218-219 行

```typescript
if (customApiEndpoint?.model) {
    process.env.ANTHROPIC_MODEL = customApiEndpoint.model  // 无条件覆盖！
}
```

启动流程：

```
1. 用户脚本: $env:ANTHROPIC_MODEL = "deepseek-v4-pro[1m]"  ✅
2. doge 启动 → main()
3. applyConfigEnvironmentVariables()
   → applyPersistedCustomApiEndpointEnv()
   → customApiStorage.model = "deepseek-v4-pro"  (上次保存的旧值)
   → process.env.ANTHROPIC_MODEL = "deepseek-v4-pro"  ❌ 覆盖！
4. getUserSpecifiedModelSetting()
   → 读到 process.env.ANTHROPIC_MODEL = "deepseek-v4-pro"  ❌ [1m]丢失
```

`customApiEndpoint` 的值来自两个来源的合并：
```typescript
const customApiEndpoint = {
    ...(getGlobalConfig().customApiEndpoint ?? {}),  // settings.json
    ...readCustomApiStorage(),                        // 安全存储（优先级更高）
}
```

用户之前使用过 `deepseek-v4-pro`（不带 `[1m]`），该值被持久化到了 `customApiStorage` 或 `settings.json`。每次启动时，`applyPersistedCustomApiEndpointEnv()` 无条件用旧值覆盖环境变量，导致用户显式设置的 `[1m]` 后缀丢失。

### 解决方法

添加 `!process.env.ANTHROPIC_MODEL` 守卫——仅当环境变量未被用户显式设置时才应用持久化值：

```typescript
// 修改前：无条件覆盖
if (customApiEndpoint?.model) {
    process.env.ANTHROPIC_MODEL = customApiEndpoint.model
}

// 修改后：环境变量 > 持久化配置
if (customApiEndpoint?.model && !process.env.ANTHROPIC_MODEL) {
    process.env.ANTHROPIC_MODEL = customApiEndpoint.model
}
```

### 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `src/utils/managedEnv.ts` | `applyPersistedCustomApiEndpointEnv()` 添加 env var 守卫 |

### 影响范围

- 所有通过 `ANTHROPIC_MODEL` 环境变量设置模型名（含 `[1m]` 后缀）的用户
- 之前通过 `/model` 命令或 settings 持久化了不带 `[1m]` 后缀的模型名时，该值会覆盖 env var

---

---

## Chapter 23: 模型切换机制完整修复 — ModelProfile + 适配器优先级

### 修复日期

2026-05-08

### 问题描述

`/model` 切换模型时存在严重 bug：
1. 用 `start_*.ps1` 启动后，`/model` 切换失效，API 实际使用的仍是启动脚本设置的旧模型
2. `/add-model` 只存模型名，不存 provider / baseURL / apiKey / contextWindow / 子Agent 等配置
3. 无法通过直接 `doge` 启动 + `/model` 在多模型间切换，必须借助不同的 `start_*.ps1`
4. 不同模型使用不同环境变量（A 模型 8 个，B 模型 14 个），切换后环境变量交叉残留
5. `/remove-model` 删除当前模型时只改模型名，不加载 fallback 模型的完整配置

### 根本原因

**Bug 1 — 适配器重新读取 env var 覆盖已解析模型**（`openaiCompat.ts:136`, `responsesCompat.ts:156`）

```typescript
// 适配器无视上层已解析的 input.model，重新读 process.env
const configuredModel = process.env.ANTHROPIC_MODEL?.trim()
const rawModel = configuredModel || input.model  // env var 永远优先！
```

上层模型解析链（`getMainLoopModelOverride()` → `/model` 设置的 bootstrap state）已正确解析模型名并传入为 `input.model`，但适配器重新读了 `process.env.ANTHROPIC_MODEL`。由于 `/model` 不更新这个 env var，适配器永远用旧值。

**Bug 2 — `/model` 不更新 `process.env`**（`model.tsx:199`）

`setModel()` 只调用 `setAppState()` 更新 React 状态，从不更新 `process.env.ANTHROPIC_MODEL`。只有 `/add-model` 会更新 env var。

**Bug 3 — `/add-model` 只保存模型名**

```typescript
writeCustomApiStorage({ ...secureStored, model: nextModel, savedModels: [...] })
// 没有保存 provider, baseURL, apiKey, contextWindow, 子Agent 等
```

**Bug 4 — `start_*.ps1` 设置空字符串导致 Auth 冲突**

```powershell
$env:ANTHROPIC_AUTH_TOKEN = "sk-..."   # 有值
$env:DOGE_API_KEY = ""                 # 空字符串 ≠ 不存在！
```

`auth.ts` 检测到两个 env var 都存在 → 报 Auth 冲突。部分脚本缺少 `Remove-Item Env:\ANTHROPIC_AUTH_TOKEN`。

**Bug 5 — `captureModelProfile` 丢弃 `anthropic` provider**

```typescript
provider: provider === 'openai' || provider === 'responses' ? provider : undefined
// 'anthropic' 被丢弃为 undefined → 切换时 ?? 退回旧值
```

**Bug 6 — `/add-model` 写入顺序导致 modelProfiles 丢失**

```
secureStored = readCustomApiStorage()  // 快照 modelProfiles = [{A}]
saveModelProfile(profile)              // 写入 [{A}, {B}]
writeCustomApiStorage({...secureStored}) // 用旧快照覆盖! → [{A}]
```

**Bug 7 — `/model` 切到无 profile 模型时 3P 凭证泄漏**

从 DeepSeek 切到 `sonnet` 时，`CLAUDE_CODE_COMPATIBLE_API_PROVIDER` / `DOGE_API_KEY` 等不清理，请求发到 DeepSeek API。

**Bug 8 — `applyModelProfile` 无 key 时不清理旧 key**

```typescript
if (profile.apiKey) { ... }  // 没有 else → 旧 key 不清理!
```

**Bug 9 — Storage 顶层 `??` 运算符保留旧值**

```typescript
provider: profile.provider ?? current.provider  // undefined 时保留旧 provider
```

重启后 `managedEnv.ts` 从 storage 恢复旧 provider → 跨 session 泄漏。

**Bug 10 — `/remove-model` 无最后模型保护 + fallback 不加载完整配置**

最后一个模型可删除导致 `savedModels: []`；删除当前模型时只改 `ANTHROPIC_MODEL`，不加载 fallback 的完整 profile，且 storage 顶层保留旧 provider/apiKey。

### 修复方案

#### 修复 1：适配器信任 resolved model

`openaiCompat.ts` 和 `responsesCompat.ts` 移除 `process.env.ANTHROPIC_MODEL` 重读，直接使用 `input.model`。

#### 修复 2：ModelProfile 完整类型（`customApiStorage.ts`）

```typescript
export type ModelProfile = {
  model: string
  provider?: 'anthropic' | 'openai' | 'responses'
  baseURL?: string
  apiKey?: string
  authTokenType?: 'DOGE_API_KEY' | 'ANTHROPIC_AUTH_TOKEN'
  contextWindow?: number
  defaultOpusModel?: string
  defaultSonnetModel?: string
  defaultHaikuModel?: string
  subagentModel?: string
  opusCapabilities?: string
  sonnetCapabilities?: string
  disableNonessentialTraffic?: boolean
  disableNonstreamingFallback?: boolean
  effortLevel?: string
}
```

新增辅助函数：
- `captureModelProfile(modelName)` — 从当前 `process.env` 快照全部 14 个 env var
- `getModelProfile(modelName)` — 按模型名精确查找 profile
- `saveModelProfile(profile)` — 保存到 `modelProfiles[]`，同名覆盖
- `applyModelProfile(profile)` — 应用到 `process.env` 全部 env var + 持久化到 storage

`applyEnvVar` 辅助函数：有值则设，无值（`undefined`）则 `delete`，保证不同数量 env var 切换无残留。

#### 修复 3：`/add-model` 捕获完整配置

- `captureModelProfile` 快照全部 14 个 env var 生成 profile
- `saveModelProfile` 保存到 `modelProfiles[]`
- 同时更新 storage 顶层 `provider/baseURL/apiKey` 用于直接 `doge` 启动的 auth bypass
- 修复 `freshStored` 重新读取避免覆盖 `saveModelProfile` 的结果

#### 修复 4：`/model` 应用完整配置

- `setModel()` 和 `handleSelect()` 调用 `getModelProfile()` 查找 profile
- 有 profile → `applyModelProfile()` 设置全部 14 个 env var + 更新 storage
- 无 profile → 只设 model name + 清除 3P 凭证防止泄漏

#### 修复 5：API 路由 env var 优先（`claude.ts`）

```typescript
// provider: env var 优先于 persisted storage
const envCompatProvider = process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
const compatProvider = envCompatProvider
  ? getGlobalCompatProvider()
  : (customApiStorage.provider ?? getGlobalCompatProvider())
// apiKey: 支持 ANTHROPIC_AUTH_TOKEN
const apiKey = process.env.DOGE_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || customApiStorage.apiKey || ''
// baseURL: env var 优先
const baseURL = process.env.ANTHROPIC_BASE_URL || customApiStorage.baseURL || ''
```

#### 修复 6：`managedEnv.ts` Ch22 守卫补全

```typescript
// apiKey 只在两个互斥 env var 都不存在时才恢复
if (customApiEndpoint?.apiKey && !process.env.DOGE_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  process.env.DOGE_API_KEY = customApiEndpoint.apiKey
}
```

#### 修复 7：`start_*.ps1` ×11 空字符串清理

- 3 个脚本（deepseek, opus_month, glm01）已有 `Remove-Item` 双清理 → 移除冗余的 `=""` 赋值
- 8 个脚本缺少 `ANTHROPIC_AUTH_TOKEN` 的 `Remove-Item` → 补全 + 移除 `=""` 赋值

#### 修复 8：`/remove-model` 完整 fallback

- 新增最后模型保护（`savedModels.length <= 1` → 拒绝删除）
- 删除当前模型时调用 `applyModelProfile(fallbackProfile)` 全量加载
- 无 fallback profile 时清除所有 3P 凭证
- 修复 storage 顶层残留旧 provider/apiKey 的问题

#### 修复 9：`modelSupportOverrides.ts` [1m] 后缀剥离（Ch18 补丁同步）

```typescript
const m = model.toLowerCase().replace(/\[.*?\]$/, '')  // 剥离 [1m]/[2m]
```

### 修改文件（19 个源文件 + 11 个脚本）

| 文件 | 修改内容 |
|------|---------|
| `src/services/api/openaiCompat.ts` | 移除 env var 重读，信任 `input.model` |
| `src/services/api/responsesCompat.ts` | 同上 |
| `src/services/api/claude.ts` | env var 优先 provider/apiKey/baseURL；支持 `ANTHROPIC_AUTH_TOKEN` |
| `src/utils/customApiStorage.ts` | ModelProfile 类型 + 5 个辅助函数 |
| `src/commands/add-model/add-model.ts` | `captureModelProfile` + `freshStored` 修复 |
| `src/commands/model/model.tsx` | `applyModelProfile` 全量切换 + 无 profile 清除 3P 凭证 |
| `src/commands/remove-model/remove-model.ts` | 最后模型保护 + fallback 全量加载 + storage 清理 |
| `src/utils/managedEnv.ts` | env var 守卫 + `ANTHROPIC_AUTH_TOKEN` 互斥 |
| `src/utils/model/modelSupportOverrides.ts` | `[1m]` 后缀剥离 |
| `src/utils/statusNoticeDefinitions.tsx` | 修复 auth conflict 假警告（见 Ch24） |
| `start_*.ps1` ×11 | 移除空字符串赋值 + 补全 `ANTHROPIC_AUTH_TOKEN` 清理 |

### 使用方式

```
# 第一次：保存 DeepSeek 完整配置
start_deepseek.ps1 → doge → /add-model deepseek-v4-pro[1m] → 退出

# 第二次：保存 GLM 完整配置
start_glm01.ps1 → doge → /add-model glm-5.1 → 退出

# 之后直接启动，任意切换
doge → /model deepseek-v4-pro[1m]   # 切换到 DeepSeek（全套配置）
doge → /model glm-5.1               # 切换到 GLM（全套配置）
```

### 影响范围

- 所有使用 `/add-model` + `/model` 工作流的用户
- 所有 `start_*.ps1` 启动在会话中切换模型的用户
- 直接 `doge` 启动并通过 `/model` 切换模型的用户

---

## Chapter 24: Auth Conflict 假警告修复

### 修复日期

2026-05-08

### 问题描述

使用 `start_glm01.ps1`（设置 `ANTHROPIC_AUTH_TOKEN`）启动后，即使 `DOGE_API_KEY` 已被正确删除，仍显示：

```
⚠Auth conflict: Both a token (ANTHROPIC_AUTH_TOKEN) and an API key (DOGE_API_KEY) are set.
```

### 根本原因

`statusNoticeDefinitions.tsx` 的 `bothAuthMethodsNotice.isActive` 检查 `getAnthropicApiKeyWithSource()` 的返回值。该函数不仅读 `process.env.DOGE_API_KEY`，还从 `customApiStorage.apiKey`（持久化存储）读取：

```typescript
// auth.ts:261
const effectiveApiKeyEnv = apiKeyEnv || persistedCustomApiKey
```

上次 `/add-model`（如 DeepSeek）的 key 残留在 storage 中 → `getAnthropicApiKeyWithSource()` 返回 `source: 'DOGE_API_KEY'`。同时 `getAuthTokenSource()` 看到 `ANTHROPIC_AUTH_TOKEN` → `source: 'ANTHROPIC_AUTH_TOKEN'`。两者都不为 `'none'` → 假冲突警告。

### 修复方案

`statusNoticeDefinitions.tsx:109` — 增加 `!!process.env.DOGE_API_KEY` 条件：

```typescript
// Before:
return apiKeySource !== 'none' && authTokenInfo.source !== 'none' && ...

// After:
return apiKeySource !== 'none' && authTokenInfo.source !== 'none'
    && !!process.env.DOGE_API_KEY  // 只有 env var 显式存在才报警
    && ...
```

storage 中残留的 key 不再触发假冲突。只有当 `DOGE_API_KEY` 确确实实在 `process.env` 中存在时，才认为是真正的冲突。

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/utils/statusNoticeDefinitions.tsx` | `isActive` 增加 `!!process.env.DOGE_API_KEY` |

### 影响范围

- 所有使用 `ANTHROPIC_AUTH_TOKEN` 启动且 storage 中有残留 apiKey 的用户

---

## 修改时间日志

- Computer Use Windows mouse_move 修复（Ch11）：2026-04-26
- Computer Use Windows 应用发现与启动修复（Ch12）：2026-04-26
- Computer Use 跨语言应用名匹配修复（Ch13）：2026-04-26
- Computer Use Windows DPI 缩放与坐标修复（Ch14）：2026-04-26
- Electron/CEF 应用鼠标点击修复（Ch15）：2026-04-26
- Windows 截图缩放与坐标精度修复（Ch16）：2026-04-26
- PowerShell 可变结构体陷阱修复（Ch17）：2026-05-01
- DeepSeek Max Effort 支持修复（Ch18）：2026-05-06
- Claude-to-IM 集成修复（Ch19）：2026-05-06
- 1M 超长上下文处理机制修复（Ch20）：2026-05-06
- 第三方 API 上下文溢出修复（Ch21）：2026-05-08
- 持久化配置覆盖启动环境变量修复（Ch22）：2026-05-08
- 文档拆分整理（Ch11-Ch19 合并重写）：2026-05-07
- 模型切换机制完整修复（Ch23）：2026-05-08
- Auth Conflict 假警告修复（Ch24）：2026-05-08
- 模型配置存储一致性修复（Ch25）：2026-05-09

---

## Chapter 25: 模型配置存储一致性修复 — credentials.json 交叉污染与泄露

### 问题描述

**发现日期**：2026-05-09
**严重程度**：严重（credentials.json 模型配置存储错误）
**影响范围**：所有使用 `/model` 切换无Profile模型、`/remove-model` 删除模型的用户

系统维护了两个独立的存储文件：
- `~/.doge/.credentials.json`（`readCustomApiStorage/writeCustomApiStorage`）
- `~/.doge/.config.json` 或 `.claude.json`（`getGlobalConfig/saveGlobalConfig`）

两者都存储 `customApiEndpoint`（provider、baseURL、apiKey、model、savedModels）但更新不一致，导致 7 个 Bug。

### Bug 1 [严重]: /model 无Profile时旧凭证残留在 .credentials.json

**文件**: `src/commands/model/model.tsx`
- 第 59-75 行 `ModelPickerWrapper.handleSelect()`
- 第 229-246 行 `SetModelAndClose.setModel()`

两个路径在切换到无Profile模型时，清理了env变量但写入 `writeCustomApiStorage({ ...current, model })` 保留了上一个模型的 provider、baseURL、apiKey。重启后 `managedEnv.ts` 重新应用这些过时凭证。

**修复**：删除 `ANTHROPIC_BASE_URL` 和 `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` 从 env，并将 `provider: undefined, baseURL: undefined, apiKey: undefined` 写入 storage（JSON序列化时省略 undefined，等效于删除key）。

### Bug 2 [严重]: /remove-model applyModelProfile 跳过写操作

**文件**: `src/commands/remove-model/remove-model.ts` 第 56-63 行

`applyModelProfile` 只写 model/provider/baseURL/apiKey，不写 savedModels/modelProfiles。注释"skip our own write"是错的。修复：`applyModelProfile` 后重新读storage并合并清理后的 savedModels/modelProfiles。

### Bug 3 [高]: /remove-model 读错误数据源

**文件**: `src/commands/remove-model/remove-model.ts` 第 14-15、25 行

守护条件和模型存在检查从 `getGlobalConfig().customApiEndpoint`（`.claude.json`）读取，而非从 `readCustomApiStorage()`（`.credentials.json`）。修复：合并两个来源的 savedModels。

### Bug 4 [高]: authTokenType 重启后丢失

**文件**: `src/utils/customApiStorage.ts` 第 248 行 + `src/utils/managedEnv.ts` 第 220 行

`applyModelProfile` 只存 apiKey，不存 authTokenType。重启后 `managedEnv.ts` 无条件写 `DOGE_API_KEY`。修复：`CustomApiStorageData` 增加 `authTokenType` 字段，`managedEnv.ts` 按类型分发。

### Bug 5 [中]: 7 个代码路径直接读过期 .claude.json

`modelOptions.ts`、`agent.ts`、`validateModel.ts` 等直接读 `getGlobalConfig().customApiEndpoint`，绕过了 `.credentials.json`。

### Bug 6 [中]: isFastModeAvailable 不一致

**文件**: `model.tsx` — 交互式选择器有检查（第 94 行），内联模式缺了（第 264 行）。修复：添加。

### Bug 7 [低→修复]: 模型名大小写敏感 + [1m] 后缀不匹配

**文件**: `src/utils/customApiStorage.ts` 第 119 行

导出 `normalizeModelName()` 函数：lowercase + trim + 去除 `[1m]` 后缀。修复 Profile 查找、savedModels 去重。

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/commands/model/model.tsx` | Bug#1: no-profile路径清除全部env + 写入undefined到storage；Bug#6: isFastModeAvailable |
| `src/commands/remove-model/remove-model.ts` | Bug#2: applyModelProfile后重新读写；Bug#3: 合并两来源savedModels + normalizeModelName |
| `src/utils/customApiStorage.ts` | Bug#4: CustomApiStorageData增加authTokenType；Bug#7: 导出normalizeModelName含[1m]剥离 |
| `src/utils/managedEnv.ts` | Bug#4: applyPersistedCustomApiEndpointEnv按authTokenType分发到正确env变量 |
| `src/commands/add-model/add-model.ts` | Bug#7: savedModels用normalizeModelName去重 |

### 影响范围

- 场景1: start_.ps1 + doge 启动 → managedEnv.ts 守卫正确阻止持久化值覆盖启动env（验证通过）
- 场景2: /add-model 添加模型 → captured 16字段 + authTokenType + 去重（验证通过）
- 场景3: /model 切换模型 → 别名跳过OAuth，有Profile全量切换，无Profile彻底清除旧凭证（验证通过）
- 场景4: /remove-model 最后一模型保护 + 合并来源 + 大小写不敏感（验证通过）
- 场景5: /model 正常切换 → handleSelect与setModel路径完全一致（验证通过）
- 场景6: 模型配置隔离 → Profiles独立，modelProfiles在所有写入路径中正确保留（验证通过）
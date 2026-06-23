# Windows 剪贴板图片粘贴修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 Windows（及 Linux）上 Ctrl+V 在 TUI 中粘贴剪贴板位图的能力，并让"剪贴板有图"的聚焦提示在 Windows 上触发，macOS 行为保持不变。

**Architecture:** 放宽两处空-paste 探测分支的 `isMacOS` 守卫，使 win32/linux 也能在空 bracketed paste 后调用 `getImageFromClipboard`（其 win32 PowerShell 读取实现已就绪）；把 `hasImageInClipboard` 从 darwin-only 早返回改为按平台分流，非 darwin 复用 `getClipboardCommands().commands.checkImage` 探测，与 `getImageFromClipboard` 同源。

**Tech Stack:** TypeScript ESM / React Ink hooks / Bun 1.3.11 运行时 / execa 子进程调用 / PowerShell `Get-Clipboard` / xclip·wl-paste / osascript / `image-processor-napi`。无新增依赖、无新增文件、无新增类型。

参考 spec：`docs/superpowers/specs/2026-06-23-windows-clipboard-image-paste-design.md`

---

## 文件结构

本计划修改 2 个既有文件，不创建新文件：

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/hooks/usePasteHandler.ts` | 粘贴事件分发：累积 chunks、检测图片路径、探测空 paste 剪贴板图。| 放开 `:181` 与 `:245` 两处 `isMacOS` 守卫；`:166` 的 `isTempScreenshot && isMacOS` 保留 |
| `src/utils/imagePaste.ts` | 剪贴板图读/写命令表 + `hasImageInClipboard`/`getImageFromClipboard`/`tryReadImageFromPath`。| `hasImageInClipboard` 去掉 darwin-only 早返回，非 darwin 复用 `checkImage` 探测 |

无新增测试文件：项目对这两个 hook 无既有单元测试基建（属上游 source-map 重建），验证以静态验证 + 手动验证为主（见各任务 Step）。引入新测试框架超出最小集，YAGNI。

---

### Task 1: 放开 `resetPasteTimeout` 内空 paste 探测守卫

**Files:**
- Modify: `src/hooks/usePasteHandler.ts:181-184`

本任务修改的是"粘贴完成回退分支"。当前 `:181` 在累积 chunks 合并后、`pastedText` 为空时，仅当 `isMacOS` 才探测剪贴板图。去掉该守卫使 win32/linux 也能触发。

- [ ] **Step 1: 阅读现状确认符号**

打开 `src/hooks/usePasteHandler.ts`，确认 `:181` 当前为：

```ts
            // If paste is empty (common when trying to paste images with Cmd+V),
            // check if clipboard has an image (macOS only)
            if (isMacOS && onImagePaste && pastedText.length === 0) {
              checkClipboardForImage()
              return { chunks: [], timeoutId: null }
            }
```

确认 `checkClipboardForImage`、`onImagePaste`、`pastedText` 均在此 `setPasteState` 回调作用域内可见（它们是回调参数/闭包变量）。`isMacOS` 在本分支改后不再被引用，但仍在 `:166` 的 `else if (isTempScreenshot && isMacOS)` 被引用——**不要删除 `isMacOS` 计算行（`:55`）**。

- [ ] **Step 2: 应用精确编辑**

用 Edit 工具将 `:181` 的 `if (isMacOS && onImagePaste && pastedText.length === 0) {` 改为去掉 `isMacOS`：

old_string:
```
            // If paste is empty (common when trying to paste images with Cmd+V),
            // check if clipboard has an image (macOS only)
            if (isMacOS && onImagePaste && pastedText.length === 0) {
```
new_string:
```
            // If paste is empty (common when trying to paste an image registered
            // only in the clipboard, e.g. Win+Shift+S / Snipping Tool / copy),
            // check if clipboard has an image. Cross-platform: darwin fast path
            // (native NSPasteboard / osascript) and win32/linux checkImage are
            // both no-ops when the clipboard has no image.
            if (onImagePaste && pastedText.length === 0) {
```

- [ ] **Step 3: 静态验证守卫已去除**

用 Grep 搜索 `usePasteHandler.ts` 内容确认 `:181` 区域不再含 `isMacOS`：

```
pattern: "isMacOS && onImagePaste && pastedText"
path: src/hooks/usePasteHandler.ts
```
Expected: 不再有匹配（即守卫已去掉）。同时 Grep `"isMacOS"` 应仍命中 `:55`（计算行）和 `:166`（保留的临时截图回退），证明未被误删。

- [ ] **Step 4: 类型与语法快查**

运行：
```
bunx tsc --noEmit -p tsconfig.json 2>&1 | head -40
```
Expected: 无与 `usePasteHandler.ts` 相关的新错误。（项目可能存在既有上游报错——只关注本次改动未引入新报错即可。若 `tsc` 不可用，改用 `bun run dev:restore-check` 跑一次退出，或跳过本步，依赖后续手动验证。）

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePasteHandler.ts
git commit -m "$(cat <<'EOF'
fix(paste): 放开 resetPasteTimeout 空 paste 探测守卫以支持 win32/linux

去掉 :181 守卫中的 isMacOS 守卫，使 Windows/Linux 上
剪贴板位图（Win+Shift+S / Snipping Tool / 复制图片）
经空 bracketed paste 后能触发 getImageFromClipboard。
isMacOS 计算与 :166 临时截图回退保留不变。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 放开 `wrappedOnInput` 即时空 paste 探测守卫

**Files:**
- Modify: `src/hooks/usePasteHandler.ts:245-250`

本任务修改的是"即时空 paste 分支"。当前 `:245` 在 `event.keypress.isPasted === true && input.length === 0` 时仅当 `isMacOS` 才即时探测剪贴板图。去掉该守卫使 win32 也能命中（主路径，命中率最高）。

- [ ] **Step 1: 阅读现状确认符号**

确认 `src/hooks/usePasteHandler.ts:245` 当前为：

```ts
    if (isFromPaste && input.length === 0 && isMacOS && onImagePaste) {
      checkClipboardForImage()
      // Reset isPasting since there's no text content to process
      setIsPasting(false)
      return
    }
```

确认 `isFromPaste`、`input`、`onImagePaste`、`checkClipboardForImage`、`setIsPasting` 均在 `wrappedOnInput` 作用域可见。

- [ ] **Step 2: 应用精确编辑**

old_string:
```
    // Handle empty paste (clipboard image on macOS)
    // When the user pastes an image with Cmd+V, the terminal sends an empty
    // bracketed paste sequence. The keypress parser emits this as isPasted=true
    // with empty input.
    if (isFromPaste && input.length === 0 && isMacOS && onImagePaste) {
```
new_string:
```
    // Handle empty paste (clipboard image only, no text).
    // When the user pastes an image, the terminal sends an empty bracketed
    // paste sequence. The keypress parser emits this as isPasted=true with
    // empty input. Cross-platform: win32 (Get-Clipboard -Format Image) and
    // linux (xclip/wl-paste) checkImage are no-ops when there's no image.
    if (isFromPaste && input.length === 0 && onImagePaste) {
```

- [ ] **Step 3: 静态验证守卫已去除**

Grep:
```
pattern: "input.length === 0 && isMacOS && onImagePaste"
path: src/hooks/usePasteHandler.ts
```
Expected: 不再有匹配。Grep `"isMacOS"` 应仍命中 `:55` 与 `:166`（行号可能因 Task 1/2 注释变长而微移，以内容匹配为准）。

- [ ] **Step 4: 确认 isMacOS 计算行与依赖数组仍保留**

Grep:
```
pattern: "const isMacOS = React.useMemo"
path: src/hooks/usePasteHandler.ts
```
Expected: 命中 1 处（`:55` 附近）。
Grep:
```
pattern: "isMacOS, onImagePaste, onPaste"
path: src/hooks/usePasteHandler.ts
```
Expected: 命中 1 处（`resetPasteTimeout` 依赖数组，`:205` 附近）——这两处保留，因为 `:166` 仍引用 `isMacOS`。若误删将导致 `:166` 的 `isMacOS` 未定义编译错误。

- [ ] **Step 5: 类型与语法快查**

```
bunx tsc --noEmit -p tsconfig.json 2>&1 | head -40
```
Expected: 无与 `usePasteHandler.ts` 相关新错误（`isMacOS` 仍被 `:166` 使用，无"未使用变量"问题）。

- [ ] **Step 6: Commit**

```bash
git add src/hooks/usePasteHandler.ts
git commit -m "$(cat <<'EOF'
fix(paste): 放开 wrappedOnInput 即时空 paste 探测守卫

去掉 :245 即时分支的 isMacOS 守卫，使 Windows/Linux
上剪贴板位图经空 bracketed paste（主路径）即触发
getImageFromClipboard，命中率最高的入口被打通。
isMacOS 与 :166 临时截图回退保留不变。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 扩展 `hasImageInClipboard` 支持非 darwin 平台

**Files:**
- Modify: `src/utils/imagePaste.ts:96-122`

本任务把"剪贴板是否有图"的探测从 darwin-only 改为全平台，使 `useClipboardImageHint` 的聚焦提示在 Windows 上也能出现。darwin 走原生 fast path（现状不变），非 darwin 复用 `getClipboardCommands().commands.checkImage`（与 `getImageFromClipboard` 同源）。

- [ ] **Step 1: 阅读现状确认符号与 import**

确认 `src/utils/imagePaste.ts:96-122` 当前为：

```ts
export async function hasImageInClipboard(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false
  }
  if (
    feature('NATIVE_CLIPBOARD_IMAGE') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_collage_kaleidoscope', true)
  ) {
    // ... 原生 fast path（含 try/catch logError 与 fall through 注释）...
  }
  const result = await execFileNoThrowWithCwd('osascript', [
    '-e',
    'the clipboard as «class PNGf»',
  ])
  return result.code === 0
}
```

确认 `imagePaste.ts` 已 import `execa`（`imagePaste.ts:3`）、已定义 `getClipboardCommands`（`imagePaste.ts:31`，`function` 声明，作用域内可见）。`execFileNoThrowWithCwd` 也已 import（`:13`）。

- [ ] **Step 2: 应用精确编辑**

把 darwin-only 早返回改为 darwin 分支，并在末尾追加非 darwin 的 checkImage 探测。

old_string（从函数开头到 osascript 返回的整段，需精确包含早返回与 fast path）:
```
export async function hasImageInClipboard(): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false
  }
  if (
```
new_string:
```
export async function hasImageInClipboard(): Promise<boolean> {
  // darwin: 原生 NSPasteboard fast path（~0.03ms warm），gate 失败时落到 osascript。
  // 非 darwin：复用 getClipboardCommands().checkImage（与 getImageFromClipboard 同源），
  // 命中已安装的剪贴板工具（win32 PowerShell、linux xclip/wl-paste）；无图时 exitCode≠0
  // 干净返回 false，不把文本剪贴板误判为图。
  if (process.platform === 'darwin') {
  if (
```

注意：`new_string` 把 `return false` 的早返回换成 darwin 分支的开括号，函数体其余（fast path 代码 + osascript 返回）**保持原缩进不动**。这要求 Step 3 用第二个 Edit 闭合 darwin 分支并追加非 darwin 块。

- [ ] **Step 3: 闭合 darwin 分支并追加非 darwin 探测**

old_string（osascript 返回原样 + 函数结束的 end brace）:
```
  const result = await execFileNoThrowWithCwd('osascript', [
    '-e',
    'the clipboard as «class PNGf»',
  ])
  return result.code === 0
}
```
new_string:
```
  const result = await execFileNoThrowWithCwd('osascript', [
    '-e',
    'the clipboard as «class PNGf»',
  ])
  return result.code === 0
  }

  // win32 / linux：与 getImageFromClipboard 同源 checkImage 命令探测。
  // PowerShell `Get-Clipboard -Format Image -ne $null` / xclip·wl-paste | grep image/...
  // 无图时退出码非零 → 干脆返回 false。
  const { commands } = getClipboardCommands()
  const result = await execa(commands.checkImage, {
    shell: true,
    reject: false,
  })
  return result.exitCode === 0
}
```

注意 `return result.code === 0` 与新增的 `}` 之间——`result.code` 是 darwin 的 `execFileNoThrowWithCwd` 返回；非 darwin 用 `execa` 返回的 `result.exitCode`。函数末尾只有一个 `}` 闭合函数体（不再闭合 darwin 分支，因为 darwin 分支在 osascript return 后已用新增 `}` 闭合）。两段 Edit 配合后，源码结构为：

```
export async function hasImageInClipboard(): Promise<boolean> {
  // 注释...
  if (process.platform === 'darwin') {
    if (...fast path gate...) {
      try { ... } catch { ... }
    }
    const result = await execFileNoThrowWithCwd('osascript', [...])
    return result.code === 0
  }

  const { commands } = getClipboardCommands()
  const result = await execa(commands.checkImage, { shell: true, reject: false })
  return result.exitCode === 0
}
```

- [ ] **Step 4: Read 确认最终结构正确**

用 Read 工具读 `src/utils/imagePaste.ts:96-130`，确认：
1. 函数顶部无 `if (process.platform !== 'darwin') return false`。
2. darwin 分支 `{` 在 `if (process.platform === 'darwin') {` 后，osascript return 后有闭合 `}`。
3. 非 darwin 段用 `execa(commands.checkImage, ...)` + `return result.exitCode === 0`。
4. 函数末尾只有一个 `}`。
5. 注释 `// macos fast path 保持现状不动...` 等非权威描述已用权威代码块结构替代（无残留描述性 TODO）。

Expected: 结构与 Step 3 末尾示意一致。

- [ ] **Step 5: 类型与语法快查**

```
bunx tsc --noEmit -p tsconfig.json 2>&1 | head -40
```
Expected: 无与 `imagePaste.ts` 相关新错误。`hasImageInClipboard` 签名仍为 `Promise<boolean>`，调用方 `src/hooks/useClipboardImageHint.ts` 无需改。

- [ ] **Step 6: 确认调用方无需改**

Grep:
```
pattern: "hasImageInClipboard"
path: src/hooks/useClipboardImageHint.ts
```
Expected: 命中 import（`:4`）与调用（`:54` 附近 `await hasImageInClipboard()`）各 1 处，签名未变，无需改动。

- [ ] **Step 7: Commit**

```bash
git add src/utils/imagePaste.ts
git commit -m "$(cat <<'EOF'
fix(clipboard): hasImageInClipboard 支持非 darwin 平台

去掉 darwin-only 早返回，改为 darwin 分支（原生 fast path /
osascript 保持现状），非 darwin 复用 getClipboardCommands()
.checkImage 探测。使 useClipboardImageHint 的"剪贴板有图"
聚焦提示在 Windows/Linux 上也能触发，与 getImageFromClipboard
同源无重复命令。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 手动验证矩阵（Windows 11 本机）

**Files:** 无文件改动，仅验证。

本任务在 Windows 上跑一次 dev 验证全链路。本机 Windows 11 + Bun 1.3.11 / Node 24.15.0。

- [ ] **Step 1: 启动 dev 模式**

```
bun run dev
```
Expected: doge CLI TUI 正常进入，无启动 ERR（`~/.doge/.claude.json` 已 `hasCompletedOnboarding: true`）。

- [ ] **Step 2: Win+Shift+S 截图 → Ctrl+V 粘贴**

操作：Win+Shift+S 截一块屏 → 切回 doge TUI 输入框 → Ctrl+V。
Expected: 输入框出现 `[Image #N]` 占位符，可继续编辑/回车发送，图片随消息发出。

- [ ] **Step 3: 画图/Snipping Tool 复制位图 → Ctrl+V**

操作：画图或 Snipping Tool 复制一张图 → doge TUI 内 Ctrl+V。
Expected: 同 Step 2，`[Image #N]` 出现。
（这同时验证 BMP→PNG 转换路径，因部分 Windows 终端以 BMP 复制。）

- [ ] **Step 4: 复制文本 → Ctrl+V 不误读为图**

操作：选中任意文本 Ctrl+C → doge TUI Ctrl+V。
Expected: 文本正常作为输入文本粘贴，**不出现** `[Image #N]`，不被误读为图、不触发 PowerShell 读取剪贴板图（checkImage 探测返回 exitCode≠0 → null）。

- [ ] **Step 5: 空剪贴板 Ctrl+V 无报错**

操作：剪贴板清空（复制一个空文件名或用 `Set-Clipboard -Value $null`）→ doge TUI Ctrl+V。
Expected: 静默无操作，控制台无报错、无未捕获 rejection。

- [ ] **Step 6: 失焦再聚焦剪贴板有图 → 出现提示**

操作：剪贴板放一张图（Win+Shift+S）→ Alt+Tab 切到其它窗口 → Alt+Tab 切回 doge 终端（触发聚焦转换）。
Expected: 1000ms 内出现 "Image in clipboard · ctrl+v to paste" 提示（若 30s 内已提示过则受 `HINT_COOLDOWN_MS` 冷却跳过——可复制一张新图后再试）。

- [ ] **Step 7: 拖拽 png 文件回归**

操作：把一个 .png 文件从资源管理器拖到 doge 终端窗口。
Expected: 走文件路径分支（`tryReadImageFromPath`），`[Image #N]` 出现，行为与修复前一致（回归未破坏）。

- [ ] **Step 8: 记录结果**

在回复里列出每个 Step 实际结果。若任一 Step 不符 Expected，**不要标记完成**，回到对应 Task 修正后重验。

- [ ] **Step 9: 收尾 Commit（如有调试残留）**

若手动验证期间为方便调试临时改了任何文件，恢复后：
```bash
git status
git add -A
git commit -m "chore: windows clipboard image paste manual verification cleanup"
```
若无残留则跳过本步。

---

## Self-Review

**1. Spec 覆盖**：
- 范围 A（Bug 1 + Bug 2）→ Task 1/2（Bug 1 两处守卫）+ Task 3（Bug 2）。
- 空 paste 探测策略 A → Task 1/2 直接去掉守卫，不引新分支。
- Windows 提示探测方案 B（复用 checkImage）→ Task 3。
- 守卫口径 A（`:166` 保留）→ Task 1 Step 3 / Task 2 Step 3-4 显式校验 `isMacOS` 在 `:166` 仍引用、计算行未删。
- 不动 `getImageFromClipboard`/`tryReadImageFromPath`/解析层/PromptInput → 无对应 Task，符合范围。
- Bug 3/Bug 4 不修 → 无对应 Task，符合范围。
- 数据流与错误处理（无图静默退出、可回退）→ Task 4 验证矩阵覆盖。
- 测试策略（静态验证 + 手动矩阵、不引入测试框架）→ Task 4 + 各 Task Step。
- 覆盖完整，无 gap。

**2. 占位符扫描**：无 TBD/TODO/"appropriate error handling"/"similar to Task N"。每步含确切代码或确切命令。

**3. 类型一致性**：
- `hasImageInClipboard` 签名 `Promise<boolean>` 全程不变（Task 3 Step 6 校验调用方）。
- darwin 分支用 `execFileNoThrowWithCwd` 返回 `result.code`；非 darwin 用 `execa` 返回 `result.exitCode`——两个 API 返回字段不同，已在 Step 3 代码中区分，无混用。
- `usePasteHandler.ts` 的 `checkClipboardForImage`、`onImagePaste`、`pastedText`、`isFromPaste`、`input`、`setIsPasting`、`isMacOS`、`isTempScreenshot` 均为既有符号，无新造名。
无不一致。
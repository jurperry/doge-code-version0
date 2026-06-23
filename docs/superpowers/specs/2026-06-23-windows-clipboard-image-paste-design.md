# Windows 剪贴板图片粘贴修复设计

日期：2026-06-23
状态：待实现

## 背景与问题

Doge Code（Claude Code 的多提供商 fork）在终端 TUI 中粘贴图片有多条入口路径，最终都汇入 `PromptInput.onImagePaste`，把图片存为 `PastedContent`（type: `'image'`）并在输入光标处插入 `[Image #N]` 占位符。

粘贴图片的运作机制：

1. **按键解析**（`src/ink/parse-keypress.ts`）：终端开启 bracketed paste 模式（DEC 2004）后，粘贴内容被 `\x1b[200~` … `\x1b[201~` 包裹。tokenizer（`src/ink/termio/tokenize.ts`）识别 `PASTE_START`/`PASTE_END`（`csi.ts:277/280`）。`parseMultipleKeypresses` 进入 `IN_PASTE` 模式累积内容，遇到 `PASTE_END` 调用 `createPasteKey(pasteBuffer)`（`parse-keypress.ts:240`）——即使 pasteBuffer 为空也会发射一个 paste key（设计上为 macOS 剪贴板图片探测保留，见 237-239 行注释）。

2. **粘贴分发**（`src/hooks/usePasteHandler.ts`）：`wrappedOnInput` 用 `event.keypress.isPasted` 判断是否粘贴，累积到 `pasteState.chunks`，启动 100ms 定时器（`PASTE_COMPLETION_TIMEOUT_MS`）。定时器回调 `resetPasteTimeout` 内按 `/ (?=\/|[A-Za-z]:\\)/` + 换行切分文本，筛出图片文件路径，对每个路径调 `tryReadImageFromPath`；命中则 `onImagePaste`。

3. **剪贴板读取**（`src/utils/imagePaste.ts`）：`getImageFromClipboard` 在 macOS 走原生 `image-processor-napi` fast path，否则落到 `getClipboardCommands()` 平台命令。win32 已实现：`checkImage` = `Get-Clipboard -Format Image`，`saveImage` = `$img.Save(tempPath, Png)`，读临时文件做 BMP→PNG 转换和 resize（`imagePaste.ts:72-78`、211-218）。

### 发现的 Bug（本次修复范围 A）

**Bug 1（核心）：Windows/Linux 上 Ctrl+V 粘贴剪贴板位图完全失效。**

两处空 paste → 读剪贴板图片的分支都硬编码 `isMacOS` 守卫：

- `usePasteHandler.ts:181`：`if (isMacOS && onImagePaste && pastedText.length === 0) { checkClipboardForImage() }`
- `usePasteHandler.ts:245`：`if (isFromPaste && input.length === 0 && isMacOS && onImagePaste) { ... }`

`isMacOS = getPlatform() === 'macos'`（`usePasteHandler.ts:55`），win32 上 `getPlatform()` 返回 `'windows'`（`platform.ts:17-19`），恒为 `false`。Windows 用户用 Win+Shift+S 截图、或在画图/Snipping Tool 复制图片后按 Ctrl+V，终端发出空 bracketed paste，但因守卫排除非 macOS，`checkClipboardForImage()` 永不被调用，图片被无声丢弃。win32 的 PowerShell 读取实现已就绪却无调用点触达。

**Bug 2（同范围）：`hasImageInClipboard` 在非 macOS 直接返回 false。**

`imagePaste.ts:97`：`if (process.platform !== 'darwin') return false`。`useClipboardImageHint`（切回终端时若剪贴板有图则提示 "Image in clipboard · ctrl+v to paste"）在 Windows 上永无提示，引导链断裂。

**不在本次范围**：

- Bug 3（次要）：`isPasting` UI 竞态——分支 1（`:245`）在 debounce 执行前就 `setIsPasting(false)`，与 `.finally()` 复位的时间窗不一致。仅 UI 指示灯瞬时不一致，不丢数据。
- Bug 4（次要）：Windows 多文件拖拽路径切分（`usePasteHandler.ts:127`/`237`）属上游逻辑，非本 fork 引入。

## 修复目标与范围

打通 Windows（及 Linux）上 Ctrl+V 粘贴剪贴板位图的能力，并让"剪贴板有图"的聚焦提示在 Windows 上也能触发。不改 macOS 现有行为，不动 Bug 3/4。

## 设计决策

经澄清确认的关键决策：

1. **范围 A**：仅修核心断裂（Bug 1 + Bug 2），不修 isPasting 竞态、不修路径切分。
2. **空 paste 探测策略 A**：一刀切去掉 `isMacOS` 守卫。三平台 checkImage 命令均能"无图时干净退出 null"，不误把文本剪贴板读为图，无新分支。
3. **Windows 提示探测**：复用 `getClipboardCommands().commands.checkImage`（方案 B），消除"check 命令写两份"，与 `getImageFromClipboard` 检查同源。darwin 仍优先原生 fast path。
4. **守卫口径 A**：精准放开 `:181` 与 `:245` 两处；`:166` 的 `isTempScreenshot && isMacOS`（macOS 临时截图回退）原样保留，`isMacOS` 计算（`:55`）与 hook 依赖（`:205`）不动。

## 改动明细

### 改动 1：`src/hooks/usePasteHandler.ts`

`:181` 去掉 `isMacOS` 守卫：

```ts
// 改前
if (isMacOS && onImagePaste && pastedText.length === 0) {
  checkClipboardForImage()
  return { chunks: [], timeoutId: null }
}
// 改后
if (onImagePaste && pastedText.length === 0) {
  checkClipboardForImage()
  return { chunks: [], timeoutId: null }
}
```

`:245` 去掉 `isMacOS` 守卫：

```ts
// 改前
if (isFromPaste && input.length === 0 && isMacOS && onImagePaste) {
  checkClipboardForImage()
  setIsPasting(false)
  return
}
// 改后
if (isFromPaste && input.length === 0 && onImagePaste) {
  checkClipboardForImage()
  setIsPasting(false)
  return
}
```

`:166` 的 `else if (isTempScreenshot && isMacOS)` 原样保留（macOS 临时截图文件回退，与 win32 无关）。`isMacOS` 计算行（`:55`）与 `resetPasteTimeout` 依赖数组（`:205`）保留——`:166` 闭包仍引用 `isMacOS`。

### 改动 2：`src/utils/imagePaste.ts` — `hasImageInClipboard()`

去掉 `:97` 的 `if (process.platform !== 'darwin') return false` 早返回。darwin 仍优先走原生 `image-processor-napi` fast path（现状不变）。非 darwin 落到 `getClipboardCommands().commands.checkImage` 探测，与 `getImageFromClipboard` 同源：

```ts
export async function hasImageInClipboard(): Promise<boolean> {
  // macOS fast path 保持现状不动（image-processor-napi gate + osascript 回退）
  if (process.platform === 'darwin') {
    if (
      feature('NATIVE_CLIPBOARD_IMAGE') &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_collage_kaleidoscope', true)
    ) {
      try {
        const { getNativeModule } = await import('image-processor-napi')
        const hasImage = getNativeModule()?.hasClipboardImage
        if (hasImage) {
          return hasImage()
        }
      } catch (e) {
        logError(e as Error)
      }
    }
    const result = await execFileNoThrowWithCwd('osascript', [
      '-e',
      'the clipboard as «class PNGf»',
    ])
    return result.code === 0
  }

  // win32 / linux：复用 checkImage 命令探测，与 getImageFromClipboard 同源
  const { commands } = getClipboardCommands()
  const result = await execa(commands.checkImage, { shell: true, reject: false })
  return result.exitCode === 0
}
```

`execa` 与 `getClipboardCommands` 均已在文件内引入/定义，作用域内可用。函数签名（返回 `Promise<boolean>`）不变，调用方 `useClipboardImageHint.ts:54` 无需改动。

**不改动**：`getImageFromClipboard`、`tryReadImageFromPath`、`getClipboardCommands` 的命令表、解析层、`PromptInput`、所有 win32 PowerShell saveImage 路径（已就绪）。

## 数据流与触发条件

空 paste → 剪贴板图片的两条路径（修改后均在 Windows/Linux 生效），前提为终端开启 bracketed paste：

1. **即时空 paste 分支**（`wrappedOnInput`，`:245`）：条件 `event.keypress.isPasted === true && input.length === 0 && onImagePaste` → `checkClipboardForImage()`（50ms debounce）→ `getImageFromClipboard()` → 命中则 `onImagePaste(base64, mediaType, undefined, dimensions)`，无图静默退出。主路径。
2. **粘贴完成回退分支**（`resetPasteTimeout`，`:181`）：条件 `pastedText.length === 0 && onImagePaste`（含 `[I`/`[O` 孤立焦点序列剥离后为空）→ 同上 `checkClipboardForImage()`。兜底，覆盖空 paste 的 `PASTE_END` 与下一按键被 stdin 同批送达、`isFromPaste` 在第二次 input 时已为 false 的情形。

剪贴板图片提示路径（修改后 Windows 生效）：`useClipboardImageHint` 在终端失焦→聚焦转换时经 1000ms debounce 调 `hasImageInClipboard()`；win32 走 `Get-Clipboard -Format Image` 探测，命中且距上次提示 > 30s（`HINT_COOLDOWN_MS`）则发即时提示。

## 边界、竞态与错误处理

**Windows 终端差异**：Windows Terminal / Wezterm / modern conhost 开启 bracketed paste 时会发空 `200~201~` 序列命中分支 1/2；老旧 conhost 或未启用 bracketed paste 的终端不发任何字符，空 paste 路径不触发——属"终端能力缺失"，不在本次范围。本次只保证"能发空 paste 的终端 + 已实现 win32 读取"组合可用，无新回退引入，不退化现有行为。

**与拖拽文件路径互斥**：`resetPasteTimeout` 内先检测 `imagePaths`（`:130`），命中文件读取则不进入 `:181` 空 paste 分支。拖拽图片文件（有路径文本）与粘贴剪贴板位图（空文本）天然互斥。

**isPasting 竞态**：已知、不在本次范围。不提前关 `setIsPasting` 会改 macOS 现有行为曲线，超出最小集。

**错误处理**：`getImageFromClipboard` win32 路径已用 `execa(..., {reject:false})` + `exitCode !== 0 → return null`，PowerShell 报错静默返回 null，与 macOS osascript 落空一致。`hasImageInClipboard` 抽出后沿用同构 try/catch（`exitCode !== 0 → false`）。空 paste 探测失败不刷日志。

**可回退性**：3 处改动均为"放宽守卫"性质，可单独还原任一处；不引入新依赖、新文件、新类型。

## 测试与验证策略

项目对这两个 hook 无既有单元测试基建（属上游 source-map 重建），验证以静态验证 + 手动验证为主，不引入新测试框架。

**静态验证**：
- 改动后通读 `usePasteHandler.ts` 与 `imagePaste.ts`，确认 `isMacOS` 在 `:166` 仍被引用、未产生未使用变量告警。
- `hasImageInClipboard` 签名不变（返回 `Promise<boolean>`），调用方无需改。
- 确认 `getClipboardCommands()` 与 `execa` 在 `hasImageInClipboard` 作用域可见。

**手动验证矩阵**（Windows 11）：

| 场景 | 操作 | 预期（修复后） |
|---|---|---|
| Win+Shift+S 截图后 Ctrl+V | 截图进剪贴板 → doge TUI 内 Ctrl+V | 输入框出现 `[Image #N]` 占位，可发送 |
| 画图复制位图后 Ctrl+V | 同上 | 同上 |
| 复制文本后 Ctrl+V | Ctrl+C 文本 → Ctrl+V | 文本正常粘贴，不误读为图 |
| 空剪贴板 Ctrl+V | 无内容 → Ctrl+V | 静默无操作，无报错 |
| 失焦再聚焦，剪贴板有图 | 切走再切回终端 | 出现 "Image in clipboard · ctrl+v to paste" 提示 |
| 拖拽 png 文件到终端 | 拖入 | 走文件路径分支（不变），图片正常进来 |

**回归保证**：macOS 行为零改动——两处守卫去掉后，macOS 原本 `isMacOS===true` 仍满足条件，等价；`hasImageInClipboard` 的 darwin 原生 fast path 仍优先。

**不验证项**：Bug 3 修复、Bug 4 多文件拖拽、老旧 conhost 无 bracketed paste 环境。
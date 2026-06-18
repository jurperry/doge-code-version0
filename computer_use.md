# Computer Use 工具调用流程文档

## 概述

Computer Use 是一套允许 AI 模型直接控制计算机界面的工具集，包括截图、鼠标点击、键盘输入等操作。本文档记录了使用这些工具完成任务的标准流程。

## 对 AI 模型的能力要求

要成功使用 Computer Use 工具，AI 模型需要具备以下能力：

### 1. 多模态视觉能力（最关键）
- **图像识别**：能够"看到"并理解截图中的界面元素（按钮、文字、图标等）
- **空间定位**：准确识别元素在图片中的位置和边界
- **细节识别**：能够识别小元素（如工具栏图标、下拉菜单项）
- **视觉推理**：理解界面布局、层次关系、视觉反馈（如高亮、禁用状态）

### 2. 坐标估算能力
- **像素级定位**：能够估算元素在图片中的像素坐标（x, y）
- **中心点计算**：找到按钮或区域的中心位置（而不是边缘）
- **坐标系理解**：理解图片坐标系统（左上角为原点 (0,0)，向右为 x 轴正方向，向下为 y 轴正方向）

### 3. 工具使用理解
- **工作流程**：理解"截图 → 分析 → 操作 → 验证"的循环
- **工具组合**：知道何时使用 `screenshot`、`click`、`type`、`key` 等工具
- **结果验证**：操作后主动截图验证结果

### 4. 问题诊断能力
- **失败分析**：点击失败时能够分析原因（坐标错误、界面变化、需要等待等）
- **策略调整**：根据失败原因调整策略（使用 `zoom` 查看细节、等待加载、重新定位等）

### 常见失败原因

如果其他模型在使用 Computer Use 时"点不中"，可能是因为：

1. **视觉识别不准确**：
   - 无法准确识别按钮的边界
   - 混淆相似的界面元素
   - 对小元素或低对比度元素识别困难

2. **坐标估算错误**：
   - 点击了元素的边缘而不是中心
   - 坐标计算偏移
   - 不理解图片的坐标系统

3. **工作流程错误**：
   - 不先截图就盲目点击
   - 点击后不验证结果
   - 不理解 `screenshot` 返回的是可视化图片

4. **缺乏适应性**：
   - 界面变化后不重新截图
   - 失败后不调整策略
   - 不使用 `zoom` 查看细节

**建议**：如果你的模型在使用 Computer Use 时遇到困难，重点提升视觉识别能力和空间推理能力，并严格遵循"截图 → 分析 → 操作 → 验证"的工作流程。

## 核心工具列表

### 1. 权限管理
- `mcp__computer-use__request_access` - 请求控制应用程序的权限
- `mcp__computer-use__list_granted_applications` - 列出已授权的应用

### 2. 应用控制
- `mcp__computer-use__open_application` - 打开或切换到指定应用
- `mcp__computer-use__switch_display` - 切换显示器

### 3. 屏幕操作
- `mcp__computer-use__screenshot` - 截取当前屏幕（返回图片和分辨率信息）
- `mcp__computer-use__zoom` - 放大截图的特定区域以查看细节

**重要说明：** `screenshot` 工具返回两部分内容：
1. **文本信息**：屏幕分辨率（如 "Screenshot dimensions: 1389x868 pixels"）
2. **图片本身**：实际的截图图像，AI 模型可以通过视觉能力分析这张图片，识别按钮、文字、界面布局等，从而确定需要点击的坐标位置

### 4. 鼠标操作
- `mcp__computer-use__left_click` - 左键点击
- `mcp__computer-use__right_click` - 右键点击
- `mcp__computer-use__double_click` - 双击
- `mcp__computer-use__triple_click` - 三击
- `mcp__computer-use__mouse_move` - 移动鼠标
- `mcp__computer-use__left_click_drag` - 拖拽操作
- `mcp__computer-use__left_mouse_down` / `left_mouse_up` - 鼠标按下/释放
- `mcp__computer-use__scroll` - 滚动操作
- `mcp__computer-use__cursor_position` - 获取鼠标位置

### 5. 键盘操作
- `mcp__computer-use__type` - 输入文本
- `mcp__computer-use__key` - 按键（支持组合键，如 "cmd+c", "ctrl+v"）
- `mcp__computer-use__hold_key` - 长按按键

### 6. 批量操作
- `mcp__computer-use__computer_batch` - 批量执行多个操作（减少往返次数，提高效率）

### 7. 剪贴板操作
- `mcp__computer-use__read_clipboard` - 读取剪贴板内容
- `mcp__computer-use__write_clipboard` - 写入剪贴板内容

### 8. 其他工具
- `mcp__computer-use__wait` - 等待指定时间（秒）

---

## 截图像素与实际像素的转换机制

这是 Computer Use 能够准确点击的核心技术原理。

### 问题背景

在高 DPI 显示器上（如 200% 缩放），存在三种不同的"分辨率"：

1. **物理分辨率**：屏幕的实际像素数（如 2778×1736）
2. **逻辑分辨率**：操作系统报告的分辨率（如 1389×868，物理分辨率 ÷ 缩放比例）
3. **截图分辨率**：返回给 AI 的图片分辨率（经过优化处理）

### 转换流程

#### 1. 截图时的处理（物理像素 → 截图像素）

```
屏幕物理分辨率（如 2778×1736）
    ↓ [DPI-aware 捕获]
物理像素截图（2778×1736）
    ↓ [预缩放到目标尺寸]
优化后的截图（如 1389×868）
    ↓ [返回给 AI]
AI 看到的图片（1389×868）
```

**关键代码**（`executor.ts:60-68`）：
```typescript
function computeTargetDims(
  logicalW: number,
  logicalH: number,
  scaleFactor: number,
): [number, number] {
  const physW = Math.round(logicalW * scaleFactor)
  const physH = Math.round(logicalH * scaleFactor)
  return targetImageSize(physW, physH, API_RESIZE_PARAMS)
}
```

**预缩放算法**（`imageResize.ts`）：
- 目标：找到最大的图片尺寸，满足：
  1. 保持原始宽高比
  2. 长边 ≤ 1568 像素
  3. Token 数量 ≤ 1568（每 28 像素一个 token）
- 这样可以避免 API 服务器端的二次缩放
- 确保 AI 看到的尺寸与实际使用的坐标系统一致

#### 2. 点击时的处理（截图像素 → 物理像素）

**两种输入方式**（Ch15 修复）：

##### 方式一：SendMessage（首选，用于普通应用）
```
AI 分析截图，确定点击位置（如 [393, 479]，基于窗口截图）
    ↓ [窗口相对坐标]
SendMessage 发送到窗口 HWND
    ↓ [客户区偏移校正]
调整标题栏和边框偏移（Ch14 修复）
    ↓ [WM_LBUTTONDOWN/UP]
在窗口客户区的正确位置点击
```

##### 方式二：SetCursorPos + mouse_event（用于 Chromium 应用和 UIPI 限制场景）
```
AI 分析截图，确定点击位置（如 [393, 479]，基于窗口截图）
    ↓ [获取窗口位置]
GetWindowRect 获取窗口在屏幕上的位置（如左上角在 [100, 200]）
    ↓ [转换为屏幕坐标]
屏幕坐标 = 窗口坐标 + 窗口位置 = [393+100, 479+200] = [493, 679]
    ↓ [DPI-aware 处理]
SetProcessDPIAware() 确保使用物理像素
    ↓ [SetCursorPos + mouse_event]
在屏幕绝对坐标 [493, 679] 处点击
```

**关键代码**（`win32.ts:sendInputClick`）：
```typescript
function sendInputClick(hwnd: number, x: number, y: number, button: string): void {
  ps(`
    [CuWin32]::SetProcessDPIAware() | Out-Null
    $r = New-Object CuClickRect+RECT
    [CuClickRect]::GetWindowRect([IntPtr]${hwnd}, [ref]$r) | Out-Null
    // 窗口坐标 + 窗口位置 = 屏幕坐标
    [CuWin32]::SetCursorPos(${x} + $r.L, ${y} + $r.T) | Out-Null
    // 使用 mouse_event 而不是 SendInput（避免 PowerShell 结构体问题）
    [CuWin32]::mouse_event(${downFlag}, 0, 0, 0, [IntPtr]::Zero)
    [CuWin32]::mouse_event(${upFlag}, 0, 0, 0, [IntPtr]::Zero)
  `)
}
```

**重要说明**：虽然函数名叫 `sendInputClick`，但实际使用的是 `mouse_event` API，而不是 `SendInput` API。这是因为 PowerShell 在处理 `SendInput` 的 `INPUT` 结构体时存在"可变结构体陷阱"（对嵌套结构体字段的赋值会写入副本而不是原始对象），导致 `dwFlags` 等字段无法正确设置。`mouse_event` 使用简单参数，完全避免了这个问题。

**关键机制**：

1. **DPI-aware 模式**：所有 PowerShell 脚本都调用 `SetProcessDPIAware()`
   ```powershell
   Add-Type @'
   using System; using System.Runtime.InteropServices;
   public class CuDpi { 
     [DllImport("user32.dll")] 
     public static extern bool SetProcessDPIAware(); 
   }
   '@
   [CuDpi]::SetProcessDPIAware() | Out-Null
   ```
   - 确保 `GetWindowRect`、`SetCursorPos` 等 API 使用物理像素
   - 与截图的物理像素坐标系统保持一致

2. **Chromium 应用检测**（Ch15 修复）：
   - 自动检测 Electron/CEF/Chrome 应用（通过子窗口类名）
   - Chromium 应用忽略 SendMessage 鼠标事件，必须使用屏幕坐标方式
   - 检测到的类名：`Chrome_RenderWidgetHostHWND`、`Chrome_WidgetWin_*` 等

3. **坐标转换逻辑**：
   - **SendMessage**：使用窗口相对坐标（客户区坐标）
   - **SetCursorPos + mouse_event**：窗口相对坐标 + 窗口屏幕位置 = 屏幕绝对坐标
   - 两种方式都通过 DPI-aware API 自动处理物理像素

4. **scaleFactor = 1**：Windows 实现中，`display.listAll()` 返回的 `scaleFactor` 始终为 1
   - 因为截图已经预缩放到目标尺寸
   - 坐标系统已经统一，不需要额外的缩放转换

5. **客户区偏移校正**（Ch14 修复）：
   - SendMessage 使用客户区坐标，需要减去标题栏和边框的偏移
   - 通过 `ClientToScreen` 和 `GetWindowRect` 计算偏移量
   - 确保点击位置与截图（包含标题栏）的坐标一致

6. **为什么用 mouse_event 而不是 SendInput**：
   - PowerShell 的"可变结构体陷阱"：对嵌套结构体字段赋值会写入副本
   - `SendInput` 需要 `INPUT` 结构体，其中包含嵌套的 `MOUSEINPUT` 结构体
   - `mouse_event` 使用简单参数（dwFlags, dx, dy, dwData, dwExtraInfo），完全避免结构体问题
   - 虽然 MSDN 标记 `mouse_event` 为"已被 SendInput 取代"，但功能完全等价且更适合 PowerShell

### 为什么这样设计可行？

#### 核心原理：坐标空间统一 + DPI-aware API

**问题 1：为什么"预缩放 + DPI-aware API"能保证坐标完全准确？**

答案分为两部分：

##### 1. 预缩放解决了什么问题？

**问题**：AI 分析的图片尺寸 ≠ 实际使用的坐标空间

**场景**：
- AI 收到 2778×1736 的截图
- API 服务器为了节省 token，缩小到 1389×868
- AI 在 2778×1736 的图片上分析，得到坐标 [786, 958]
- 但实际坐标空间是 1389×868
- 结果：点击位置错误（偏移约 2 倍）

**预缩放的解决方案**：
```
截图时就缩放到 1389×868（targetImageSize 算法）
    ↓
API 服务器检测到已经是最优尺寸，不再缩放（early-return）
    ↓
AI 在 1389×868 的图片上分析，得到坐标 [393, 479]
    ↓
实际坐标空间也是 1389×868
    ↓
坐标完全匹配！
```

**关键**：确保 AI 看到的图片尺寸 = 实际使用的坐标空间尺寸

##### 2. DPI-aware API 解决了什么问题？

**问题**：截图坐标空间 ≠ 屏幕物理像素

**场景**（200% DPI 缩放）：
- 截图是 1389×868（逻辑像素）
- 屏幕物理分辨率是 2778×1736（物理像素）
- AI 点击 [393, 479]（基于 1389×868）
- 如果直接使用这个坐标，会点在错误的位置

**DPI-aware API 的解决方案**：

**方式一：SendMessage（窗口相对坐标）**
```
AI 坐标：[393, 479]（基于窗口截图 1389×868）
    ↓
SendMessage 使用窗口相对坐标（逻辑像素）
    ↓
Windows 自动将逻辑像素转换为物理像素
    ↓
在正确的物理位置点击
```

**方式二：SendInput（屏幕绝对坐标）**
```
AI 坐标：[393, 479]（基于窗口截图）
    ↓
GetWindowRect 获取窗口位置（DPI-aware，返回物理像素）
    ↓
窗口位置：[200, 400]（物理像素）
    ↓
屏幕坐标 = [393, 479] + [200, 400] = [593, 879]
    ↓
SetCursorPos([593, 879])（DPI-aware，使用物理像素）
    ↓
在正确的物理位置点击
```

**关键**：`SetProcessDPIAware()` 确保所有 Windows API 使用物理像素

##### 3. 两者结合的完整流程

```
1. 截图阶段：
   物理像素 2778×1736
   → [预缩放] →
   优化尺寸 1389×868
   → [返回给 AI] →
   AI 看到 1389×868

2. 分析阶段：
   AI 在 1389×868 的图片上分析
   → [视觉识别] →
   确定坐标 [393, 479]

3. 点击阶段：
   坐标 [393, 479]（基于 1389×868）
   → [DPI-aware API] →
   自动转换为物理像素或屏幕坐标
   → [Windows API] →
   在正确的物理位置点击
```

**为什么准确？**
1. **预缩放**：确保 AI 分析的图片尺寸 = 坐标空间尺寸（1389×868）
2. **DPI-aware**：确保坐标空间（1389×868）正确映射到物理像素（2778×1736）
3. **坐标一致性**：从截图到点击，始终在同一个坐标系统中工作

#### 避免二次缩放的重要性

如果不预缩放，会发生什么？

```
错误流程：
1. 截图 2778×1736 → 返回给 AI
2. API 服务器缩小到 1389×868（节省 token）
3. AI 在 2778×1736 的图片上分析 → 坐标 [786, 958]
4. 实际坐标空间是 1389×868
5. 点击 [786, 958] → 位置错误（超出范围或偏移）

正确流程（预缩放）：
1. 截图 2778×1736 → 预缩放到 1389×868 → 返回给 AI
2. API 服务器检测到已是最优尺寸 → 不再缩放（early-return）
3. AI 在 1389×868 的图片上分析 → 坐标 [393, 479]
4. 实际坐标空间也是 1389×868
5. 点击 [393, 479] → 位置正确
```

预缩放确保了 API 服务器的 early-return（不再缩放），从而保证坐标一致性。

#### 举例说明

**场景**：200% DPI 缩放的显示器

| 阶段 | 尺寸 | 说明 |
|------|------|------|
| 物理屏幕 | 2778×1736 | 实际像素数 |
| 截图捕获 | 2778×1736 | DPI-aware 捕获物理像素 |
| 预缩放 | 1389×868 | 优化到目标尺寸（约 50%） |
| AI 分析 | 1389×868 | AI 在这个尺寸的图片上工作 |
| AI 点击 | [393, 479] | 基于 1389×868 的坐标 |
| 底层映射 | [786, 958] | DPI-aware API 自动转换到物理像素 |
| 实际点击 | [786, 958] | 在物理屏幕上的正确位置 |

**关键点**：
- AI 始终在 1389×868 的坐标空间中工作
- 底层自动处理到物理像素的转换
- 坐标系统从头到尾保持一致

### 常见误解

❌ **错误理解**：AI 需要知道物理分辨率并手动计算缩放比例
✅ **正确理解**：AI 只需要在截图的坐标空间中工作，底层自动处理转换

❌ **错误理解**：`screenshot` 返回的 "1389×868" 只是文本信息
✅ **正确理解**：这是实际图片的尺寸，也是 AI 应该使用的坐标空间

❌ **错误理解**：高 DPI 显示器上坐标会不准确
✅ **正确理解**：通过预缩放 + DPI-aware API，坐标完全准确

### 技术细节

**Ch16 修复**（来自 `CLAUDE.md`）：
> screenshot pre-scaled to `targetImageSize` output (Ch16 fix — prevents API server-side resize and coordinate mismatch on high-DPI displays)

**为什么需要这个修复**：
- 早期版本：截图 → API 服务器缩放 → AI 分析缩放后的图片 → 坐标不匹配
- Ch16 修复：截图 → 预缩放 → API 服务器不再缩放 → AI 分析的图片 = 坐标空间 → 完全准确

---

## 标准工作流程

### 实例：打开网易云音乐并播放音乐

以下是完整的操作流程示例。

#### 第一步：请求权限

**在执行任何 Computer Use 操作之前，必须先请求权限。**

```xml
<invoke name="mcp__computer-use__request_access">
  <parameter name="apps">["网易云音乐"]</parameter>
  <parameter name="reason">打开网易云音乐并点击播放按钮播放音乐</parameter>
</invoke>
```

**返回结果：**
```json
{
  "granted": [{
    "bundleId": "E:\\LenovoSoftstore\\Install\\wangyiyunyinyue\\cloudmusic.exe",
    "displayName": "网易云音乐",
    "grantedAt": 1777640073046
  }],
  "denied": [],
  "screenshotFiltering": "none"
}
```

**关键点：**
- `apps` 参数是一个数组，可以同时请求多个应用的权限
- `reason` 参数用于向用户说明为什么需要这些权限
- 返回结果中的 `granted` 数组包含了成功授权的应用信息
- 如果应用未安装或用户拒绝，会出现在 `denied` 数组中

---

#### 第二步：截图查看当前状态

在打开应用之前，先截图查看当前桌面状态。

```xml
<invoke name="mcp__computer-use__screenshot">
</invoke>
```

**返回结果：**
```
Screenshot dimensions: 1389x868 pixels. 
All mouse/click coordinates must be within this pixel space (0–1389, 0–868).
```

**关键点：**
- 截图会返回屏幕的分辨率信息（文本）
- 同时返回实际的截图图片（AI 模型可以通过视觉能力"看到"）
- AI 通过分析图片内容，识别界面元素的位置，从而确定点击坐标
- 所有后续的鼠标坐标必须在这个分辨率范围内

**工作原理：**
1. `screenshot` 工具捕获屏幕并返回图片
2. AI 模型（如 Claude）作为多模态模型，可以"看到"这张图片
3. AI 分析图片中的按钮、文字、界面布局等视觉元素
4. AI 估算目标元素的像素坐标（如按钮中心位置）
5. 使用这些坐标执行点击操作

**示例：** 如果 AI 在截图中看到一个按钮位于屏幕中间偏左的位置，通过视觉判断它的坐标大约是 (393, 479)，那么 AI 就会使用 `left_click` 工具点击这个坐标。

---

#### 第三步：打开应用

使用 `open_application` 打开或切换到目标应用。

```xml
<invoke name="mcp__computer-use__open_application">
  <parameter name="app">网易云音乐</parameter>
</invoke>
```

**返回结果：**
```
Opened "网易云音乐".
```

**关键点：**
- 应用名称必须与 `request_access` 中请求的名称一致
- 如果应用已经打开，会切换到该应用
- 如果应用未打开，会启动该应用

---

#### 第四步：再次截图查看应用界面

应用打开后，需要截图查看界面，以便找到需要点击的元素。

```xml
<invoke name="mcp__computer-use__screenshot">
</invoke>
```

此时可以看到网易云音乐的主界面，包括：
- 左侧导航菜单（推荐、精选、播客等）
- 中间的推荐内容和歌单
- 顶部的搜索栏和用户信息

---

#### 第五步：点击目标元素

根据截图中看到的界面，点击推荐歌单进入播放界面。

```xml
<invoke name="mcp__computer-use__left_click">
  <parameter name="coordinate">[393, 479]</parameter>
</invoke>
```

**关键点：**
- `coordinate` 参数是一个包含 x 和 y 坐标的数组
- 坐标是基于截图的像素位置
- 坐标原点 (0, 0) 在屏幕左上角

---

#### 第六步：确认结果

点击后再次截图，确认操作是否成功。

```xml
<invoke name="mcp__computer-use__screenshot">
</invoke>
```

此时可以看到：
- 底部出现了播放控制栏
- 显示当前播放的歌曲信息
- 播放按钮显示为暂停图标（||），说明音乐正在播放

---

## 高级技巧

### 1. 使用批量操作提高效率

当需要执行一系列连续操作时，可以使用 `computer_batch` 一次性执行多个操作。

```xml
<invoke name="mcp__computer-use__computer_batch">
  <parameter name="actions">[
    {"action": "left_click", "coordinate": [100, 200]},
    {"action": "type", "text": "hello world"},
    {"action": "key", "text": "Return"}
  ]</parameter>
</invoke>
```

**优势：**
- 减少网络往返次数
- 提高执行速度
- 适合可预测的操作序列

---

### 2. 使用 zoom 查看细节

当截图中的文字或按钮太小看不清时，可以使用 `zoom` 放大特定区域。

```xml
<invoke name="mcp__computer-use__zoom">
  <parameter name="region">[100, 100, 500, 300]</parameter>
</invoke>
```

**参数说明：**
- `region` 是一个包含 4 个值的数组：[x0, y0, x1, y1]
- (x0, y0) 是矩形的左上角坐标
- (x1, y1) 是矩形的右下角坐标

---

### 3. 键盘组合键

使用 `key` 工具可以发送键盘组合键。

```xml
<!-- 复制 -->
<invoke name="mcp__computer-use__key">
  <parameter name="text">ctrl+c</parameter>
</invoke>

<!-- 粘贴 -->
<invoke name="mcp__computer-use__key">
  <parameter name="text">ctrl+v</parameter>
</invoke>

<!-- 保存 -->
<invoke name="mcp__computer-use__key">
  <parameter name="text">ctrl+s</parameter>
</invoke>
```

**支持的修饰键：**
- Windows: `ctrl`, `alt`, `shift`, `win`
- macOS: `cmd`, `ctrl`, `alt`, `shift`

---

### 4. 滚动操作

使用 `scroll` 可以在指定位置滚动页面。

```xml
<invoke name="mcp__computer-use__scroll">
  <parameter name="coordinate">[694, 400]</parameter>
  <parameter name="scroll_direction">down</parameter>
  <parameter name="scroll_amount">5</parameter>
</invoke>
```

**参数说明：**
- `coordinate`: 滚动的中心位置
- `scroll_direction`: 滚动方向（up, down, left, right）
- `scroll_amount`: 滚动量（正整数）

---

### 5. 拖拽操作

使用 `left_click_drag` 可以实现拖拽功能。

```xml
<invoke name="mcp__computer-use__left_click_drag">
  <parameter name="start_coordinate">[100, 100]</parameter>
  <parameter name="coordinate">[300, 300]</parameter>
</invoke>
```

**应用场景：**
- 移动窗口
- 选择文本
- 拖动滑块
- 移动文件

---

## 最佳实践

### 1. 始终先截图

在执行任何点击或输入操作之前，先截图查看当前界面状态。这样可以：
- 确认应用是否正确打开
- 找到需要点击的元素位置
- 避免盲目操作导致错误

### 2. 验证操作结果

每次重要操作后，都应该截图验证结果：
- 确认点击是否成功
- 检查是否出现错误提示
- 确认界面是否按预期变化

### 3. 使用合适的工具

- 简单点击：使用 `left_click`
- 连续操作：使用 `computer_batch`
- 查看细节：使用 `zoom`
- 文本输入：使用 `type`
- 快捷键：使用 `key`

### 4. 处理等待时间

某些操作（如打开应用、加载页面）需要时间，可以使用 `wait` 工具等待。

```xml
<invoke name="mcp__computer-use__wait">
  <parameter name="duration">2</parameter>
</invoke>
```

### 5. 错误处理

如果操作失败，应该：
1. 截图查看当前状态
2. 分析失败原因
3. 调整策略重试
4. 必要时请求用户帮助

---

## 常见问题

### Q1: 坐标不准确怎么办？

**解决方案：**
- 使用 `zoom` 放大目标区域，更精确地确定坐标
- 多次截图确认元素位置
- 考虑使用更大的点击目标（如按钮中心而非边缘）

### Q2: 应用打开失败？

**可能原因：**
- 应用未安装
- 应用名称不正确
- 权限未授予

**解决方案：**
- 检查 `request_access` 的返回结果
- 确认应用名称与系统中的名称一致
- 使用应用的完整路径或 bundle ID

### Q3: 点击没有反应？

**可能原因：**
- 坐标超出屏幕范围
- 点击位置不正确
- 应用未响应
- 需要等待加载

**解决方案：**
- 截图确认坐标是否正确
- 使用 `wait` 等待界面加载
- 尝试点击更明显的目标区域

### Q4: 如何处理弹窗？

**解决方案：**
1. 截图识别弹窗内容
2. 找到"确定"或"关闭"按钮的位置
3. 点击按钮关闭弹窗
4. 继续后续操作

---

## 总结

Computer Use 工具的核心流程：

1. **请求权限** → `request_access`
2. **截图观察** → `screenshot`
3. **打开应用** → `open_application`
4. **再次截图** → `screenshot`
5. **执行操作** → `left_click` / `type` / `key` 等
6. **验证结果** → `screenshot`

记住：**截图是关键**。在每个重要步骤前后都要截图，确保操作的准确性和可追溯性。

---

## 附录：完整示例代码

```xml
<!-- 1. 请求权限 -->
<invoke name="mcp__computer-use__request_access">
  <parameter name="apps">["网易云音乐"]</parameter>
  <parameter name="reason">打开网易云音乐并点击播放按钮播放音乐</parameter>
</invoke>

<!-- 2. 初始截图 -->
<invoke name="mcp__computer-use__screenshot">
</invoke>

<!-- 3. 打开应用 -->
<invoke name="mcp__computer-use__open_application">
  <parameter name="app">网易云音乐</parameter>
</invoke>

<!-- 4. 查看应用界面 -->
<invoke name="mcp__computer-use__screenshot">
</invoke>

<!-- 5. 点击推荐歌单 -->
<invoke name="mcp__computer-use__left_click">
  <parameter name="coordinate">[393, 479]</parameter>
</invoke>

<!-- 6. 确认播放状态 -->
<invoke name="mcp__computer-use__screenshot">
</invoke>
```

这个流程展示了如何使用 Computer Use 工具完成一个完整的任务。其他任务可以参考这个模式进行调整。

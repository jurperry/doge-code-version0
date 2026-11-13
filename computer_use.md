# Computer Use：功能、调用流程与设计结构

Computer Use 是 Doge Code 内置的一组 MCP 工具，允许模型在用户授权的范围内查看屏幕，并通过鼠标、键盘、剪贴板和应用控制完成桌面任务。

它不是“保证点击一定有效”的黑盒，而是一套带有**授权、坐标映射、错误反馈、部分执行报告、取消和实机验证**的桌面自动化系统。模型必须按 `截图 → 观察 → 操作 → 验证` 的循环工作。

测试与全量回归规定见 [test_specification.md](test_specification.md)。

## 一、能力总览

在支持的 macOS/Windows 会话中，CLI 当前向模型暴露 24 个工具。

| 类别 | 工具 | 用途 |
|------|------|------|
| 授权 | `request_access` | 请求控制应用、读取/写入剪贴板、使用系统组合键 |
| 授权 | `list_granted_applications` | 查询本会话已授权应用及 grant flags |
| 屏幕 | `screenshot` | 获取当前目标显示器或绑定窗口的 JPEG 图像及尺寸 |
| 屏幕 | `zoom` | 放大上一张截图的指定区域，不改变后续点击的坐标基准 |
| 应用 | `open_application` | 启动、绑定或前置已授权应用 |
| 应用 | `switch_display` | 退出窗口绑定，选择全屏与全局输入；固定或恢复自动显示器选择 |
| 鼠标 | `left_click` / `right_click` / `middle_click` | 单击指定位置 |
| 鼠标 | `double_click` / `triple_click` | 连续双击/三击 |
| 鼠标 | `mouse_move` | 移动指针 |
| 鼠标 | `left_click_drag` | 拖拽 |
| 鼠标 | `left_mouse_down` / `left_mouse_up` | 分解按下与释放；释放与按下使用同一输入通道 |
| 鼠标 | `scroll` | 四向滚动 |
| 鼠标 | `cursor_position` | 实时读取真实光标；绑定窗口时返回窗口局部坐标 |
| 键盘 | `type` | 输入连续文本、中文、emoji、换行和 Tab |
| 键盘 | `key` | 单键和组合键，支持 repeat |
| 键盘 | `hold_key` | 按住组合键一段时间后释放 |
| 剪贴板 | `read_clipboard` / `write_clipboard` | 读取或写入文本剪贴板 |
| 批次 | `computer_batch` | 一次调用顺序执行多个动作并返回逐项结果 |
| 等待 | `wait` | 有界等待界面变化 |

Teach 模式工具存在于共享包中，但当前 CLI 默认不启用。

## 二、标准使用流程

### 1. 先申请权限

```json
{
  "apps": ["记事本"],
  "reason": "在记事本中输入并保存一段文字",
  "clipboardWrite": true,
  "systemKeyCombos": false
}
```

模型必须先调用 `request_access`。授权只在本会话内有效，后续可追加应用，已有授权不会因后续未提及而被撤销。

返回结果可能包含：

- `granted`：已授权应用及 tier；
- `denied` / `policyDenied` / `userDenied`：未安装、策略拒绝或用户拒绝；
- `tierGuidance`：read/click/full 分别允许什么；
- `userConsented` 与拒绝后的处理建议；
- `screenshotFiltering`：平台是否支持原生按应用过滤截图。

**用户拒绝后不要反复弹同一个授权框。** 应换用非 Computer Use 方法，或请用户自行完成。默认 headless 不注册 Computer Use；显式启用 `DOGE_HEADLESS_BUILTIN_MCP` 后，如果流程需要交互授权但没有权限 UI，会返回 `feature_unavailable`，不会伪装成空授权成功。Auto/bypass 模式仍按自动授权规则处理。

Auto/bypass 模式会按既有自动放行设计授予已解析应用及请求 flag；macOS 的 TCC 权限检查仍然保留。

### 2. 打开或绑定应用，再截图

`open_application` 只能打开已授权应用，优先匹配 allowlist 中的 exe 路径/bundleId（Windows 路径统一斜杠与大小写），再按显示名匹配。Windows 会记录该授权对应的 HWND、PID 和应用身份，普通后台输入与真实前台输入都可据此路由。

便携式 exe 启动时使用其所在目录作为工作目录，与从开始菜单或快捷方式启动一致，避免程序找不到同目录资源。通用 PowerShell 输出统一为 UTF-8，中文 exe 路径与窗口标题不会在授权比对前变成乱码；进程名匹配也保留 Unicode。窗口绿色边框仅为装饰，DWM 设置或清理失败不会否决打开、换绑或后续输入。

同一授权请求中的多个名称或别名若解析到同一 bundleId，只进入一次授权弹窗并返回一项 grant，避免重复授权项。`Get-StartApps` 中真实存在的 exe 直接保留原路径，只有 UWP/Store AppID 使用 `shell:AppsFolder` 启动；应用枚举合并时，运行中进程的真实 exe 路径也优先于 shell 启动别名，确保后续可以用该确切路径授权和打开便携应用。进程路径通过 `QueryFullProcessImageName` 获取，MainModule 不可读时不再只剩进程名；完整路径及其已知别名精确匹配优先于显示名宽松匹配，避免注册表 GUID 抢占真实 exe 授权。本地确实存在的完整 exe 即使尚未注册或运行也可授权，但仍需用户同意，且保留元数据或完整路径所对应的受限 tier，不因改成 exe 身份而升级为 full。静态安装项可短期缓存，运行中窗口每次请求重新读取，避免启动时旧缓存长期影响授权。

随后调用 `screenshot`：

- 返回实际 JPEG 图像；
- 返回图像宽高、原始显示宽高、显示器 ID 和虚拟桌面原点；
- 后续鼠标坐标默认以这张图片为准。

如果目标窗口已绑定，截图优先来自该窗口，而不是整块显示器。需要整个桌面时，调用 `switch_display("auto")` 退出窗口绑定；需要指定显示器时，向 `switch_display` 传入显示器名称。切换后旧截图坐标失效，必须重新截图。

### 3. 操作并验证

使用点击、输入、滚动或批次后，**必须再次截图验证**。

当前成功文案使用 `Click dispatched`、`Text input dispatched` 等表述，含义是“输入已派发，应用效果尚未验证”，不再把注入成功等同于业务成功。

### 4. 失败恢复

先读错误，不要盲目重复有副作用的动作：

- 权限不足：调整应用或 grant，不要绕过 tier；
- 坐标陈旧或不确定：重新截图或 zoom；
- 窗口死亡：重新 `open_application` 并截图；
- 前台切换失败：查看当前屏幕或请用户恢复窗口；
- 部分执行：读取已完成位置，检查界面后只补必要步骤；
- 超时：结果未知，不要重放整个批次。

## 三、权限与安全模型

### 应用 tier

| tier | 可见/截图与纯定位 | 普通左键、滚动 | 键盘、右键、中键、修饰点击、拖放 |
|------|-------------------|----------------|----------------------------------|
| `read` | 允许 | 禁止 | 禁止 |
| `click` | 允许 | 允许 | 禁止 |
| `full` | 允许 | 允许 | 允许 |

- 未按住按钮的纯 `mouse_move` 属于定位，read tier 也可使用；按住按钮后的移动会按更高权限动作处理。
- 浏览器等敏感只读应用使用 `read`，应优先使用 Claude-in-Chrome 等专用接口。
- 终端和 IDE 通常使用 `click`，防止把普通点击扩展成终端文本注入。
- Windows 的坐标 hit-test 当前跳过，拖放门禁与 macOS 不完全相同，不能把所有拖放简单理解为 full-only；应以实际工具返回的 tier 错误为准。
- Windows 不再因为 `screenshotFiltering=none` 而跳过有效目标与 tier；绑定应用和未绑定全局输入都要检查。
- 系统组合键另需 `systemKeyCombos`，剪贴板读写另需各自 flag。
- 后台 AgentTool 子代理不能直接使用 Computer Use，必须回到主会话。

### 窗口身份

Windows 不会只凭窗口标题授予权限：

- 候选窗口必须匹配目标进程；
- 输入前检查 HWND 当前 PID；
- SendMessage 和 PrintWindow 前再次检查 expected PID；
- HWND 被复用时，旧授权不再自动有效；
- 目标窗口被替换时，只有同进程的新窗口才可重绑。

### 前台与真实输入

需要全局真实输入时，脚本会恢复并验证目标窗口前台，实际注入前再次检查。多击和拖拽过程中也会检查前台变化，防止输入落入其他应用。Windows 的授权与前台身份比较统一路径斜杠和大小写；直接身份不一致时，只用已枚举应用的 `path/extraPaths` 证明 shell AppID 与真实 exe 的别名关系。deny list 使用同一身份集合，allow 与 deny 任一别名命中都按 deny 优先，无法证明身份的前台仍拒绝输入。

### 剪贴板保护

- click-tier 在清空前必须能保存原文，否则拒绝操作；
- stash 保存在 AppState，回合结束恢复成功后才清除；
- 读取失败、取消或恢复超时均不会用空字符串覆盖原文；
- 多行快速粘贴执行“保存 → 写入 → 精确读回 → Ctrl+V → 恢复”，读回不一致不粘贴。

Computer Use 不是通用安全沙箱。应用可忽略消息，窗口可变化，用户也可随时接管鼠标键盘，因此结果验证不可缺少。

## 四、调用链与设计结构

```text
模型
  ↓
工具 schema 与本地 Computer Use 提示
  ↓
MCP tool object 的 .call()
  ↓
src/utils/computerUse/wrapper.tsx
  ├─ 统一 MCP 超时/取消/进度
  ├─ MCP isError 与完整错误内容
  └─ 权限 UI / AppState
  ↓
bindSessionContext（@ant/computer-use-mcp）
  ├─ 跨进程锁与调用代际
  ├─ allowlist / grant flags / clipboard stash
  ├─ 最近截图与显示器状态
  └─ 请求 signal / 实际批次进度
  ↓
handleToolCall 与各工具 handler
  ├─ 参数和权限门禁
  ├─ 点击、文本、滚动、截图、批次
  └─ errorResult(content + isError + telemetry)
  ↓
createCliExecutor
  ├─ macOS：Swift / Rust 原生模块
  ├─ Windows：PowerShell + Add-Type C# + Win32
  └─ Linux：内部 xdotool / scrot / wmctrl 后端（当前 CLI 不注册 Computer Use）
```

### MCP 直调而非远程 stdio 调用

CLI 的 in-process MCP server 主要回答 `ListTools`。实际执行由 `client.ts` 在工具对象上安装的 `.call()` 覆盖直接 dispatch，不走远程 MCP transport。

因此，Computer Use 单独接入统一 MCP 生命周期，而不是依赖普通 MCP 客户端连接恢复逻辑。

### 会话状态

AppState 保存：

- allowlist 与 grant flags；
- 最近截图尺寸和显示器状态；
- 自动隐藏的应用；
- click-tier 剪贴板 stash；
- 显示器 pin 与 resolver 信息。

最近截图的二进制内容只在进程内 binder 闭包保存；跨紧凑/恢复只保留尺寸元数据。

### 锁与调用代际

- 同一 `CLAUDE_CONFIG_DIR` 下，同时只有一个 Computer Use 会话可持有控制锁；
- 每个调用有单调 generation，迟到的截图不能覆盖更新调用的坐标锚点；
- 取消后，旧调用不能继续发出新的输入；
- 鼠标释放和必要的安全清理不被普通门禁随意阻断。

## 五、坐标与截图设计

### 1. 图像预缩放

截图按 API 的目标尺寸算法预缩放：

- 长边不超过 1568 像素；
- 按 28 像素/token 计算，图像 token 不超过 1568；
- 保持宽高比，避免 API 二次缩放导致模型视觉尺寸和点击尺寸不一致。

### 2. pixels 模式（默认）

模型直接使用上一张截图的图像像素，不自行计算 DPI 比例。

```text
屏幕 x = round(图像 x × displayWidth / 图像 width) + originX
屏幕 y = round(图像 y × displayHeight / 图像 height) + originY
```

`displayWidth/displayHeight/origin` 来自**截图当时**的几何信息，不是点击时重新猜测的显示器信息。

### 3. 全屏与绑定窗口是两种坐标空间

- 未绑定全屏：origin 来自 Windows `Screen.Bounds.Left/Top`，支持副屏负坐标；
- 绑定窗口：origin 为 `(0,0)`，坐标是窗口局部坐标；
- 真实输入只在原生边界加一次窗口 `GetWindowRect` 偏移；
- 窗口矩形、捕获和真实输入使用 Per-Monitor-V2 物理像素；
- 已验证的 PopCap `MainWindow` 与 WinForms DPI-unaware 窗口可能只把逻辑尺寸内容绘到物理画布左上角；捕获端在窗口移动前记录所在显示器 DPI，并只对这些已验证类型归一化到完整物理画布，其他 unaware 窗口不盲目裁剪；
- 后台 `SendMessage` 只扣除物理客户区偏移，接收端 DPI 转换由 Windows 完成，不重复手工缩放；
- 绑定窗口捕获失败不会回退成全屏图后继续按窗口坐标点击；
- `open_application` 进入窗口模式，`switch_display` 明确回到全屏与真实全局输入；无论打开或切换成功还是部分失败都清除旧截图锚点，换目标前先在原目标释放仍按住的按钮；活动输入未结束时换目标、目标切换期间的新调用均返回 `state_conflict`，迟到截图不得回写旧坐标。

绑定模式下 `getDisplaySize` 返回窗口输入表面，因此 `normalized_0_100` 也按窗口计算。默认仍为 pixels。全屏模式不需要 HWND，文本、单键、组合键、拖拽、按下/释放和滚动都直接发送到当前前台，权限门禁仍校验前台应用及其 tier。

### 4. zoom

zoom 的区域始终来自上一张完整截图，并使用该截图自己的 origin。

zoom 不更新 `lastScreenshot`，所以后续点击仍应使用完整截图坐标，不能使用放大图坐标。

### 5. 截图可信度

- 空图、零尺寸、非法原点、连续捕获异常 → `capture_failed`；
- 仅非原子路径会对捕获异常或异常小图重试一次；原子 `autoTargetDisplay` 路径不自动重试，小图仅记录告警；
- 小于 1KB 只用于启发式重试，不再直接判死合法小窗口；
- 普通截图不保留持久化输出；Windows 捕获会临时写入 JPEG 并尽力删除，`save_to_disk: true` 才返回持久化路径；
- 保存失败不会更新截图锚点。

## 六、Windows 输入设计

Windows 主要使用两条通道，不会在一个失败动作后盲目换通道重放。

### 1. HWND 后台 SendMessage

适合普通 Win32 控件：

- 单击、普通单键、窗口滚动和拖拽；文本输入不走此通道；
- 不要求目标窗口位于前台；
- 通过 `GetWindowRect + ClientToScreen` 修正标题栏/边框偏移；
- 检查实际消息传输结果和 expected PID；
- 后台拖拽的 mouse move 携带 `MK_LBUTTON`，释放有 finally。

它不是通用协议：Chromium、自绘程序和某些应用会忽略这些消息。

### 2. 真实前台输入

用于：

- 所有 bound HWND 的直接文本输入（不再使用后台 `WM_CHAR`，避免中文乱码）；
- Chromium、Qt/SDL 等自绘窗口；
- 双击/三击；
- 修饰键组合；
- 需要真实滚轮的场景。

使用 `SetCursorPos + mouse_event/keybd_event`，并在同一脚本内完成前台复核、最新窗口位置读取和输入。

组合键顺序为：

```text
修饰键 down → 主键 down/up → 修饰键逆序 up
```

### 3. Unicode 文本

真实 Unicode 输入使用键盘 `SendInput + KEYEVENTF_UNICODE`：

- x64 使用包含鼠标并集的 40 字节 INPUT 布局；
- 按 UTF-16 code unit 发送，覆盖代理对；
- 中文、emoji、ASCII 大写和符号不依赖手工 Shift；
- 文本先 UTF-8 base64 编码，再经 stdin 传入，避免命令行注入和长度上限；
- `SendInput` 返回事件数必须完整，部分成功会报错并尝试反向释放。

所有 bound HWND 的直接文本输入统一走真实 Unicode 通道；后台 `WM_CHAR` 不再用于这类文本输入。

### 4. 点击次数与释放

- 双/三击在一个 PowerShell 脚本内完成，避免进程间隔破坏系统点击计数；
- 中键使用真正的 `WM_MBUTTONDOWN/UP` 或中键 flag；
- 分解 mouse-down/up 记录实际通道，防止后台 down 配物理 up；
- key-up/mouse-up 优先用于清理，不因目标失去前台而故意留下按键。

Windows 对第三次点击的计数可能开始新序列，例如 WinForms 报告 `1,2,1`，这不是少发了一次点击，验证时要区分系统 click count 和 down/up 次数。

## 七、批次与部分失败

`computer_batch` 用于已验证、可预测的动作序列，而不是让模型盲目执行长脚本。

约束：

- 最多 100 个动作；
- 最多 4 张截图；
- 累计图片最多 20MiB；
- 单次 `type` 最多 100,000 个 UTF-16 code unit；
- 所有动作的完整参数在第一个副作用前校验；
- 顺序执行，首个失败停止；
- 每个动作尝试后报告真实 progress，刷新 idle deadline。

返回示例：

```json
{
  "completed": [{"action": "left_click", "ok": true, "output": "Click dispatched..."}],
  "failed": {"action": "type", "ok": false, "output": "actions[1] (type) threw: ..."},
  "remaining": 1,
  "recovery": "Do not replay the whole batch..."
}
```

即使 executor 抛异常，也会保留：

- 已完成动作；
- 失败动作与位置；
- 未执行数量；
- 已捕获图像；
- 先检查当前屏幕、只补缺失动作的恢复建议。

在动作之间或副作用前门禁取消时返回 `completed`、`aborted`（含下一动作的 `action/index`）、`remaining` 与同样的图像；被取消动作及其后续动作没有派发，不能把 `aborted` 当成已部分执行的 `failed`。执行器或动作中途（包括已输入部分文本、截图完成后）的 `AbortError` 仍按结果未知的 `failed` 处理。取消专用的 `recovery` 不会暗示被取消动作已部分执行；若鼠标释放清理也失败，会额外提示先确认没有按键仍处于按住状态。

顶层批次结果为 `isError=true`，但错误内容仍保留结构化 JSON；图像作为顶层 sibling 传给模型，不塞进只允许文本的错误 `tool_result`。宿主界面按单个 `tool_result` 关联并展示这些同级图片；并发多结果帧不猜测其归属。

批次中的截图可供检查，但不会把后续点击重新定位到该中间截图；要根据新图重新定位，应结束批次后单独截图。

## 八、错误、超时与取消

### 错误语义

- `isError:true` → 共享 MCP tool error，最终 `tool_result.is_error=true`；
- 文本保留可操作的恢复建议：截图/窗口异常先重新绑定并截图，输入与批次异常先检查界面，禁止盲目重放未知副作用；
- 坐标与 zoom 区域必须是有限非负数，批次在首个副作用前完成同样校验；
- 像素陈旧检查阻止点击时返回 `isError=true` 并明确 `The click was not dispatched`，不再把未执行当成成功警告；
- hooks、UI 和遥测不再把错误文本当成功；
- `dispatch` 只表示输入已派发，业务效果仍由截图验证。

### 超时

CU 复用统一 MCP 生命周期：

- 默认 idle：120 秒无真实进展；
- 默认 total：600 秒；
- 每 30 秒报告一次等待；
- `MCP_TOOL_TIMEOUT` / `MCP_TOOL_IDLE_TIMEOUT` 可覆盖。

超时明确说明“结果未知，不要盲目重试副作用操作”。

### ESC 与取消

ESC hook 注册成功时，ESC 触发宿主 `AbortController`；注册失败时，通知会提示改用 Ctrl+C。取消信号传播到：

- 权限对话框；
- 批次动作之间；
- Windows 文本 run 与 macOS grapheme 之间；
- 最终输入前、权限/前台检查和截图写回前。

取消是协作式的。正在执行的 Win32 调用或同步 PowerShell 进程不一定能立即被 JS abort 打断；统一超时和进程级超时是最后防线。不能把它描述为“任意时刻都能瞬时停止所有原生操作”。

## 九、性能边界

- 批次减少模型/API 往返，但不会自动合并所有底层 PowerShell 进程；
- Windows 连续文本 run 合并，避免逐 grapheme 创建进程；
- 长 Unicode 文本通过 stdin，避免脚本体积膨胀；
- 全屏捕获在同一个脚本中返回尺寸、原点与显示器数量，不再先做一次同步显示器枚举；单屏提示也不重复枚举，多屏名称仍按需查询；
- 有截图时 pixels 输入直接复用截图几何，不再为每次点击/移动额外读取显示器；`normalized_0_100` 仍读取当前窗口或显示器输入表面；
- 同步 PowerShell 仍可能阻塞 JS 事件循环，本轮没有整体改成常驻原生服务；
- 同步进程使用 Node `spawnSync.timeout`，异步进程使用显式 kill；不依赖当前 Bun 会忽略的 `spawnSync.timeoutMs`；
- 应用启动等待与窗口截图有各自超时，超时文案不会把“未知结果”写成“未发送”。

## 十、平台限制与验证原则

- SendMessage 并非对所有应用有效；
- `SendInput` 全部注入不代表目标应用完成业务动作；
- PrintWindow 返回 true 仍可能遇到特殊硬件加速黑图；
- Windows 捕获与输入使用 Per-Monitor-V2；混合 DPI 多屏仍应覆盖实际硬件验证，不能由单屏测试推断全部组合；
- 多屏原点已贯通，但应用→显示器的自动映射能力有限，负坐标副屏仍需相应硬件验证；
- 当前 CLI 不支持 Linux Computer Use；仓库中的 Linux 内部后端不等于对模型开放了完整能力；
- 任何平台都应保留截图验证和用户接管路径。

验证必须使用专用测试应用或只读截图，不能拿用户已有记事本、浏览器或文档做破坏性试验。详见 [test_specification.md](test_specification.md)。

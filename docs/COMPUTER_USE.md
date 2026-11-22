# Computer Use：能力、调用流程与设计

Computer Use（CU）是内置 MCP 工具组：在用户授权范围内截图、注入鼠标键盘、读写剪贴板、发现/绑定窗口。它不是「点击必生效」的黑盒，模型必须按 `截图 → 观察 → 操作 → 验证` 循环工作。门禁见 [DESIGN.md](DESIGN.md) §9，经验与坑见 [../development_logs.md](../development_logs.md)。

## 1. 工具矩阵

`packages/@ant/computer-use-mcp/src/tools.ts` 的 `buildComputerUseTools()` 注册 **Windows 27 / macOS 24 / Linux X11 18** 个工具。Windows 专属工具为 `list_windows`、`activate_window`、`get_window`。Teach 系列默认不注册（`caps.teachMode` 未启用）。

| 类别 | 工具 | 用途 |
|---|---|---|
| 授权 | `request_access` / `list_granted_applications` | 申请应用/剪贴板/系统组合键；查询授权、flags、坐标模式 |
| 屏幕 | `screenshot` / `zoom` | 当前目标 JPEG 与尺寸；放大上一张截图区域 |
| 窗口(Win)/应用 | `list_windows`、`get_window`、`activate_window`、`open_application`、`switch_display` | 发现/诊断/前置授权窗口；绑定应用；退出绑定回全屏 |
| 鼠标 | `left/right/middle_click`、`double/triple_click`、`mouse_move`、`left_click_drag`、`left_mouse_down/up`、`scroll`、`cursor_position` | 点击/移动/拖拽/分解释放/滚动；`cursor_position` 读实时光标（绑定窗口返回局部坐标） |
| 键盘/剪贴板 | `type`、`key`、`hold_key`、`read_clipboard`、`write_clipboard` | 文本/组合键/按住；剪贴板需独立 flag |
| 批次/等待 | `computer_batch` / `wait` | 顺序多动作与部分失败边界；有界等待 |

注册条件（`src/main.tsx`）：平台为 macOS、Windows 或通过能力检测的 Linux X11，且为交互会话或设置了 `DOGE_HEADLESS_BUILTIN_MCP=1`。设置 `DOGE_COMPUTER_USE_MCP=0` 可关闭。`setup.ts` 注册进程内 MCP（`mcp__computer-use__*`），工具调用走进程内 dispatch（不经 stdio）。

Linux X11 在可连接 `DISPLAY` 对应的本机 Unix socket、有 XTEST 和 EWMH 窗口管理器，且 PATH 中有 `xclip` 时注册。X11 协议和 JPEG 编码运行在 Bun 内，无需 Python 或编译工具。先打开目标窗口，调用 `request_access` 授权，再使用 `open_application` 聚焦并截图。授权绑定已打开的窗口。焦点或窗口几何变化后重新截图。截图和 zoom 遇到遮挡、非矩形窗口或区域越出屏幕时返回错误。文本输入临时使用纯文本剪贴板，恢复前检查其中内容是否变化。剪贴板提供非纯文本格式时停止。Wayland/Xwayland、整屏、拖拽、持键、鼠标按下/抬起和批量操作不在这一版 Linux 支持范围内。

## 2. 授权与安全模型

**申请与 tier**：模型先调 `request_access({ apps, reason, clipboardRead?, clipboardWrite?, systemKeyCombos? })`，授权仅本会话有效。tier：`read`（截图/定位）< `click`（+普通左键/滚动）< `full`（+键盘/右键/中键/修饰点击/拖放），未按住的 `mouse_move` 属定位；敏感只读应用（浏览器）倾向 `read`，终端/IDE 倾向 `click`。拒绝语义 `denied/policyDenied/userDenied/tierGuidance`，拒绝后不要重复弹框；未接 `onPermissionRequest`（默认 headless）返回 `feature_unavailable`；Auto/bypass 自动放行仍保留 macOS TCC；后台 AgentTool 子代理不能直接用 CU。

**目标身份**：Windows 不凭标题授权——候选窗口须匹配目标进程，输入前查 HWND 当前 PID，SendMessage/PrintWindow 前复核 expected PID，HWND 复用后旧授权失效；完整 exe 路径绑定必须经 `open_application`。全局输入鼠标用真实 `WindowFromPoint`、键盘用前台目标，命中失败/空目标拒绝；allow/deny 用同一身份集合、deny 优先、未知前台 fail-closed。可信宿主仅当内嵌内容存在真实父/根窗口关系且宿主在进程祖先链（≤32 层、父创建不晚于子），窗口 owner 不是安全边界。

**UAC 与管理员助手**：授权 ≠ 提权，UAC 提权不提升 tier。普通目标用普通 PowerShell；High 目标且本地更低才请求常驻管理员 PowerShell 助手（命名管道 + 属主校验），普通目标切回本地。UAC 安全桌面由用户处理：检测到即暂停并等 30 秒（`src/utils/computerUse/win32/uacWait.ts`），超时中止回合并上报；提示后必须重新截图。完整性 RID 读令牌 SID；System/安全桌面/应用反作弊不属于绕过目标。

**macOS TCC（恢复缺口）**：TCC 检查 Accessibility + Screen Recording，失败转 TCC 面板并返回 `tcc_not_granted`；但本树 `@ant/computer-use-swift` 解析到 `shims/ant-computer-use-swift`（空白 JPEG、TCC 恒 false），因此 macOS CU 不可用、实机未验证。

**剪贴板与锁**：清空剪贴板前必须能保存原文，stash 存 AppState、回合结束恢复成功后才清；多行粘贴为「保存→写入→精确读回→Ctrl+V→恢复」。同一 `CLAUDE_CONFIG_DIR` 同时只允许一个 CU 会话持锁（`~/.doge/computer-use.lock`）。

## 3. 目标解析与坐标映射

**双坐标空间**：全屏模式 origin 来自 `Screen.Bounds.Left/Top`（支持副屏负坐标），`switch_display("auto")` 显式解绑并回全局输入；绑定窗口 origin=(0,0)、窗口局部坐标，真实输入只在原生边界加一次 `GetWindowRect` 偏移；绑定截图失败不得回退全屏按窗口坐标点击。切换/解绑让旧截图失效，活动输入未结束时换目标返回 `state_conflict`。

**截图与缩放**：截图按 API 目标尺寸算法预缩放（`imageResize.ts`：28px/token、长边 ≤1568、token ≤1568、保持宽高比）。`pixels` 模式用**截图当时**的几何换算：`屏幕 x = round(图像 x × displayWidth / 图像 width) + originX`，y 同理（`toolCalls.ts` `scaleCoord`）；无截图冷启动退化 `scaleFactor` 并告警。捕获/命中/输入统一 Per-Monitor-V2 物理像素；已验证 DPI-unaware 窗口按显示器 DPI 归一化画布，其他不盲目裁剪。`zoom` 仅放大上一张完整截图区域，后续点击仍用完整截图坐标；空图/零尺寸/非法原点/连续异常 → `capture_failed`，`save_to_disk:true` 才落盘且失败不更新锚点。

**代际与一致性**：窗口/元素绑定有单调 `boundRevision`（`src/utils/computerUse/platforms/win32.ts`），输入与 zoom 执行前比较 revision，截图记录捕获前 revision 并在返回前复核；迟到旧图不得覆盖新锚点。绑定后若有**绑定之后新启动**的进程接管前台，旧绑定自动解除；已有进程的普通前台切换不误判。`consent.exe`、本工具管理员助手 broker、CU 自身进程属于工具自己的提权/控制流程，不算“新应用接管”，不能因此解除绑定。解绑会记录 `reason` 与前台身份；若本次截图在 capture 前后观察到解绑（包括此前动作已解绑、本次 `prepareForTarget("capture")` 内解绑），结果必须带明确的 “Binding released …” 提示：全屏图说明坐标空间已变为 display，窗口图说明绑定已释放且需重新截图，禁止静默改变坐标空间。诊断接口把**当前** `captureMode` 与 `lastScreenshot.captureMode/ageMs`、`lastBindingRelease` 分开返回，`lastScreenshot.ageMs` 与 `anchorAgeMs` 同源，避免把旧截图锚点误读成当前模式。

## 4. 输入原语与批次约束

**Windows 两条通道**：① HWND 后台 SendMessage（普通 Win32 控件：单击/普通单键/窗口滚动/拖拽，不要求前台，用 `GetWindowRect + ClientToScreen` 修边框并检查传输结果与 expected PID；Chromium/自绘程序会忽略）；② 真实前台输入（`SetCursorPos + mouse_event/keybd_event`：bound HWND 直接文本、自绘窗口、WinForms 点击与组合键、需要焦点控件的 Return/Tab、双击/三击、修饰键与滚轮）。失败不盲目换通道；组合键顺序为修饰键 down → 主键 down/up → 修饰键逆序 up。

**框架分类**：绑定后按顶层+子窗口类名一次分类，决定鼠标/键盘通道。Chromium（Electron/CEF/WebView2）、WPF（`HwndWrapper[...]`，AnyCast 等）、WinUI 3/UWP（`WinUIDesktopWin32WindowClass` / `ApplicationFrameWindow` / `Windows.UI.Core.CoreWindow`）、WinForms、JavaFX（`GlassWndClass-*`）、Flutter（`FLUTTERVIEW`）、Unreal（`UnrealWindow`）、Tk 与 Qt/SDL/GLFW/Unity/AWT 走真实输入；未知框架保持 SendMessage，不凭猜测抢前台。WinForms 的单击/拖拽/滚动/键盘统一走真实输入，避免同一窗口内通道不一致。

**Unicode 与点击**：`SendInput + KEYEVENTF_UNICODE`（40 字节 INPUT、UTF-16 code unit、覆盖代理对），文本先 UTF-8 base64 经 stdin 传入；事件数必须完整，部分成功报错并反向释放；`type` 非剪贴板路径把 LF/CRLF/CR 各派发一次 Return、Tab 派发真实键。双/三击同一脚本内完成；分解 mouse-down/up 记录实际通道。

**computer_batch**：最多 100 动作、最多 4 张截图、图片 ≤20MiB、单次 `type` ≤100,000 UTF-16 code unit；首个副作用前统一校验参数/键名/组合键授权/截图能力；顺序执行、首错停止、每动作前复核身份/tier/命中。返回 `completed[]`/`failed{action,code,output}`/`remaining`/`recovery` 与图片；**顶层 `isError=true` 时仍保留结构化 JSON，图片作为顶层 sibling（不要塞进纯文本错误 tool_result）**；门禁取消返回 `aborted`（未派发），执行中途 `AbortError` 按结果未知 `failed`；批次内截图仅供检查、不重定坐标锚点。

## 5. 模型使用流程

`request_access` → `open_application` 绑定或 `switch_display("auto")` 全屏 → `screenshot` 建立坐标基准 → 操作后**再次截图验证**（绑定窗口独立点击复查几何与 9×9 邻域，内容变化返回 `state_conflict`）→ 失败先读错误：权限不足调 grant，坐标陈旧重截图/zoom，窗口死亡重开，部分执行只补缺失步骤，超时不重放整个批次。`Click dispatched` 只代表已派发。

超时/取消：默认 idle 120s、total 600s，`MCP_TOOL_TIMEOUT`/`MCP_TOOL_IDLE_TIMEOUT` 可覆盖；超时明确「结果未知，不要盲目重试副作用」。ESC hook 触发宿主 AbortController（失败提示 Ctrl+C），取消传播到权限对话框、批次动作之间、文本 run、最终输入前与截图写回前；同步原生调用不一定立即中断，统一超时是最后防线。

**Windows ESC 生命周期**：hook 位于 PowerShell helper（`WH_KEYBOARD_LL`），回调只入队，独立 sender 线程连接命名管道并重试；不在 hook 线程做阻塞 I/O，避免 `LowLevelHooksTimeout` 与 CLI 主线程同步 PowerShell 动作期间丢 Esc。不再用 `LLKHF_INJECTED` 全量过滤：IME/键盘映射/远程桌面合成的用户 Esc 也应生效；只有 CLI 模型自身的 `key("escape")` 由真实输入注入脚本在 `keybd_event` 前写入期望时间戳，sender 在 3s 内一次性消费并抑制（含 `shift+escape` 等 Escape 组合键）。握手在消息泵开始后才发出，避免 hook 已装但未泵消息的窗口。每次 CU 动作前 `ensureEscHotkey` 复查 helper 存活，死亡则重注册；PowerShell 使用绝对路径，握手 10s，helper 失败有 15s 退避。

## 6. 测试与实机验证

**不能只验证「有结果」**：`Clicked/Typed` 不等于应用生效；image block 不等于截图正确；`cursor_position` 只是冒烟（用独立 `GetCursorPos + GetWindowRect` 对照，绑定窗口验证局部坐标）；down/up 对数不代表双击/三击被识别；不能拿另一通道 happy path 当证明。只许专用测试应用或只读截图，不得复用用户已打开的应用、做系统级破坏或覆盖剪贴板；测试产物必须清理。

可复用脚本（`tools/`）：`computer-use-e2e.ts`（只读）、`e2e-cu-input-guard.ts`（同名 exe/窗口绑定/真实点击）、`computer-use-input-fixture-e2e.ts`（WinForms fixture）、`computer-use-win32-unicode-e2e.ts`/`computer-use-chromium-unicode-e2e.ts`（Unicode 输入）、`computer-use-host-target-e2e.ts`、`computer-use-uac.test.ts`；package 内 `toolContract.test.ts` 校验字段契约。定向命令示例：`bun tools/check-computer-use-win32-performance.ts`（性能门禁）、`bun test tools/computer-use-uac.test.ts src/utils/computerUse/win32/elevatedPowerShell.test.ts`（UAC/管理员助手），管理员场景用 `CU_FIXTURE_ELEVATED=1` 跑 input-fixture e2e。

平台限制：Windows 走 `src/utils/computerUse/platforms/win32.ts`（PowerShell + Add-Type C# + Win32），混合 DPI 多屏仍需真实硬件；macOS 见 §2。Linux X11 验收可在隔离显示中运行 `xvfb-run -a sh -c 'openbox & bun tools/computer-use-linux-x11-e2e.ts'`，验收另需 `xauth xvfb openbox xdotool`。SendInput 全注入不等于业务完成；PrintWindow 返回 true 仍可能黑图；UAC/助手/自动解绑实机结果见 `../development_logs.md` §1。

## 7. 关键代码入口

- 工具 schema/调度/门禁：`packages/@ant/computer-use-mcp/src/{tools,toolCalls,mcpServer}.ts`；绑定/锁：`src/utils/computerUse/{wrapper.tsx,hostAdapter.ts,computerUseLock.ts}`。
- Windows 实现：`src/utils/computerUse/platforms/win32.ts` + `win32/`；统一入口 `src/utils/computerUse/executor.ts`；注册/开关/hint：`src/utils/computerUse/{setup.ts,gates.ts}`、`src/main.tsx`。

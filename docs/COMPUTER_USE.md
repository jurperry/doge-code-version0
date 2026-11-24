# Computer Use 能力与工具参考

Computer Use（CU）是内置 MCP 工具组。它可以在会话授权下截取画面、发送键鼠输入、读写文本剪贴板，也提供 Windows 窗口发现和诊断。工具结果会区分输入已派发、应用效果需观察、窗口状态已确认。

## 1. 平台与注册

`buildComputerUseTools()` 默认生成 **Windows 28 个、macOS 24 个、Linux X11 18 个工具**。下表按 Windows 的完整工具集编排，平台列标出注册范围。Teach 系列由 `teachMode` 能力开启，当前 CLI 未开启。

`src/main.tsx` 在支持的平台交互会话注册工具。非交互会话需要 `DOGE_HEADLESS_BUILTIN_MCP=1`，桌面 App 的 Code 会话会设置该变量。`DOGE_COMPUTER_USE_MCP=0` 可关闭。内置服务通过 `mcp__computer-use__` 前缀发现工具，实际执行由 CLI 的进程内 `wrapper.tsx` 转派。

- **Windows** 支持绑定窗口和全显示器。全显示器截图可以包含未授权应用，输入仍要经过授权与命中检查。
- **macOS** 的 24 个是注册契约。当前仓库使用 `shims/ant-computer-use-swift`，系统权限探测使用占位实现，实际键鼠和截图能力尚未恢复。
- **Linux X11** 要求本地 `DISPLAY` Unix socket、原生 X11、XTEST、兼容 EWMH 的窗口管理器以及 PATH 中的 `xclip`。先由用户打开窗口并授权，再用 `open_application` 聚焦，随后单独截图。截图和输入会重验窗口的焦点、身份、几何与可见性。遮挡、形状不规则或越出屏幕的区域会导致捕获失败。Wayland 与 Xwayland 会被拒绝。

## 2. 28 个工具

参数以表中字段名为准。坐标工具的 `coordinate` 为 `[x, y]`，以最近一张原始截图为基准。默认坐标模式为 `pixels`，具体读法见第 4 节。

| 工具 | 必填参数 | 可选参数 | 功能与结果 | 平台 |
| --- | --- | --- | --- | --- |
| `request_access` | `apps`, `reason` | `clipboardRead`, `clipboardWrite`, `systemKeyCombos` | 为当前会话申请应用授权和独立权限。Windows 的 `apps` 支持本地绝对 `.exe`、`.lnk` 路径，以及 `Desktop\文件夹\启动器` 形式的桌面相对路径。结果返回实际授权的 EXE `bundleId`。 | Windows、macOS、X11 |
| `list_granted_applications` | — | Windows 的 `include_windows`, `include_desktop` | 查询会话内的应用授权、权限开关和坐标模式。`include_windows` 附带最多 40 个已授权 EXE 的可见、有标题窗口，含 `windowId`。`include_desktop` 附带显示器、捕获模式、截图基准年龄、解绑记录、CLI 完整性级别和限制。 | Windows、macOS、X11 |
| `open_application` | `app` | Windows 的 `window_id`, `screenshot`, `settle_ms` | 打开已授权应用或将现有窗口置前。Windows 用 `window_id` 选定窗口时，`app` 须为该窗口对应的已授权 EXE 绝对路径。绑定窗口后默认返回首张图，可延迟 0–5000 毫秒等待界面渲染，或以 `screenshot: false` 跳过。X11 只聚焦已打开的授权窗口，随后单独调用 `screenshot`。 | Windows、macOS、X11 |
| `list_windows` | — | `visible_only`, `granted_only`, `limit` | 枚举已授权 EXE 的窗口及其 `hwnd`、`windowId`、焦点和最小化状态等。默认只看可见窗口并最多返回 40 个，`limit` 接受 1–100。`granted_only: false` 额外返回 `ungrantedCount`，按完整枚举结果计算未匹配有效授权的数量。具体身份和标题仍受保护。 | Windows |
| `get_window` | `hwnd` | — | 读取已授权窗口的 EXE、PID、标题、窗口类、焦点、最小化状态、DPI 感知、完整性级别及授权层级。需要点击坐标时以截图为准。 | Windows |
| `activate_window` | `hwnd` | `screenshot` | 尝试把已授权窗口置前，必要时恢复最小化，返回 `activated`。仅当目标是当前绑定窗口时，`screenshot: true` 可在激活成功后尝试返回新图。需要换绑时使用 `open_application`。 | Windows |
| `minimize_window` | — | `window_id`, `all` | 默认最小化当前绑定窗口，也可通过 `window_id` 操作另一个有点击权限的窗口，结果含 `minimized`。`all: true` 需要 `systemKeyCombos`，解除当前绑定并对桌面可见、有最小化按钮的窗口操作，结果含已最小化、仍打开及已关闭的窗口数量。 | Windows |
| `switch_display` | `display` | — | 使用截图提示中的显示器名称固定捕获目标，或传 `"auto"` 恢复自动选择。Windows 同时解除窗口绑定，进入全显示器捕获和全局输入模式。切换后单独截图建立新基准。 | Windows、macOS |
| `screenshot` | — | `save_to_disk` | 返回 JPEG、图像尺寸和适用的捕获信息，成功结果可成为后续坐标基准。Windows 绑定图可附 `hwnd`、`foreground`、`minimized`。`save_to_disk: true` 另返回保存路径。 | Windows、macOS、X11 |
| `zoom` | `region` | `save_to_disk` | 按最近原图的像素矩形 `[x0, y0, x1, y1]` 获取局部细节。传入四个整数，区域须在原图范围内。可保存 JPEG。后续输入继续使用原图坐标，局部图用于观察。 | Windows、macOS、X11 |
| `left_click` | `coordinate` | `text`，Windows 的 `screenshot`, `input`, `settle_ms` | 单次左键点击，可通过 `text` 指定修饰键。Windows 的 `input: foreground` 为已在前台的绑定窗口派发实体鼠标输入。`screenshot: true` 可结合 `settle_ms` 直接返回效果图，受支持的标题栏点击也可返回最小化状态。 | Windows、macOS、X11 |
| `double_click` | `coordinate` | `text` | 在指定位置连续发出两次左击，应用决定双击效果。 | Windows、macOS、X11 |
| `triple_click` | `coordinate` | `text` | 在指定位置连续发出三次左击，应用决定三击效果。 | Windows、macOS、X11 |
| `right_click` | `coordinate` | `text` | 在指定位置点击右键，常用于打开上下文菜单，需要 `full`。 | Windows、macOS、X11 |
| `middle_click` | `coordinate` | `text` | 在指定位置点击中键，需要 `full`。滚轮滚动使用 `scroll`。 | Windows、macOS、X11 |
| `mouse_move` | `coordinate` | — | 移到指定位置以定位或触发悬停。Windows 客户区后台通道可只发送移动消息，实体鼠标保持原位。按住左键时，移动按拖动相关权限检查。 | Windows、macOS、X11 |
| `left_click_drag` | `coordinate` | `start_coordinate` | 完成左键按下、移动到终点、释放整段手势。省略起点时，Windows 沿用工具最后设置的指针坐标，macOS 使用当前光标位置。落点需要 `full` 授权。 | Windows、macOS |
| `left_mouse_down` | — | — | 在指针位置按住左键。Windows 派发使用工具最后设置的指针坐标，先用 `mouse_move` 定位，再与 `left_mouse_up` 配对。已经按住时返回状态冲突。 | Windows、macOS |
| `left_mouse_up` | — | — | 释放左键。即使权限检查拒绝后续操作，也会尝试先释放鼠标按钮，避免留下持续按住的状态。 | Windows、macOS |
| `scroll` | `coordinate`, `scroll_direction`, `scroll_amount` | — | 在指定位置向 `up`、`down`、`left` 或 `right` 滚动，请求量为 0–100 的整数。X11 单次实际输入最多 20 格。 | Windows、macOS、X11 |
| `cursor_position` | — | — | 读取实体光标位置。有有效图像范围可换算时返回 `image_pixels`。没有截图或光标超出图像范围时返回 `logical_points`，Windows 绑定状态下底层读数以窗口左上角为原点。 | Windows、macOS、X11 |
| `type` | `text` | — | 向当前输入焦点键入文字，最多 100,000 个 UTF-16 代码单元，需 `full`。支持换行和 Tab。满足剪贴板授权和配置时，多行文本可整段粘贴。 | Windows、macOS、X11 |
| `key` | `text` | `repeat` | 发送单键或用 `+` 相连的组合键，如 `Return` 或 Windows 的 `Ctrl+A`。需 `full`，重复次数为 1–100，默认 1。受工具限制的系统级组合键另需 `systemKeyCombos`。 | Windows、macOS、X11 |
| `hold_key` | `text`, `duration` | — | 按住单键或组合键 0–100 秒再释放，需 `full`。受工具限制的系统级组合键另需 `systemKeyCombos`。 | Windows、macOS |
| `read_clipboard` | — | — | 读取文本剪贴板并返回 `{text}`，需 `clipboardRead`。应用处于 `click` 层级时，结果可能反映剪贴板保护逻辑清空后的状态。 | Windows、macOS、X11 |
| `write_clipboard` | `text` | — | 写入文本剪贴板，需 `clipboardWrite`。剪贴板保护启用时，`click` 层级目标会触发拦截。显式写入会改变系统剪贴板。 | Windows、macOS、X11 |
| `wait` | `duration` | — | 可取消地等待 0–100 秒。时间单位为秒，支持小数。等待结束后按任务需要观察界面。 | Windows、macOS、X11 |
| `computer_batch` | `actions` | — | 在一次调用中顺序执行已知动作。预检失败时停止派发，运行时首错停止，返回已完成项、失败或取消的位置及已返回的图片。批次语义与限制见第 5 节。 | Windows、macOS |

五种点击工具的 `text` 用于 `shift`、`ctrl+shift` 等修饰键。带修饰键的点击需要 `full`，触发受限系统组合键时还需 `systemKeyCombos`。

Windows 操作单个窗口时，先调用 `request_access`，再用返回的 `bundleId` 打开并取得定位图。桌面相对路径按 Windows 的桌面目录解析，文件名省略扩展名时必须唯一匹配 EXE 或常见快捷方式名。快捷方式只用于解析和授权目标 EXE，目标从自己的目录启动。带参数的快捷方式和非本地盘符目标会解析失败，此时可在资源管理器中确认文件名和启动条件。点击后可在同一次调用取得下一张图。需要最小化时，优先使用 `minimize_window({})`。受支持的 Word 或 Excel 文件名可触发专用 COM 路径，此类文件绑定和 HWND 窗口绑定分别处理。

## 3. 授权、焦点与安全

- **会话授权**。`request_access` 从已解析应用中请求授权，并独立请求剪贴板读写和系统级快捷键。在有用户确认界面的会话中，授权可按应用选择。当前权限模式允许自动授权时，CLI 可跳过确认。缺少必要的确认界面时返回 `feature_unavailable`。用户拒绝后应换用其他合适方式。授权保存在当前会话，授权查询自身也能返回空列表。
- **授权层级**。`read` 可截图和移动指针定位。`click` 允许普通左键和滚动。`full` 增加键盘、右键、中键、修饰点击和拖拽。浏览器等敏感类别或终端与 IDE 可能按策略获得较低层级。剪贴板和系统级组合键权限分别检查。
- **Windows 目标身份**。绑定、捕获和输入按窗口句柄与进程身份复核。窗口发现接口依据已授权的 EXE 路径筛选，标题用于辅助识别。全局鼠标检查命中窗口，键盘检查前台窗口。显式拒绝优先。高频窗口、显示器、命中、PID、完整性和几何查询经 Bun FFI 调 Win32。可信宿主还需满足窗口父子关系和进程祖先校验。
- **Windows 输入通道**。普通 Win32 客户区（包括通用 `MainWindow`）支持后台 HWND 消息，系统光标保持原位。游戏或自绘控件可在单次无修饰左击中显式要求 `input: foreground`。双击和三击、部分标题栏动作及已识别的 Chromium、WPF、WinUI、WinForms 等框架也使用真实输入。真实鼠标输入前复查焦点与点击命中，失焦后须显式恢复前台。无修饰单击命中原生最小化按钮时，CLI 可向同一个授权窗口发送最小化命令。后台派发的效果以返回的窗口画面和状态为准。
- **Windows UAC**。应用授权和进程完整性单独检查。需要更高完整性时使用管理员助手，用户在 Windows 安全桌面亲自确认。等待超过 30 秒会中止当前回合。提示结束后应先取得新截图，再继续输入。App 的永久授权通过用户确认 UAC 后注册当前用户、当前配置目录专用的最高权限任务。后续会话可按需连接助手，助手空闲 15 分钟退出。撤销永久授权需要再次确认 UAC。标准账户保留单次凭据流程。管理员助手的命名管道以当前用户为信任边界，动作子进程随 Job Object 清理。
- **Windows 管理员窗口的点击与激活**。桌面截图上的点击先核验命中进程的会话授权，再根据该进程的完整性选择助手。派发前复查命中 PID 与 UAC 状态。激活高完整性窗口也使用同一授权助手，以实际焦点为结果。旧版永久助手可继续使用，通过命名管道识别其 PID，避免助手短暂进入前台时使绑定失效。
- **剪贴板保护**。保护机制启用时，进入 `click` 层级会先保存原文本，再尝试清空。离开该层级或回合清理时尝试恢复，成功后清除存档。Windows 非粘贴路径按文本片段发送 Unicode，换行与 Tab 用单独键事件。X11 文本输入使用临时纯文本剪贴板，并在恢复前检查内容是否变化，遇到非纯文本剪贴板内容时停止。
- **锁与桌面提示**。同一 `CLAUDE_CONFIG_DIR` 同时只允许一个 CU 会话持有 `computer-use.lock`。`request_access` 与 `list_granted_applications` 只检查锁。Windows App 据锁和同一会话的 `computer-use-binding.json` 显示提示与绿色描边。失焦、最小化、解绑或回合结束时撤下绿框。独立 Windows CLI 尝试使用 DWM 原生染色。CLI 主会话负责调用，后台子代理的直接调用会被拒绝。

## 4. 捕获范围与坐标

- **窗口和显示器**。Windows 绑定截图从窗口左上角计坐标。全显示器截图从图像左上角计坐标，映射时考虑显示器在虚拟桌面上的位置，包括副屏负坐标。常规 Windows 截图在绑定捕获失败并完成必要清理后可解绑、返回目标显示器图像，并附 `Binding released` 提示。这张图使用新的坐标空间。
- **坐标换算**。`pixels` 模式直接读取返回图的像素坐标。执行器按捕获时的原始宽高和 JPEG 宽高换算，并在适用时加显示器原点。Windows 在真实窗口输入处另应用窗口位置。`normalized_0_100` 按注册时确定的百分制坐标契约解释输入。X11 固定使用像素。Windows 物理坐标查询、捕获与输入使用 Per-Monitor-V2，部分 DPI-unaware 窗口的图像在捕获阶段归一化。
- **缩放**。原图预缩放保持宽高比，长边至多 1568 像素，按 28 像素方块计算的图像 token 预算至多 1568。`zoom` 根据原图上的区域补抓局部细节，原图仍是坐标基准。保存失败的截图结果不会更新基准。
- **目标一致性**。Windows 坐标输入要求最近截图的目标代际与当前绑定一致。主动切换目标会使旧坐标失效。原有进程切到前台时通常保留绑定，需真实输入的工具会报告失焦。绑定之后新启动的其他进程接管前台时可自动解绑。UAC 确认窗口、管理员助手和当前 CLI 本身会从这类接管判定中排除。诊断结果分别报告当前捕获模式、上次截图和上次解绑。

## 5. 批次、恢复与停止

`computer_batch` 接受下列 16 种动作。每项用 `action` 指定工具名，其他字段沿用对应动作的参数。

```text
key, type, mouse_move, left_click, left_click_drag, right_click, middle_click,
double_click, triple_click, scroll, hold_key, screenshot, cursor_position,
left_mouse_down, left_mouse_up, wait
```

- 每批 1–100 个动作，最多 4 张截图，返回图片的解码后总量上限为 20 MiB。首个副作用前检查动作参数、受限快捷键授权、可校验键名和所要求的保存能力。运行中逐项检查目标、权限和命中，首错停止。
- 批次内的输入都基于批次开始前的截图，逐次点击的像素比对在批次内关闭，目标、权限与命中检查仍逐项执行。批次内通过独立的 `screenshot` 动作取图。Windows 成功执行到最后一项 `screenshot` 时，那张图可成为下次调用的坐标基准。
- 成功时返回 `completed[]` 和图片。运行时失败以 `isError: true` 返回 `completed[]`、`failed`、`remaining`、`recovery`，先前图片保留为与文本并列的内容块。批次运行中若在下一动作派发前捕获到取消，则返回 `aborted`。动作执行中发生错误时，部分输入可能已经发生。
- 在 Windows 绑定模式下，可用 `left_click` 的 `screenshot: true` 观察单步结果。恢复焦点时可用 `activate_window` 的同名参数一次取得新图。后续观察只捕获原绑定，保留窗口位置。点击已经派发但捕获失败时，结果仍会说明派发情况，先观察当前界面再决定是否补做。
- MCP 默认空闲超时 120 秒、总超时 600 秒。环境变量 `MCP_TOOL_IDLE_TIMEOUT` 与 `MCP_TOOL_TIMEOUT` 用毫秒覆盖。发生超时或部分失败时应先核实已产生的效果。
- Windows 的原生 Esc hook 取消本回合的 Computer Use。派发退出后清理输入、截图基准与会话锁，本回合其余回复可继续生成，新用户消息可再次使用 CU。工具自己发送的 Esc 走单次抑制记录。hook 不可用时，可通过会话的中断入口停止。

## 6. 代码与验证入口

| 路径 | 用途 |
| --- | --- |
| [tools.ts](../packages/@ant/computer-use-mcp/src/tools.ts) 和 [toolContract.test.ts](../packages/@ant/computer-use-mcp/src/toolContract.test.ts) | 平台工具注册、参数契约、批次动作及限制 |
| [toolCalls.ts](../packages/@ant/computer-use-mcp/src/toolCalls.ts) 和 [mcpServer.ts](../packages/@ant/computer-use-mcp/src/mcpServer.ts) | 权限、参数解析、工具调度、批次结果与截图基准 |
| [wrapper.tsx](../src/utils/computerUse/wrapper.tsx)、[executor.ts](../src/utils/computerUse/executor.ts) 和 [platforms/win32.ts](../src/utils/computerUse/platforms/win32.ts) | CLI 会话、取消与输入派发、Windows 绑定和捕获 |
| [computer-use-input-fixture-e2e.ts](../tools/computer-use-input-fixture-e2e.ts)、[computer-use-wpf-fixture-e2e.ts](../tools/computer-use-wpf-fixture-e2e.ts) 和 [e2e-cu-input-guard.ts](../tools/e2e-cu-input-guard.ts) | 专用 Windows 窗口的输入效果、窗口绑定与目标校验 |
| [check-computer-use-win32-performance.ts](../tools/check-computer-use-win32-performance.ts)、[computer-use-uac.test.ts](../tools/computer-use-uac.test.ts) 和 [computer-use-permanent-elevation-e2e.ts](../tools/computer-use-permanent-elevation-e2e.ts) | Windows 查询性能、UAC、管理员助手与永久授权 |
| [computer-use-linux-x11-e2e.ts](../tools/computer-use-linux-x11-e2e.ts) | 可在 `xvfb-run -a sh -c 'openbox & bun tools/computer-use-linux-x11-e2e.ts'` 下验证 X11，另需 `xauth`、`xvfb`、`openbox` 和 `xdotool` |

Windows 实机使用独立配置和专用测试窗口。验证应观察应用状态、真实焦点、输入效果或原生窗口状态。桌面 App 的 `verify-computer-use-bound-window.mjs` 另外覆盖首张绑定图、失焦拦截、显式激活、绿色描边和点击标题栏最小化。该脚本在 `CU_BOUND_WORKFLOW=1` 时验证桌面相对路径和绝对快捷方式、桌面和单窗最小化，以及 DPI-unaware 窗口的真实点击。测试纪律和相关历史见 [DESIGN.md](DESIGN.md) 与 [development_logs.md](../development_logs.md)。

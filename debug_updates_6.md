# debug_updates_6.md — Computer Use 输入前置卫兵 + Windows 应用枚举修复

分支：`feature/cu-input-guard-and-app-enum`（2026-09-09）

## Chapter 46：CU 输入前置卫兵（检查 → 激活 → 再校验 → 通过才输入 → 否则报错）

### 症状

Computer Use 在 Windows 上对已绑定 HWND 的应用可以后台截屏、也可以前台截屏，
但鼠标点击与键盘操作经常失效：

1. 用户把 `open_application` 打开的应用**关闭**后，所有 SendMessage 输入静默无效
   （向已销毁的 HWND 发消息不报错），截图则退化为全屏截图——模型看不出绑定已死。
2. 用户把应用**最小化/切到后台**后，走真实输入路径（Chromium 窗口的
   SetCursorPos+mouse_event、UIPI 回退的 keybd_event）的事件全部打进**当时的
   前台窗口**——等于往别的应用里点击/打字。旧的 typeText UIPI 回退里那个裸
   `SetForegroundWindow` 从不校验结果。
3. `apps.open()` 对已运行的单实例应用（Android Studio、模拟器、浏览器）：
   `Start-Process` 把请求移交给既有实例后新进程立即退出，旧的按新 PID 找窗口
   的循环 10s 后**静默返回**，绑定保持陈旧状态；启动彻底失败也静默返回。

### 修复（对齐 zcode computer-use MCP 的 activate 语义：激活后必须验证前台后
置条件，失败即报错，绝不静默降级到后台）

- 新增 `src/utils/computerUse/win32/windowGuard.ts`：
  - `ensureWindow(hwnd, needForeground)` — 单条 PowerShell 内完成：
    `IsWindow` 检查 →（fg 模式）`IsIconic` 时 `SW_RESTORE` → 前台归属校验
    （`GetForegroundWindow` 与 `GetAncestor(GA_ROOT)` 对比，root-owner 级，
    点击目标应用的子对话框也算命中）→ 未命中则 `AttachThreadInput` 前台锁
    绕行 + `SetForegroundWindow` + `BringWindowToTop`，3 次重试（第 3 次前
    ALT 微扰解锁前台锁），每次重试后重新校验。输出 `OK` / `DEAD` /
    `NOFG|<当前前台标题>`；解析函数 fail-closed（无法识别的输出一律按 DEAD）。
  - `findReplacementWindow(pid, exeBase)` — 绑定死亡时先按 PID、再按进程名找
    替身窗口（应用换窗而非退出的场景：新文档窗口、对话框拆建）。
- `platforms/win32.ts` 新增 `guardBoundWindow(needForeground)` 编排：
  探测 → 死亡则重绑再探测 → 需前台则激活+校验 → 通过放行，否则抛出**面向模型
  的错误**（指引 open_application 重开 / 截图 / 请用户恢复窗口）。带 500ms
  探测微缓存（批处理动作不再每个都多起一个 PowerShell）。
- 接线（按传输选择检查强度）：
  - `click`：Chromium / UIPI 回退（真实输入）→ fg 检查；SendMessage → 存活检查
  - `typeText` / `key` / `keys`：SendMessage → 存活；UIPI 回退 → fg 检查
    （替换掉旧的裸 SetForegroundWindow）
  - `scroll`：Chromium 的全局 mouse_event 滚轮 → fg；WM_VSCROLL → 存活
  - `moveMouse`：存活检查（纯移动无副作用）
- `apps.open()` 重写：
  - **Step 0 已运行窗口优先绑定**：按进程名（basename 精确）/ 窗口标题匹配，
    命中直接 bind + 尽力置前（工具契约就是 "bring to the front"），不再盲启新实例；
  - 启动链新增 **App Paths 注册表**分支（Store 应用如 Win11 notepad 的正路），
    `Get-Command` 只认 `.exe` 结果（PATH 里 Git 的无扩展名 shim 会让
    Start-Process 报"没有关联应用程序"），`Get-StartApps` 在非交互会话常返回
    空、降级为兜底；注册表 Uninstall 分支同时匹配 PSChildName；
  - 找窗口循环升级为 新PID → 进程名PID集合（**循环内重算**，UWP stub-PID 错位
    与慢启动场景）→ 标题包含；输出 `hwnd|pid|exePath`，exeBase 随绑定记录；
  - LAUNCH_FAILED / HWND_NOT_FOUND 从静默返回改为**抛错**并给出指引。

### 坑（本次踩到）

- JS 模板字符串里写 PS 注释 `E:\Git\usr\bin\notepad`：`\u` 是非法 Unicode
  转义 → 整个文件 SyntaxError（bun 只报 "Syntax Error" 不给细节，靠二分定位）。
  模板里的 Windows 路径要么双反斜杠要么用正斜杠。

## Chapter 47：Windows 应用授权（request_access 不显示存在的应用）

### 症状

安卓模拟器、Android Studio 等明明在机器上存在，`request_access` 弹窗里却显示
"(not installed)"，且请求前有明显卡顿。

### 根因（三层叠加）

1. `listInstalled` 是单个大 PowerShell 脚本：注册表 + `Get-AppxPackage`（慢）+
   递归开始菜单快捷方式（**每个 .lnk 新建一个 WScript.Shell COM**）+
   `Get-StartApps` 串行执行，任何一段慢就把 `psAsync` 的 15s 守卫拖爆 → 进程
   被杀 → 输出为空 → 全部 not_installed（这就是"卡住 + 不显示"）。
2. `mcpServer.ts` 的 `tryGetInstalledAppNames` 用 **1s 超时**（macOS Spotlight
   调优值），Windows 枚举必然超时 → `request_access` 工具描述里的
   "Available applications on this machine" 提示**恒为空**；且
   `appNames.ts` 的路径白名单只有 `/Applications/`、`/System/Applications/`
   （macOS 路径），Windows 上 `isUserFacingPath` 恒 false → 即使枚举成功提示
   也为空。
3. **运行中应用完全不参与解析**：模拟器/Android Studio 恰恰常以运行态存在，
   注册表 DisplayName 与模型请求名对不上时没有任何回退匹配。

### 修复

- 新增 `src/utils/computerUse/win32/installedApps.ts`：
  - 五阶段并行枚举（`Promise.allSettled`，各带独立超时）：注册表 Uninstall /
    **App Paths** / 快捷方式（**COM hoist 出循环**，一次创建）/ `Get-StartApps`
    （取代 Get-AppxPackage，快且 AppID 可直接 `shell:AppsFolder\<AppID>` 启动）/
    **运行中窗口**（EnumWindows + Get-Process：进程名为 displayName、exe 路径
    为 id、**窗口标题进 extraPaths** 参与包内路径匹配——模型叫"MuMu模拟器"
    也能被窗口标题匹配到）；
  - 合并去重纯函数 `mergeInstalledEntries`（可单测）：displayName 键去重、
    prefer `.exe` id、败者路径/标题并入 extraPaths；
  - 单飞（in-flight 去重）+ 60s TTL 缓存：ListTools 的提示枚举与 request_access
    的解析枚举共享同一次后台枚举。实测本机 658 应用 **1.3s**（旧实现必超 15s）。
- `mcpServer.ts`：枚举超时按平台——win32 8s（提示真正能出现），其余 1s 不变。
- `appNames.ts`：`isUserFacingPath` 增加 win32 分支（改为排除 Windows 系统目录
  而非 macOS 白名单）；新增 `ALWAYS_KEEP_WIN32_EXE_BASES`（chrome/studio64/
  dnplayer/mumu/wechat…按 exe basename 匹配，Windows 的 bundleId 是路径）。

### 验证

- 单测：`windowGuard.test.ts`（8）、`installedApps.test.ts`（6）、
  `appNames.test.ts`（5）。
- 实机 e2e：`test/e2e-cu-input-guard.ts`（13 项全过）——枚举规模/耗时/解析、
  request_access 全链路（dispatch → 解析 → 授权 notepad）、open 绑定、后台
  SendMessage 输入落地（WM_GETTEXT 读回校验，兼容 Win11 记事本的
  RichEditD2DPT）、微缓存、杀进程后 platform 层抛错 + 工具层 isError 带指引、
  死探测、重开重绑、最小化 → liveness 通过 → fg 卫兵恢复置前。
- 回归：`test/computer-use-e2e.ts` ALL PASS；`bun test src/utils/` 132 通过；
  `bun run version` 2.1.261 正常。

### 行为变化（对模型可见）

- 输入目标死亡/无法置前 → 工具报错并给指引，替代静默无效。
- `open_application` 失败 → 报错（原静默）；对已运行应用 → 直接绑定既有窗口
  并尽力置前（原盲启新实例后 10s 超时）。
- macOS/Linux 路径零改动（全部改动在 win32 分支 + 平台无关纯函数）。

## Chapter 48：自绘窗口（Qt/模拟器）输入通道 + 拖拽修复

### 症状（外部模型实机报告）

Android 模拟器（Qt 应用，`qemu-system-x86_64`，窗口类 `Qt653QWindowIcon`）里
CU 的移动/点击/拖拽全部无效：`adb shell getevent` 显示 **0 个触摸事件**，但
原生 SetCursorPos + mouse_event 相同坐标能正确点击。

### 根因

1. 绑定 HWND 后鼠标走 `windowMessage.sendClick/sendMouseMove`（向顶层 HWND
   SendMessage WM_MOUSEMOVE/WM_LBUTTONDOWN）。**自绘框架（Qt/SDL/GLFW/Unity/
   Java AWT）在自绘表面里渲染并自己消费原始输入**，父窗口收到的 SendMessage
   鼠标消息不会产生任何应用层效果。`ensureSendAccess()`（WM_NULL UIPI 探测）
   只验证"消息能否送达"，验证不了"应用是否响应"。Chromium 单列检测
   （`detectChromium`）恰好不覆盖 Qt；UIPI 也没拦（Medium 完整性）→ 走
   SendMessage → 静默无效。键盘同理（`sendText` 的 findEditChild 找不到 Qt
   控件返回 false，调用方不检查）。
2. **拖拽在 Windows 上从来就是错的**：executor.getInput 的 `mouseButton` 把
   press/release 一律映射成 `p.click()`（完整点击），drag = down+move+up 三个
   原语 → 实际是 3 次独立完整点击 + 每帧动画一次 PowerShell spawn。

### 修复

- 新增 `win32/windowClassify.ts`（纯函数，单测 6 例）：按顶层+子窗口类名分类
  —— Chromium（鼠标真实输入、键盘仍可 SendMessage）vs **selfDrawn**
  （`Qt\d*QWindow*`/`SDL_app`/`GLFW*`/`UnityWndClass`/`SunAwt*`：鼠标+键盘全走
  真实输入）。`bindWindow` 时一次枚举分类（`detectWindowFramework` 替代
  `detectChromium`），`getBoundInputChannel()` 暴露诊断。
- `platforms/win32.ts`：`realMouseChannel() = isChromium || isSelfDrawn` 统一
  通道判定；click/moveMouse/scroll/selfDrawn 的 typeText/key/keys 全部切到
  真实输入（前台卫兵保护）。
- 拖拽修复：InputPlatform 新增可选 `mouseDown/mouseUp/drag`（types.ts）；
  `windowMessage.ts` 新增 `sendMouseButton`（WM_LBUTTONDOWN/UP 单相）与
  `sendDrag`（move→down→缓动帧→up **单条 PowerShell** 完成）；win32.ts 新增
  真实输入版 `sendInputButton`/`sendInputDrag`（SetCursorPos+mouse_event 单
  进程整手势，40fps ease-out cubic）。executor.getInput 的 `mouseButton` 按
  action 分派（press→mouseDown、release→mouseUp、click→click）；
  executor.drag 优先委派 `platform.input.drag`（单进程手势），无则回退原语
  组合（Linux/macOS 不变）。

### 验证（模拟器实机）

`test/e2e-cu-emulator-input.ts`（模拟器运行中 + adb 时跑，缺则 SKIP）：
- 窗口定位 → `Qt653QWindowIcon` 判定 selfDrawn/realMouse；
- `click` → `adb getevent` 出现 `ABS_MT_TRACKING_ID 0` + `ABS_MT_POSITION_X/Y`
  （旧行为 0 事件）；
- `drag` → down → **13 个插值 X 采样** → up（`ABS_MT_TRACKING_ID ffffffff`）。
- 注意：此 virtio 触摸屏走 MT 协议**无 BTN_TOUCH**，断言要用 TRACKING_ID；
  `get-state` 是 adb 宿主命令，`adb shell get-state` 在新模拟器镜像不可用。
- 回归：windowClassify 单测 6 + `bun test src/utils/` 138 全过；notepad 卫兵
  e2e（SendMessage 路径未回归）+ computer-use-e2e + version 全绿。

### 已知边界

- **提权目标 + 真实输入**：UIPI 同样丢弃低 IL 进程对高 IL 前台窗口的
  SendInput/mouse_event——对管理员权限运行的目标应用，真实输入通道也会静默
  无效（SendMessage 通道则被 UIPI 直接挡）。此时需要管理员终端启动 doge
  （AGENTS.md 既有提示）。通道选择/激活逻辑无法探测这种丢弃，属 Windows 硬限制。

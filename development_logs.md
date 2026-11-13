# development_logs.md — Doge Code 开发日志

仅保留最近 10 条，每条三行：问题 / 解决 / 位置与验证。历史实现以 git 记录为准，测试统一遵守 [test_specification.md](test_specification.md)。

## 2026-11-13 Windows 全屏与绑定窗口双坐标空间修复（2.1.329）

1. 问题：`open_application` 后 HWND 永久接管截图与坐标，`switch_display` 不能回到全局；无绑定时键盘、文本、拖拽和按下/释放直接报错，全屏截图前同步枚举显示器还会间歇性 PowerShell 超时，导致全屏 Computer Use 与批处理不可用。
2. 解决：`switch_display` 显式解绑并选择全屏，补齐全局真实输入；切换与活动调用互斥、目标代际阻止迟到截图、部分失败也清坐标锚点，换绑前释放按钮。捕获后统一缩放并携带显示器数量，像素输入复用截图几何；授权身份统一路径规范化与 shell/exe 别名证据，deny 双向优先且未知前台仍 fail-closed。安装版补丁用 `QueryFullProcessImageName` 恢复 MainModule 不可读进程的真实 exe，完整路径精确匹配优先于显示名宽松匹配；本地 exe 文件存在即可授权且保留原应用 tier，静态应用项缓存与每次实时窗口枚举分离，避免授权被注册表 GUID 抢占。
3. 位置：`packages/@ant/computer-use-mcp/src/`、`src/utils/computerUse/{executor,wrapper.tsx,setup.ts,platforms/,win32/processImage.ts}`、相关单测与 `tools/computer-use-{e2e,input-fixture-e2e}.ts`、专项文档。按要求仅做相关回归：定向单测 109/109、真实 WinForms 绑定及全局输入和批次全通过、连续 10 次全屏截图通过；独立多轮 review 最终 Approve，无剩余问题。开发版黑盒与安装版结果见邻仓 App 日志，未跑全量回归。

## 2026-11-13 Windows 便携应用与 Computer Use 稳定性修复（2.1.326）

1. 问题：未注册便携应用经 `open_application` 冷启动反复失败，中文路径已授权仍被判未授权，截图与 `computer_batch` 偶发 PowerShell 超时并诱导模型绕圈。实测分别发现 PowerShell 非 UTF-8 输出破坏中文路径、exe 继承 CLI 工作目录导致 PvZ `FATAL ERROR`、Unicode 进程名被过滤、装饰性 DWM 边框可否决打开、授权别名重复、`shell:AppsFolder` 覆盖真实 exe，以及 Windows 授权路径斜杠/大小写不一致。
2. 解决：PowerShell 同步/异步输出统一 UTF-8；所有已解析 exe 以自身目录为工作目录并用 `-LiteralPath`；进程名保留 Unicode；边框改为 best-effort；授权按 bundleId 去重并同步等级提示/计数；StartApps 的真实 exe 直接保留原路径，合并按真实 exe > shell 别名 > 普通项；`open_application` 仅在 Windows 规范化路径斜杠和大小写且始终使用原授权身份。批次协议、权限 tier、坐标与取消语义不变。
3. 位置：`src/utils/computerUse/{platforms/win32,win32/{appLaunch,installedApps,powerShell,windowBorder,windowGuard}}.ts`、`packages/@ant/computer-use-mcp/src/toolCalls.ts` 及对应测试、`tools/computer-use-win32-unicode-e2e.ts`、`computer_use.md`、`test_specification.md`。按用户要求仅做相关回归：单测 80/80、真实 `computer_batch` 中文输入+批次截图连续 3 轮、WinForms 25/25、PvZ 正常主窗口连续 10 次截图、关闭状态枚举真实 exe 全通过；独立多轮 review 最终 Approve，无剩余 Critical/Important/Minor。安装版冷启动与批次结果见邻仓 App 日志，未跑全量回归。

## 2026-11-13 Windows 高 DPI 截图与点击坐标修复（2.1.322）

1. 问题：150% DPI 下 PopCap/DirectDraw 与 WinForms 的 `PrintWindow` 仅将逻辑尺寸内容贴在物理画布左上角，后续声明整窗坐标导致点击错位；绑定窗口光标回读使用缓存，真实滚轮缺少 DPI-aware 设置；安装版黑盒另发现完整中文 exe 路径已授权却无法被 `open_application` 精确匹配。
2. 解决：捕获与输入切换 Per-Monitor-V2 并校验最终 context；在移动最小化窗口前固定显示器 DPI，只对已验证的 PopCap `MainWindow` 与 WinForms 归一化贴角内容，其他 unaware 窗口不盲目裁剪；后台消息保留物理客户区偏移，由 Windows 做接收端转换，避免双重缩放；光标改为实时窗口局部坐标并修正越界提示；`open_application` 优先接受 allowlist 中的精确路径/bundleId，再回退显示名匹配。
3. 位置：`src/utils/computerUse/{executor,platforms/win32,win32/windowCapture,win32/windowMessage}.ts`、`packages/@ant/computer-use-mcp/src/{toolCalls,toolCalls.test}.ts`、`tools/computer-use-input-fixture-e2e.ts`、`computer_use.md`、`test_specification.md`。相关单测 109/109、隔离 WinForms 25/25、Chromium Unicode 与只读 e2e 全通过；显示器枚举 20/20；PvZ 中文路径授权及启动页、玩玩小游戏两次真实 MCP 点击通过。独立复审 Approve，无 Critical/Important；混合 DPI 副屏与游戏内 Esc 未实测。

## 2026-11-12 Windows 中文输入乱码修复（2.1.319）

1. 问题：DeepSeek Harness 输入“你好，做个自我介绍”出现乱码；独立 Electron 与原生 EDIT 均复现，证明短文本 `WM_CHAR` 通道在中文环境不可靠，而非目标应用或更新器异常。
2. 解决：所有 bound HWND 的直接文本输入统一经原前台守卫和 `SendInput + KEYEVENTF_UNICODE`，保留 Word COM、剪贴板、键鼠授权与释放语义；新增原生 EDIT 和独立 Chromium 真值验证，启动清空沙箱、预置旧真值与失效句柄也不能制造假通过。
3. 位置：`src/utils/computerUse/{platforms/win32,win32/windowClassify}.ts`、`tools/{computer-use-win32-unicode-e2e,computer-use-chromium-unicode-e2e}.ts`、`computer_use.md`、`test_specification.md`。相关单测 56/56、两轮全量各 1082/0、逐文件隔离 141 文件 1030/0；原生中文短句、Chromium 中英文与 emoji 长文本及原 WinForms 18 项全部通过，独立复审 Approve。

## 2026-11-12 Computer Use 截图展示与异常恢复补强（2.1.318）

1. 问题：App 丢弃截图工具图片，通用原生异常缺少可执行恢复路径；批次中断丢失进度和图像，陈旧像素检查把未点击返回成成功，非有限坐标可穿透到原生层。
2. 解决：直播与历史统一关联工具图片及单结果同级图像；按动作补充先截图、禁止盲重试的恢复提示，批次新增 `aborted/recovery` 并保留旧中断文案；非有限参数在副作用前拒绝，陈旧点击明确 `isError`。
3. 位置：`packages/@ant/computer-use-mcp/src/{toolCalls,toolCalls.test}.ts`、`src/utils/computerUse/{setup,setup.test}.ts`、`computer_use.md`，邻仓 App `src/shared/chatHistoryUser.ts` 与 `ChatPane.tsx`。定向 50/50、两轮裸全量各 1082/0、逐文件隔离 141 文件 1030/0、只读实机截图/zoom/cursor/锁释放及隔离 WinForms 输入全通过；独立终审 Approve，安装版结果见邻仓日志。

## 2026-11-12 全量测试跨文件状态污染与回归修复

1. 问题：全量测试出现 17 项失败，涉及重试、模型/OAuth、启动配置、任务通知、记忆路径和滚轮，单文件与组合结果不同。
2. 解决：逐项确认模块 mock、宿主 env、ALS/OAuthSession、global config/登录 Key/startup 缓存和记忆路径 memoize 污染；改用真实事件 tap、完整测试前后 reset、FD fixture 与 native/xterm.js 分支断言，未修改正常产品语义。
3. 位置：`tools/{modelTestIsolation,teammate-transcript-progress,model-oauth-source,model-runtime-context,model-startup-context,run-isolated-tests}.ts`、相关测试文件。连续两次裸 `bun test` 均 1070/0，隔离器 140 文件 1029/0，多轮 review 通过，产物全部清理。

## 2026-11-12 Windows Computer Use 可靠性、异常反馈与输入正确性修复

1. 问题：CU 直调丢失 `isError`/超时/取消，批次丢失部分进度与图像，Windows 误报输入成功；双/三击、组合键、Unicode、滚动、多屏、授权身份与剪贴板恢复存在缺口。
2. 解决：接入统一 MCP 生命周期与调用代际，保留结构化失败和顶层 sibling 图像；Windows 检查 PowerShell/Win32 错误及 PID/前台，修复输入原语、坐标几何、授权提示、剪贴板 stash/恢复和释放通道。
3. 位置：`packages/@ant/computer-use-mcp/src/`、`src/services/{mcp,tools}/`、`src/utils/computerUse/`、`tools/computer-use{,-input-fixture}-e2e.ts`。定向测试、只读截图与隔离 WinForms 实机均通过；不宣称混合 DPI 或所有应用兼容。

## 2026-11-12 Windows Computer Use Esc 生命周期修复（2.1.317）

1. 问题：Windows Esc hook 消息循环未执行、named pipe 调用错误，注册提前返回且 helper 退出泄漏；模型合成 Escape 和子代理锁所有权也会干扰中止。
2. 解决：安装可等待握手的原生 hook，以 generation/PID 隔离注册与连接，按 injected flag 忽略模型合成 Escape，后台子代理在加载原生模块前明确拒绝。
3. 位置：`src/utils/computerUse/{escHotkey,executor,wrapper}.tsx/ts`、`src/utils/computerUse/win32/escHook.ts`。helper 13/13、真实 CLI 3/3、AgentTool 2/2 通过；物理安全桌面未实测，named pipe 信号链已实测。

## 2026-10-31 App 长驻会话跨会话记忆链路与退出回收（2.1.315）

1. 问题：外部 Bun 构建移除记忆提取模块，App 回合结束无法提取；主回合 abort 与进程退出可能丢失在途记忆。
2. 解决：统一运行时门禁，App 以 `DOGE_HEADLESS_AUTO_MEMORY=1` 显式启用；禁用仍初始化 `MEMORY.md`，提取使用独立 AbortController 并在退出前 drain。
3. 位置：`src/cli/print.ts`、`src/query/stopHooks.ts`、`src/utils/backgroundHousekeeping.ts`、`src/memdir/`、`src/services/extractMemories/`。聚焦测试 4/4、逐文件 989 pass、独立复审通过。

## 2026-10-29 Windows 终端右键复制 TUI 选择文本乱码

1. 问题：中文 Windows 控制台代码页 936 下，TUI 选择文本经 `clip.exe` 复制出现中文和表情乱码，toast 还误称仅 OSC 52。
2. 解决：Windows 原生剪贴板改用 PowerShell UTF-8 stdin/stdout，串行化并跳过过期排队写入，失败暴露日志和超时；本地 Windows 归为 native。
3. 位置：`src/ink/termio/osc.ts`、`src/ink/termio/osc.test.ts`、`tools/verify-windows-clipboard.ts`。CP936 下 Unicode、多行、5.6 万字符及连续写入通过，逐文件 131 文件全绿。

## 2026-10-29 TUI 三区固定布局与可拖动历史滚动

1. 问题：欢迎导航、消息与底部输入共用渲染流，多步调用后布局错位；外部用户没有独立消息视口和可见滚动条。
2. 解决：默认 alternate-screen 三区布局，头部固定、短终端 compact、极短隐藏；消息区独立 ScrollBox/VirtualMessageList 和可拖拽滚动条，Ink 增加鼠标捕获分发。
3. 位置：`src/components/{FullscreenLayout,Messages,LogoHeader,ScrollBar}.tsx`、`src/screens/REPL.tsx`、`src/utils/fullscreen.ts`、`src/ink/`。专项 34 项、逐文件 130 文件 988 测试、CLI 与 worktree e2e 通过，已授权合并。

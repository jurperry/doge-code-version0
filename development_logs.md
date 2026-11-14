# development_logs.md — Doge Code 开发日志

仅保留最近 10 条，每条三行：问题 / 解决 / 位置与验证。历史实现以 git 记录为准，测试统一遵守 [test_specification.md](test_specification.md)。

## 2026-11-14 Windows 新进程接管与坐标代际修复（2.1.337）

1. 问题：绑定 Explorer 启动游戏后仍长期截图/点击旧 Explorer，模型转 Bash 并混用逻辑/物理坐标；自动解绑若不清坐标，还会在并发下让新目标收到旧绑定输入。
2. 解决：绑定后新启动且不同的前台进程自动解除旧绑定，旧进程后台操作不受影响。使用单调 binding revision：输入/zoom 比较调用 revision，截图记录捕获前 revision 并在返回前复核；同一变化只清一次锚点，延迟旧图不得覆盖新图。模型不得用 shell 绕过目标/权限或混用自定义截图坐标。
3. 位置：`src/utils/computerUse/{platforms/win32.ts,executor.ts,setup.ts}`、`packages/@ant/computer-use-mcp/src/` 与原生夹具。相关测试 92/92；普通/管理员原生全套及双进程正反例通过，真实新进程前台接管会解除旧绑定。多轮独立审查最终 Approve，无剩余 Critical/Important。

## 2026-11-14 Windows 高 DPI 命中修复与 Computer Use 调用收敛（2.1.336）

1. 问题：一次启动器任务出现 64+ 次工具调用，含 26 次截图和多次重复点击。原始记录证明主要根因不是 UIPI，而是共享目标解析未启用 Per-monitor-V2，却把物理像素传给 WindowFromPoint，导致空命中/误命中和反复重试。
2. 解决：前台与指针 HWND 求值前统一启用并验证 Per-monitor-V2，与截图和输入坐标一致；不增加启动器特例或 UIA 产品回退。双进程夹具移到主屏右下高物理坐标，保留可信/不可信宿主反例。
3. 位置：`src/utils/computerUse/platforms/win32.ts`、`tools/computer-use-host-target-e2e.ts`。定向 104/104、普通/管理员原生全套及真实双进程测试通过；真实启动器全局最小化用 switch_display+screenshot+left_click 共 3 次调用成功，独立审查 Approve。

## 2026-11-14 Windows 通用宿主目标解析与授权（2.1.335）

1. 问题：全局命中只看实际子进程，内嵌渲染器与启动器主程序身份不同会反复阻塞；前台和指针校验曾分叉，简单 owner 继承又会被伪造。
2. 解决：前台与 WindowFromPoint 共用实际/根宿主 PID、exe 与信任解析；仅 GA_ROOT 父/根关系加真实进程祖先链可让宿主覆盖内嵌技术身份，owner 不参与授权。实际与宿主的显式拒绝和安装别名 policy deny 均优先，未知目标拒绝输入。共享 resolveTargetAccess 统一 read/click/full 判断。
3. 位置：`src/utils/computerUse/{platforms/win32.ts,executor.ts}`、`packages/@ant/computer-use-mcp/src/{executor.ts,toolCalls.ts}`、`tools/computer-use-host-target-e2e.ts`。定向 104/104，普通/管理员原生全套通过；真实双进程正向可信点击与反向外部进程嵌入拒绝均通过，独立审查 Approve。

## 2026-11-14 Windows 高完整性应用管理员助手（2.1.334）

1. 问题：UAC 消失后，仍以高完整性级别运行的启动器受 UIPI 限制，普通 Computer Use 无法输入，绑定 PrintWindow 实测 Access denied；并非所有 UAC 应用都如此。新增助手还需避免取消后输入、授权切换、并发助手和孤儿进程。
2. 解决：仅对已授权的高完整性目标请求一次常驻管理员 PowerShell，经同用户随机命名管道执行输入/窗口截图；普通目标保持本地执行。保留 30 秒人工 UAC 决策，补齐真实命中/准备后授权复核、事务串行化、取消传播、延迟键鼠释放。助手以父 PID+启动时间识别属主，并用异步管道等待确保强杀属主后退出。
3. 位置：`src/utils/computerUse/{platforms/win32.ts,executor.ts,wrapper.tsx,win32/}`、`packages/@ant/computer-use-mcp/src/` 及原生夹具。最终定向 102/102；普通与真实管理员 WinForms 全套（截图、点击、拖拽、Unicode、滚轮、holdKey、computer_batch）均通过；强制结束属主后 broker 退出。多轮独立审查最终 Approve，无剩余 Critical/Important。

## 2026-11-14 Windows UAC 等待与输入权限提示（2.1.331）

1. 问题：Windows 提权提示会阻塞启动，旧流程没有回合级人工等待，也会在部分输入路径上把 UIPI 拒绝视作已发送。本机鸣潮快捷方式的入口是 `asInvoker`，真正的启动器和游戏主程序声明 `requireAdministrator`。
2. 解决：按 Windows 登录会话检测 UAC，在 Computer Use 持锁期间跟踪 30 秒期限。由用户操作系统提示，超时中止回合并上报原因。提示结束后重新截图才可输入。检查绑定 HWND、全屏键盘前台和鼠标命中窗口的完整性级别。取消会中止启动子进程和重复键盘操作，鼠标清理等用户桌面恢复后再执行。
3. 位置：`src/utils/computerUse/{wrapper.tsx,cleanup.ts,platforms/win32.ts,win32/}`、回合流与 MCP 调度。定向单测 152 项、CLI 版本冒烟和独立复审通过。WinForms 夹具首次通过，后续运行和基线均复现最小化后无法抢回前台。真实 UAC 验证允许后撤下提示、约 30.094 秒终止回合、无后续模型请求、可见停止原因和锁释放。真实提权窗口的绑定输入返回 UIPI，全屏键盘未在提权窗口位于前台时验证。

## 2026-11-13 Playwright 双浏览器与 Computer Use 开关（2.1.330）

1. 问题：内置 Playwright 只有固定无头模式，模型和用户不能选择可见浏览器；Computer Use 没有关闭出口。审查发现模式选择提示词未从 `setup.ts` 导出，新增双服务还必须保留 `DOGE_PLAYWRIGHT_HEADLESS=0` 的旧可见行为。
2. 解决：注册 `playwright`（无头）与 `playwright-headed`（可见）两个真实 Node stdio MCP 服务，共享工具集和 server-wide 权限，保留名与诊断覆盖两者；实际消费模块重新导出模式选择提示，legacy 环境变量保留原服务可见行为并在提示中明确。`DOGE_COMPUTER_USE_MCP` 显式 falsy 时跳过 Computer Use 注册，桌面壳的两个总开关均经真实 `system/init` 验证。
3. 位置：`src/{main.tsx,utils/playwrightMcp/,utils/computerUse/gates.ts,services/mcp/config.ts,services/analytics/metadata.ts}`、对应单测与 `tools/e2e-playwright-mcp.ts`。按要求仅做相关回归：定向单测 26/26，提示词实际导出探针通过，两种服务各 24 个工具的握手、权限与真实浏览器导航/快照通过；App 安装版四种开关场景与双服务进程均通过，独立初审问题全部修复后复审 Approve。`bun run version`=2.1.330，未跑全量回归。

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

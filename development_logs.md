# development_logs.md — Doge Code 开发经验与版本索引

## 2026-11-24 Windows Computer Use 后台单击与原生最小化（2.1.354）

1. 移除按进程名识别游戏并启用真实鼠标和键盘的规则。普通 Win32 窗口的内容单击恢复窗口消息派发。绑定截图返回实时前台状态，后台单击是否生效由目标界面确认。
2. 普通左键单击命中原生标题栏最小化按钮时，直接发送系统最小化命令。150% 缩放且目标不感知 DPI 时，通用标题栏命中查询曾把实际最小化按钮判成最大化。现在用 `WM_GETTITLEBARINFOEX` 查按钮的物理坐标，再将点位换算到收件窗口的坐标系。窗口身份、完整性与桌面仍在派发前核验。

## 2026-11-24 Windows Computer Use 目标查询、截图与 Esc（2.1.352）

1. 首次回合中断前有 58 次 Computer Use 调用、26 个错误，补充消息后的尝试计入后是 76 次调用、31 个错误。合计包括 14 个 PowerShell 超时、13 个目标状态冲突、2 个绑定截图失败、1 个前台激活失败和 1 个未授权目标。部分超时在 60ms 内返回，源日志没有底层 Windows 错误码。窗口枚举、目标命中、进程身份和完整性改用 Win32 FFI，降低对同步子进程的依赖。嵌入窗口仍核验原始进程、根窗口和父子进程关系。
2. 打开授权窗口默认返回第一张图，Windows 批次末尾截图能供下一次输入使用。返回给模型的新截图可在绑定捕获失败后切换到全屏，输入校验维持原坐标系。最小化窗口采用有界捕获和异步原位恢复。WinForms 实机夹具复现过同步后台输入在 6ms 内误报 8 秒超时，后台输入和截图处理迁到异步 PowerShell，并为 Win32 消息确认设置独立时限。Esc 取消独立的 Windows Computer Use 信号，释放锁、清理输入和旧截图，当前对话继续生成。
3. 同机各八次采样，窗口枚举 p95 为 496ms → 3ms，PowerShell 启动次数为 1 → 0。全屏截图从两次 PowerShell 启动减为一次，p95 为 704ms → 485ms。测试涉及本机 Windows 11 x64、单显示器与普通完整性桌面。安装版与相关回归见桌面壳 `development_log.md`。

## 2026-11-22 Windows CU 永久提权授权（2.1.350）

1. 遇到问题：原管理员 PowerShell 助手绑定单个 CLI 进程，每个会话首次操作 High 完整性目标都要在应用授权之后再确认一次 UAC，打断 Computer Use 流程。
2. 解决方法：新增 App 设置显式永久授权：一次 UAC 注册当前用户 + 当前配置目录隔离的最高权限交互式计划任务，CLI 后续按需启动/重连管理员代理；代理闲置 15 分钟退出，会话结束只断开。撤销需再次 UAC 并删除任务与脚本；标准账户与未启用用户保留原单次提权。代理脚本生成抽至 `brokerScript.ts`，请求携带属主 PID + 启动时间，并在动作前打开属主退出监测句柄，永久代理仍监测客户端和属主生命周期；撤销标记阻止撤销期间的新启动/动作，撤销探针区分管道不存在与忙碌，避免并发重连后误报成功。
3. 位置：`src/utils/computerUse/win32/{brokerScript,permanentElevation,elevationCommand,elevatedPowerShell}.ts`、`src/entrypoints/cli.tsx`；测试覆盖用户/配置隔离、真实管理员令牌、无 UAC 停止后重启、跨进程重连与撤销清理，关联 UAC/代理/Windows 语义回归 28 项通过。App 设置页完整启用/撤销黑盒通过。

只保留「不看代码就会再踩」的经验、版本里程碑索引与已知欠账；完整逐轮历史以 `git log` 为准，架构现状见 [docs/DESIGN.md](docs/DESIGN.md)，Computer Use 见 [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md)。**文件名保持 `development_logs.md`**：`src/hooks/useMainLoopModel.ts` 注释引用了「development_logs.md §25 模型切换统一入口」；旧 §25 已并入本文 §1.3（模型目录/协议转换），勿改名。

## 2026-11-22 Windows CU 绑定解绑诊断与截图模式反馈（2.1.348）

1. 遇到问题：绑定窗口后调用 `open_application` 绑定同进程 `#32770` 弹窗，下一次截图变成全屏，模型只能靠 `captureMode: full_display` 事后猜测；旧诊断把“查询时的 captureMode”和“上一张截图的 anchorAgeMs”混在一起，且解绑时没有前台身份，无法判断触发者。排查确认 11:30 那次 UAC 助手进程早于弹窗绑定，不是本次切换的直接原因；11:40 的 7s 调用期间是否有第二次 UAC/新进程仍待日志确认。
2. 解决方法：`unbindWindow` 记录 `reason/at/revision/previous app/foreground`，`prepareWindowsTarget` 排除 `consent.exe`、CU 管理员助手 broker 与自身进程；截图在 capture 前后观察到绑定时返回明确的 release 提示（全屏图/窗口图分别措辞），并把 `captureMode`/`bindingRelease` 写进截图结果；`desktop_info` 拆分为当前 `captureMode`、`lastScreenshot.captureMode/ageMs` 与 `lastBindingRelease`。绑定截图仍禁止回退全屏。
3. 位置：`src/utils/computerUse/platforms/win32.ts`、`src/utils/computerUse/executor.ts`、`src/utils/computerUse/win32/elevatedPowerShell.ts`、`packages/@ant/computer-use-mcp/src/{executor,index,toolCalls}.ts`、`docs/COMPUTER_USE.md`；测试 `win32Semantics.test.ts`、`toolCalls.test.ts`。

## 2026-11-20 Windows CU 框架分类与 Esc 物理链路修复（2.1.347）

1. 遇到问题：绑定模式下 WPF 窗口（AnyCast，`HwndWrapper[Anycast.exe;;…]`）被当成普通 Win32 窗口走 SendMessage，点击全部 `dispatched` 但像素零变化；分类器只覆盖 Chromium/自绘/WinForms。Windows Esc 的旧实现把 `LLKHF_INJECTED` 当作「模型合成」全量过滤，且 hook 回调在键盘 hook 线程里同步 `NamedPipeClientStream.Connect(100)`——IME/键盘映射/远程桌面合成的用户 Esc 会被吞，CLI 主线程执行同步 PowerShell 动作时也可能错过信号；旧测试只验证了 named pipe，未验证真实键盘回调。
2. 解决方法：分类器改为框架能力模型，新增 WPF、WinUI 3/UWP、JavaFX、Flutter、Unreal、Tk，并统一 WinForms 的鼠标/键盘通道；未知框架继续 SendMessage（不抢前台）。Esc helper 的 hook 回调只入队，独立 sender 线程重试命名管道；删除全量 injected 过滤，模型 Esc 由真实输入注入脚本在 `keybd_event` 前写入 3s 期望时间戳（sender 一次性消费；任意 Escape 组合键同样标记），用户注入 Esc 恢复中止；PowerShell 走绝对路径、握手 10s、失败 15s 退避，每次 CU 动作前 `ensureEscHotkey` 复查/重注册；HOOK_INSTALLED 改到消息泵启动后发出。真实键盘注入回归 21/21，WPF 夹具真实点击/按键/生产 Esc 期望 8/8，源码/重编 exe/安装版 CLI 的注入 Esc 均释放锁并中止回合。
3. 位置：`src/utils/computerUse/win32/{windowClassify,escHook}.ts`、`platforms/win32.ts`、`escHotkey.ts`、`wrapper.tsx`、`win32/windowClassify.test.ts`、`tools/computer-use-wpf-fixture-e2e.ts`；邻仓 `tools/check-computer-use-esc-hook.mjs`；`docs/COMPUTER_USE.md`。App 侧仅重编内置 CLI 并升 0.2.265，见 App `development_log.md`。

## §1 可复用经验与坑

### 1.1 headless / SDK 协议

- `initialize` 必须是第一条 stdin 消息，应答与命令清单是双层 `response.response.*`；权限询问走 `can_use_tool`，同一 `tool_use_id` 的重复 `control_response` 必须去重；`--output-format=stream-json` 必须配 `--verbose`（print.ts:825）。
- **事件顺序有语义**：先 drain `task_started/task_progress`，再 `task_notification`，最后 `session_state_changed(idle)`；`idle` 是回合真正结束的权威信号（后台 agent 会延迟 result），宿主别用 assistant/result 猜终态。
- 默认 `-p` 不注册内置 MCP；桌面壳长驻 headless 用 `DOGE_HEADLESS_BUILTIN_MCP=1` 显式开。没有 `onPermissionRequest` 的会话调 `request_access` 返回 `feature_unavailable`，不是空授权成功。

### 1.2 Task / Agent / Workflow

- 终态事件由各 task 实现自己发，`src/tasks/stopTask.ts` 只查活+kill+返回身份；shell 停止要 join `pendingShellKill`，等 OS 回收后再 ACK。
- `task_started` 在 resume 的终态任务重跑时会再次发出，不要把 task_id 当一次性 key；该事件带 `command`/`output_file`。后台输出在系统临时目录（`src/utils/task/diskOutput.ts`），5GB 上限、默认 8MB tail。
- 回合末 closeout（`src/utils/task/backgroundTaskCloseout.ts`）只**提示**主模型处理仍在跑的后台 shell，不自动杀；子任务完成≠临时服务该继续跑。
- Agent 创建时 `captureModelEnvironment()` 快照连接/认证/模型（`src/utils/model/runtimeModelContext.ts`），父会话之后切模不改写已有 worker；profile 被删要显式报错。
- Workflow 是 `local_workflow` 伞任务，跨 API 子步骤子进程要带 `--verbose`/独立 effort，中断续跑走 `checkpoint.ts`；teammate 用 `onStopped` 回传终态，`in_process_teammate` 的 `task_progress.is_idle` 供宿主判占用锁。

### 1.3 模型目录 / 协议转换

- `~/.doge/model-catalog.json` 是唯一事实源；旧 `customApiEndpoint` 只在启动迁移时读一次，之后旧存储里的 model 配置物理删除，**不要再加回退**。
- `/model` 三条路径不可合并：匹配 profile → 原子切连接+模型；档位别名 → 当前连接内解析；裸模型名 → 只写 AppState。默认会话级，`--save`/`DOGE_MODEL_SCOPE=global` 才持久化；档位别名始终只作用会话。
- 主模型解析单入口 `resolveMainLoopModel`：`mainLoopModelForSession > mainLoopModel > 默认设置`；**不要把 `customApiStorage.model` 加回链**（写延迟导致状态栏/请求错位，原 §25 根因）。`[1m]`/`[2m]` 只本地剥离，密钥不得进入模型身份/日志。
- 双密钥在 settings env 落地后裁决（`src/utils/apiKeyExclusivity.ts`），只认激活 profile 的 `authTokenType`；不要按「key 更新/更长」猜。
- effort 由 catalog `ReasoningPolicy` 决定 wire 字段，网关不支持必须 `downgraded` 且 UI 标 `applied`；400 后按「连接+provider+baseURL+模型」路由键进程内禁用该 policy。三协议图片/tool-result 配对是高频回归点（2.1.307），只 keep-alive 的空 SSE 流要设上限。

### 1.4 Computer Use / Windows

- 坐标三条铁律：Windows 命中前必须启用并验证 **Per-Monitor-V2** 再调 `WindowFromPoint`（否则空命中让模型重试到 64+ 次，2.1.336 根因不是 UIPI）；绑定窗口 origin=(0,0) 与全屏两空间，真实输入只加一次 `GetWindowRect` 偏移，`switch_display` 显式解绑并清锚点；输入/zoom 前比较 `boundRevision`、截图返回前复核，迟到旧图不得覆盖新锚点。
- UAC 永远由用户处理：检测到即起 30 秒期限（`src/utils/computerUse/win32/uacWait.ts`），超时中止回合并上报，提示后必须重新截图；只有高完整性目标才请求管理员 PowerShell 助手（命名管道+属主校验），普通目标切回本地。永久授权只从 App 设置显式启用/撤销，计划任务按用户 + 配置目录隔离；永久代理解绑 CLI 属主生命周期，但每个动作仍校验客户端和请求属主，会话退出不得停止其他会话正在共用的代理。
- SendMessage 不是通用协议（Chromium/自绘忽略）；bound HWND 的直接文本必须走真实 Unicode `SendInput + KEYEVENTF_UNICODE`（stdin base64 传文本），不要回后台 `WM_CHAR`；双/三击同一脚本完成，系统 click count 会出现 `1,2,1`。
- 身份 fail-closed：完整 exe 路径、可信宿主（真实父/根关系+祖先链）、deny 优先、未知前台拒绝；窗口 owner 不是安全边界；便携 exe 用自身目录为 cwd。
- 验证只看 UI/像素/独立 `GetCursorPos`，不看「已派发」文案。

### 1.5 浏览器 / Playwright / MCP

- Playwright 在 Bun 下无法驱动浏览器（pipe/WS 传输均超时），内置浏览器 MCP 必须是 **Node stdio 子进程**；没有 Node 时不注册假服务。
- `playwright`（无头）/`playwright-headed`（可见）会话独立；桌面镜像链路是 App 注入 `DOGE_APP_PLAYWRIGHT_BRIDGE`、CLI 只把脚本前置到**无头** argv，bridge 在 App 侧拉起无头浏览器并以 `--cdp-endpoint` 接管，headed 不挂桥。
- 内置 Playwright 用服务级 `mcp__<server>__*` allow 规则，不硬编码上游工具名；浏览器类请求优先 Playwright，显式桌面窗口/原生对话框才用 CU。

### 1.6 构建 / 发布

- 本仓库无构建产物，Bun 直跑 TS；改 `packages/@ant/*` 或 `shims/*` 后必须 `bun install`，否则单测过而 CLI/e2e 跑旧副本；桌面壳重编内置 CLI 前同样先刷新 CLI file: 依赖并记录对应 CLI commit。
- 版本号只在产品/安装包轮递增（纯文档轮不递增、不复用）；提交用简短祈使句；`ANT-ONLY import markers must not be reordered` 的 import 禁止重排。

### 1.7 测试 / 隔离

- 裸 `bun test` 暴露共享进程交互，`bun tools/run-isolated-tests.ts` 每文件独立进程+独立 `CLAUDE_CONFIG_DIR`；二者互补，隔离器通过不能替代裸测。
- 环境变量是最大污染源（CONFIG_DIR/BASE_URL/PROVIDER/双密钥/OAuth/RETRY/TERM_PROGRAM/模型 env），测试显式隔离；模型测试要同时 reset `runtimeModelContext`/`managedEnv`/config cache/`getAutoMemPath.cache`，`beforeEach` 与 `afterAll` 都做。
- 全局 `mock.module()` 会污染后续文件（withRetry 分类、sdkEventQueue 导出、OAuth FD token 泄漏都发生过），优先真实模块+局部 fixture；`saveGlobalConfig` 是合并更新，清字段用 `= undefined`。
- `file:` 依赖是静态副本；Bun `spawnSync.timeoutMs` 无效（用 Node `spawnSync.timeout`）；真实 UI 验证要等 boot 首标签、真实键入通道；产物只进 `test/` 并清空。

### 1.8 数据 / 密钥

- 全局 `~/.doge`、项目 `<项目>/.doge/`；唯一读写 `.claude/` 的三处例外是 IDE lockfile、doctor 检测、沙箱 deny-write，不要新增。凭证/目录 `0600`/`0700`，配置备份剥离明文 key。
- `cleanupPeriodDays` 只清旧 `.jsonl/.cast`、tool-results、plans、file-history 等目标；`projects/**/memory/` 与会话转录是用户数据，**不可当垃圾全删**。
- `computer-use.lock`、`im-remote*.json`、team inbox、task 输出可能含敏感内容；调试脱敏（IM 扫码 URL 记日志必须 `redactWebUrl`）。

### 1.9 勿回退清单（历史事故）

- IM：`localhost Bun.serve` 必须 try/catch；`onStopped` 是终态通道；wecom 出站 ack `req_id` 是透传值；配对按平台隔离（`pairs`/`allowedUsersByPlatform`/`outboundChats` 每平台一份）；`bindChat` 门后绑定并持久化；主地址排序经 `nicPriority`，勿回退 `networkInterfaces` 原序。
- Auto：只标记从 bypassPermissions 进入的 Plan；手动 Plan 保留交互；ExitPlan 自动回 Auto；切其他模式清 `prePlanMode/autoPlan`；自动执行/收尾禁止 AskUserQuestion。零询问语义不可回退**只隐藏卡片不够**（CLI 会继续等）：必须由 CLI 权限层真拒绝并注入动态提示词；`AUTO_QUESTION_TIMEOUT_MS=300000` 内单次人工询问期，无「(推荐)」取首项、多选全取推荐，答案带 `_autoQuestionAnswerSource`；禁止伪造用户同意（提交/合并/危险操作不下发）；切回 Auto 要撤销仍在活跃/排队的过期问题；Elicitation 走同一自动应答并经过 hooks/schema。
- CU：以 `computer-use.lock` 为 UI 真值，不用 assistant/result 猜；子代理不启动 CU 会话；不全局广播 Esc。
- 模型/测试：不给 tmux 队友命令行加认证密钥；不把 `customApiStorage.model` 加回主模型链；不改 `tools/` 脚本求绿；不用新 key 绕过本应 storage 自愈的测试。

## §2 版本里程碑索引

### 2.1 2.1.34x 近期

| 版本 | 里程碑 |
|---|---|
| 2.1.340 | 中断的 headless 回合显式上报 |
| 2.1.343 | Browser Use 路由到指定浏览器并保留 shell 工具 |
| 2.1.345 | 模型目录/思考策略回归修复（目录默认档、输出上限、Responses 思考、重试显示）；桌面壳 headless Playwright bridge + `task_started` command/output_file |
| 2.1.347 | Windows CU 框架分类（WPF/WinUI/JavaFX/Flutter/Unreal/Tk）与 Esc 物理链路修复 |

### 2.2 更早区间（每行一个主题群，细节 `git log`）

- **2.1.261（2026-09）**：设定真实版本；完成 `.doge` 项目资源隔离、双密钥互斥、session 级模型切换、Auto 模式、内置 CU 常开与内置 Playwright MCP。
- **2.1.264–2.1.274**：IM 远程控制（多频道、配对按平台隔离、bindChat 持久化、飞书长连接）。
- **2.1.276–2.1.287**：`/shell` 解释器切换；声明式 Workflow（MD 即命令、跨 API 子进程步骤）；Auto 零询问/自动规划；Workflow 使用量与 session 历史修复。
- **2.1.292–2.1.298**：MCP/工作流边界、keep-alive SSE 上限、图片容器校验、gateway usage 防通胀、三协议 4xx 恢复、SF 工具块清洗。
- **2.1.299–2.1.306**：图片路径粘贴修复；workflow 中断/可恢复；主会话自主 closeout；模型 profile 路由与 worker 上下文隔离。
- **2.1.307–2.1.313**：OpenAI tool-result 图片顺序修复；effort 能力矩阵；模型会话保护/agent 解析统一；`/clear` 保留配置；中断消息事务化编辑。
- **2.1.314–2.1.317**：Auto 提问限 Plan、TUI 布局与历史滚动、Windows 剪贴板编码、移除旧 `.doge` 路径兼容；headless 自动记忆恢复；OpenAI web search/fetch 兼容；Windows CU Esc 生命周期。
- **2.1.319–2.1.330**：CU 可靠性/Unicode/DPI/应用激活/便携应用/双坐标空间/全屏解绑；Playwright 双服务 + CU 开关。
- **2.1.331–2.1.339**：Windows CU UAC 30s 等待、管理员助手、通用宿主解析、Per-monitor-V2 命中、新进程接管/坐标代际、窗口身份与清理、27 工具与点击时效。

## §3 已知欠账 / 待验证

1. **macOS CU 实机**：`@ant/computer-use-swift` 为 shim（空白截图、TCC 恒 false），macOS CU 不可用且未实测。
2. **Windows 受限场景**：无管理员账户、受限令牌/低完整性、混合 DPI 多屏、UAC 后仍提权窗口的绑定输入未覆盖。
3. **旧 catalog 迁移遗留**：只覆盖 `customApiEndpoint` 的 `modelProfiles`/`model`；同名 provider 重复由 `dedupeModelProfiles` 兜底，手工异常 catalog/`settings.model` 残留未逐一实测。
4. **恢复缺口**：`src/server/`（server/sessionManager/backends）与 `src/ssh/` 端到端未通；`server`/`ssh`/`open` 属设计保留面。
5. **Playwright 镜像**：依赖 App 侧 `bridge.cjs` 与 `DOGE_APP_PLAYWRIGHT_BRIDGE`，CLI 只透传；无 App 不能验证镜像链路。
6. **IM**：Telegram/飞书/企业微信真实账号长连接、扫码网页频道的防火墙/多网卡排序仍需安装版实测。
7. **其他**：Linux CU 尚未支持 Wayland；本树 ANT-ONLY 面（`up/rollback/task/log/error/export` 等）不注册；SDK 运行时在外部包。

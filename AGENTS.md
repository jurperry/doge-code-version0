# AGENTS.md — Doge Code 仓库指南

本文件面向 AI 编码代理（Claude Code / Doge Code 等），假设读者对本项目一无所知。所有内容均基于对当前仓库的实际核实，不要凭空假设。

## 项目概述

**Doge Code**（`@doge-code/cli`）是 Claude Code 的第三方 Fork：基底是从 source map 逆向还原的 Claude Code 源码树，在此之上做了自主魔改，聚焦多提供商 API 兼容与自托管接入。它不是官方上游镜像，行为与官方 Claude Code 存在差异。

核心定位：

- 支持自定义 Anthropic 兼容接口地址与 API Key
- 通过中间转接层支持 OpenAI Chat Completions 与 OpenAI Responses 两种 API 格式（协议级转换，**实验性功能，不完全稳定**）
- 自定义模型与模型档案（ModelProfile）管理
- 与原版 Claude Code 数据隔离：默认配置目录为 `~/.doge`（全局配置文件 `~/.doge/.claude.json`），可用 `CLAUDE_CONFIG_DIR` 覆盖；不要与 `~/.claude` 混用
- 项目级 settings 同样隔离：doge 读写 `<项目>/.doge/settings.json` 与 `<项目>/.doge/settings.local.json`，**不读取** `.claude/settings*.json`（避免被官方 Claude Code 的残留配置注入 env/权限）
- **项目资源目录完全隔离（创始原则，2026-09-05 起全面生效）**：agents/skills/commands/rules/worktrees/agent-memory/定时任务等一切项目级资源一律使用 `.doge/` 下的对应目录（如 `<项目>/.doge/agents/`、`.doge/skills/`、`.doge/commands/`、`.doge/rules/`、`.doge/worktrees/`、`.doge/scheduled_tasks.json`），**代码不读也不写任何 `.claude/` 路径**。嵌套项目记忆为 `.doge/CLAUDE.md`；根目录 `CLAUDE.md`/`CLAUDE.local.md` 文件名约定保持不变（跨工具记忆文件）。唯二例外（有意保留的官方互操作）：`src/utils/ide.ts` 读取官方 VSCode 扩展的 `~/.claude/ide` lockfile、`src/utils/doctorDiagnostic.ts` 检测官方安装，均不涉及 doge 配置
- 全局命令名为 `doge`（非 `claude`）

关键 Fork 修改一览：

1. **认证绕过**：使用自定义提供商（`openai`/`responses` 或非官方 Anthropic URL）时跳过密钥审批流程（见 `src/utils/auth.ts`）
2. **OpenAI 协议转换**：`openaiCompat.ts` 和 `responsesCompat.ts` 在 API 边界做完整协议翻译
3. **ModelProfile 持久化（provider 为中心，2026-09-07 重构）**：`customApiStorage.ts` 支持每 provider 保存完整的 providerName/provider/baseURL/apiKey/contextWindow/三档位模型 配置；`/provider` 表单第一步为 **Provider name**（如 "deepseek官方"、"glm官方"，必填且全局唯一，重复会被拒绝；存量无名称 profile 兼容显示），选择器/列表中每个 profile 一行；**身份键 = providerName（2026-09-11 修复同名重复 bug）**：`isSameProviderEntry`（两侧都有名按名、否则按模型）统一了冲突豁免（`findProviderNameConflict` 的 self）/upsert（`upsertModelProfile` 的 self，编辑改名+改模型原地替换，并把被换条目的旧模型名清出 savedModels，否则 /provider 菜单留幽灵行）；`readCustomApiStorage` 读时归一（`normalizeCustomApiStorageData`：按名去重，激活者胜否则后写胜）+ 启动迁移 `migrateDuplicateProviderProfiles`（cli.tsx，须 `--help` 这类完整启动链才跑，`--version` 快速返回不经过）物理修复两份存储并把 `.claude.json` 镜像的 profiles/savedModels 对齐权威源（镜像自身无重复时快速返回，不清孤儿——孤儿只在权威源去重后产生，必须跨文件对齐）；测试 `provider-storage.test.ts` + `customApiStorage.test.ts` + `test/e2e-provider-identity.ts`（进程内 Ink 渲染表单 + fake stdin，真值走磁盘；**别用 NODE_ENV=test**——saveGlobalConfig 在 test 下写内存桩不落盘，镜像断言假失败）；`/model` 列表里第三方模型右侧显示 `Custom model(<providerName>)`，选中即整体切换到该 provider（模型+凭证+档位+上下文窗口，P1 路径 `switchModelProfileAtomic`，会话级隔离同条目 8）。**档位（opus/sonnet/haiku）切换一律会话级、永不持久化**：`switchTier` 只写本进程 `mainLoopModelForSession`；旧的 `activeTier`/`tierModels` 全局持久化已废弃（曾把一个终端选的档位强加给所有终端/新启动，表现为别的终端冒出来路不明的 "Custom model"），启动时 `restoreTierState` 仅从激活 profile 的档位字段注入 `ANTHROPIC_DEFAULT_*_MODEL` env 且**绝不**改写 `ANTHROPIC_MODEL`，遗留字段由 `clearLegacyTierState()`/启动迁移抹除。**Default（recommended）语义**：= 当前 provider 的 sonnet 档模型，未配置 sonnet 档则回落该 provider 主模型（`resolveSessionDefaultModel` 单一实现：env sonnet 档 → 激活 profile 的 sonnet 字段 → env `ANTHROPIC_MODEL` → 磁盘基线，激活 provider 永远压过磁盘基线——2026-09-07 修复：`/model` 选 Default 后的提示消息同用该解析，此前读磁盘顶层 model 导致「切到 kimi 后提示 Set model to deepseek」的滞后错位；档位解析 `resolveTierModel` 同序修正，避免基线档位模型名发给激活 endpoint）；`/model <tier> --save` 不持久化档位（提示走 /provider 改档位配置）。Doge Code 桌面壳的 provider 下拉直接读写本存储（与 /provider 互通）
4. **Agent 模型 fallback**：模型等级不够时自动回退
5. **Computer Use Windows（默认启用）**：HWND SendMessage + SendInput fallback，四层应用发现。fork 已解闸全部官方门控：`gates.ts` 的 `getChicagoEnabled()`/`hasRequiredSubscription()` 硬编码 true，`config.ts` 的 `isDefaultDisabledBuiltin` 恒 false（`computer-use` server 默认连接，仍可经 `/mcp` 禁用）；`main.tsx` 注入 CU MCP 时无条件 append 本地使用提示 `COMPUTER_USE_MCP_PROMPT_HINT`（官方端点的服务端提示在第三方/转接端点不存在）。macOS/Windows 交互式会话默认生效。**输入前置卫兵（2026-09-09）**：Windows 所有输入动作先过 `guardBoundWindow`（`platforms/win32.ts`）——检查 IsWindow/前台归属 → 窗口死亡先按 PID/进程名找替身窗口重绑 → 真实输入路径经 `ensureWindow`（`win32/windowGuard.ts`，单条 PowerShell 内完成恢复最小化 + AttachThreadInput 前台锁绕行 + ALT 微扰 + 重试校验，root-owner 级前台比对）→ 校验通过才发输入，否则抛面向模型的错误（指引 open_application/截图/请用户恢复）；SendMessage 路径只做存活检查（后台安全）。`apps.open()` 对已运行应用优先绑定既有窗口（进程名/标题匹配 + 尽力置前），启动链含 App Paths 分支，失败抛错（不再静默）。**应用枚举（同日）**：`win32/installedApps.ts` 五阶段并行枚举（注册表/App Paths/快捷方式单 COM/Get-StartApps/运行中窗口，窗口标题进 extraPaths 参与解析）+ 单飞缓存，实测 658 应用 1.3s（旧单脚本 15s 必超时 → request_access 全部 not_installed）；`mcpServer.ts` win32 枚举提示超时 8s（原 1s 恒超时 → 工具描述应用名提示恒空）；`appNames.ts` win32 分支（系统目录排除制 + `ALWAYS_KEEP_WIN32_EXE_BASES`）。**自绘窗口通道 + 拖拽（2026-09-09 二轮）**：`win32/windowClassify.ts` 按顶层+子窗口类名识别 Chromium vs 自绘框架（Qt`\d*QWindow*`/SDL/GLFW/Unity/SunAwt——Android 模拟器即 Qt）——自绘窗口的鼠标+键盘一律走真实输入（前台卫兵保护），因 SendMessage 鼠标/键盘对自绘表面是应用层空操作（adb getevent 0 触摸）；InputPlatform 新增 `mouseDown/mouseUp/drag`，拖拽为单条 PowerShell 的 down→缓动帧→up 整手势（真实输入版 `sendInputDrag` + WM 版 `windowMessage.sendDrag`），修复 executor 把 press/release 映射成完整点击导致 drag=3 次点击的旧错。坑：JS 模板字符串里的 PS 注释含 `E:\Git\usr\bin` 之类裸路径会因 `\u` 非法转义炸整文件。见 `src/utils/computerUse/`、`test/computer-use-e2e.ts`、`test/e2e-cu-input-guard.ts`、`test/e2e-cu-emulator-input.ts`、`debug_updates_6.md`
6. **PTL 错误映射**：Anthropic/OpenAI 格式的上下文溢出错误 → 统一 reactive compact
7. **/auto 与三态模式循环**：TUI 内 `/auto`（支持 `[on|off]`）直接切换 bypassPermissions，Shift+Tab 在 auto → accept → plan 间循环（default 下首次按即进 auto），无需 `--dangerously-skip-permissions`。刻意不改 `isBypassPermissionsModeAvailable`（保持"旗标启动会话"语义，不把 bypass 继承等副作用泄漏进 /auto 会话）。**auto 会话的全放行语义（2026-09-09）**：共享判定 `isAutoBypassActive`（`src/utils/permissions/autoBypass.ts`，mode===bypassPermissions，或 plan 且 prePlanMode===bypassPermissions/旗标会话）供中央管道与 CU 接缝共用——① auto 会话里模型 EnterPlanMode 进入 plan 模式后工具（list/grep/bash 等）依旧全放行（`permissions.ts` 2a 步用该判定；deny 规则、显式 ask 规则、safetyCheck 与 requiresUserInteraction 工具仍在 1a-1g 步先行，**ExitPlanMode 的计划审批框保留**，auto 也不放行）；② CU 的 `request_access` 授权对话框在 auto 会话直接自动全授权（`wrapper.tsx` runPermissionDialog 入口短路，`autoGrant.ts` 镜像对话框 Allow 语义：resolved 应用全授权、tier 由包内回填、未安装拒 not_installed、truthy flags 授予；tccState 缺 OS 权限分支仍弹窗）；③ plan 审批（`ExitPlanModePermissionRequest`）：审批框**罗列全部执行模式由用户选择，auto 不代选也不放行该选择**——auto 会话首选项 "Yes, and stay in auto mode"（值 `yes-auto-mode-keep-context` → bypassPermissions），其后并列 "Yes, and auto-accept edits"（值 `yes-accept-edits-keep-context` → acceptEdits，**用户选了就落 acceptEdits，不因 prePlanMode 自动改映射**）与 "Yes, manually approve edits"；普通会话默认首选项仍为 auto-accept edits，bypass 未禁用**且**非旗标会话时追加 "Yes, and use auto mode"（同值 `yes-auto-mode-keep-context`）与 clear-context 变体（值 `yes-bypass-permissions`）；clear-context 的 `yes-accept-edits` 恒落 acceptEdits；空计划路径（本就无模式列表）审批后恢复 auto 防降级；Shift+Tab 选中首选项（auto 会话即"保持 auto"）。模式解析集中 `resolvePlanApprovalMode`（旗标会话的 bypass 选项沿用上游 `yes-accept-edits-keep-context` 映射，受 `isBypassPermissionsModeDisabled()` 约束）。见 `src/commands/auto/`、`src/utils/permissions/{getNextPermissionMode,autoBypass}.ts`、`src/components/permissions/ExitPlanModePermissionRequest/`
8. **会话级模型切换（多终端隔离）**：`/model` 切换默认只作用于当前进程（改 `process.env` + AppState 的 `mainLoopModelForSession`），**不写任何磁盘配置**（`.claude.json`/`settings.json`/`.credentials.json` 全部保持基线），多个终端并行使用互不影响；`/model <model> --save` 显式固化为全局默认，`DOGE_MODEL_SCOPE=global` 恢复旧的"切换即持久化"行为（档位别名例外：opus/sonnet/haiku 在两种 scope 下都只进会话槽位，见条目 3）。`/model` 选择列表：档位行只从当前 provider 解析（env || 激活 profile 字段，不再读全局 tierModels 快照），其余 provider 各一行带名称。见 `src/utils/model/modelSwitchScope.ts`、`src/commands/model/handlers.ts`、`src/utils/model/switchModelProfile.ts`（deps.sessionScoped）、`src/state/onChangeAppState.ts`（settings.json 写入 gate）、`src/utils/model/modelOptions.ts`（选择列表）、`src/utils/model/restoreTierState.ts`（启动恢复）
9. **agent-teams TUI（多代理面板）**：TUI 底部常驻 `main-<模型>` 行，每个子代理一行 `sub-agent-<模型>-<任务描述>`（`CoordinatorTaskPanel`，原 ant-only 面板解闸）；`Ctrl+Shift+A` 聚焦/取消 agent 列表，↑↓ 导航、Enter 切换到对应 agent 的执行视图（transcript）、`x` 停止/清除、Esc 返回，鼠标点击行同样可切换。子代理模型名在 spawn 时由 `getAgentModel` 解析并写入 `LocalAgentTaskState.model`。内置 Explore/Plan 子代理已在 `src/tools/AgentTool/builtInAgents.ts` 强制启用（源码运行下 `feature()` 恒 false 的兜底）。teammate 群聊模式（队长/成员直连通信）保持运行时开关：`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 或 `--agent-teams` 启动。见 `src/components/CoordinatorAgentStatus.tsx`、`src/hooks/useGlobalKeybindings.tsx`
10. **双密钥类型严格区分（DOGE_API_KEY / ANTHROPIC_AUTH_TOKEN）**：两者是仅有的两种密钥接入方式，差异在发送语义——`DOGE_API_KEY` → SDK `apiKey` → `x-api-key` header；`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer` header（`client.ts configureApiKeyHeaders`）。`ModelProfile.authTokenType` 记录每个 provider 用哪种，`/provider` 表单有 "Key type" 选择步骤，`/provider list` 展示；`applyModelProfile` 按类型互斥写 env（写一个删另一个）。两者同时泄漏进 `process.env`（shell 残留 / settings env 块）曾导致双 header 矛盾 401：现在 `enforceApiKeyExclusivity`（`src/utils/apiKeyExclusivity.ts`）在 `managedEnv.ts` 两个 apply 入口末尾收敛为互斥（激活 profile 声明 Bearer 且 key 匹配则保留 AUTH_TOKEN，否则 DOGE 优先），`configureApiKeyHeaders` 在 DOGE 存在时跳过 Bearer 作为最后防线；`ApiKeySource` 区分 `'ANTHROPIC_AUTH_TOKEN'` 来源（errors/statusNotice/auth status 相应适配）。多终端场景下卫兵只改本进程 env，不影响并行终端。
11. **项目目录命名 v2 编码（2026-09-06，消除歧义）**：`~/.doge/projects/<encoded-cwd>` 的目录名由 v1（所有非字母数字→`-`，`E:\a-b` 与 `E:\a\b` 同为 `E--a-b`，外部软件无法反解真实路径）改为**可逆编码**：路径分隔符 `\`/`/` → `~`；`~` 本身 → `%7e`；其余非字母数字按 UTF-8 字节转 `%xx`；`[a-zA-Z0-9-]` 字面保留。例：`E:\ClaudeCode\doge-code` → `E%3a~ClaudeCode~doge-code`（名字里的连字符不再与分隔符混淆）。>200 字符截断 + `-<hash>` 后缀逻辑与 v1 相同（Bun.hash/simpleHash 双实现，读取端前缀扫描兜底）。实现集中在 `src/utils/sessionStoragePortable.ts`（`sanitizePath`/`legacySanitizePath`/`sanitizePathCandidates`/`decodeProjectDirName`/`findProjectDir`）。**兼容策略：写永远用 v2，读同时认 v1**——`findProjectDir` 先试 v2 再试 v1；resume 续写绑定的 `sessionProjectDir` 来自实际文件路径，所以旧会话恢复后继续留在 v1 目录、新会话落 v2 目录（同一项目两个目录并存是预期过渡态，Doge Code 桌面壳按 jsonl 内 cwd 合并显示）；auto-memory（memdir）优先复用已存在的 v1 memory 目录以免记忆"重置"；bridgePointer 读取/清理遍历两种候选名；`vcr.ts` 的 cwdSlug 脱水替换两种编码。测试：`src/utils/sessionStoragePortable.test.ts`（单测 25 例，含迁移）+ `test/e2e-project-dirs.ts`（编码/兼容沙箱 E2E 6 项）+ `test/e2e-migrate-projects.ts`（启动迁移 E2E 4 项，`--help` 走完整启动链）。**存量数据自动迁移**：`migrateLegacyProjectDirs()`（同文件）在 `src/entrypoints/cli.tsx` 通用路径（main import 之前）每次启动执行——v1 目录按「最新 jsonl 头部 cwd」恢复真实路径后原子 rename 成 v2 名；目标已存在则逐文件合并（同名冲突 newest-mtime 胜、输家删除、源目录收尾 rmdir）；无 jsonl 可恢复 cwd 或目录被活会话锁定（Windows EPERM）→ 跳过下次重试；幂等（v2 名含 `~` 直接跳过）。并发安全靠 rename 原子性 + ENOENT 容忍。2026-09-06 已对本机真实 ~/.doge 执行：2 改名 1 跳过（memory-only 目录）。`cachePaths.ts` 的缓存目录命名是**刻意独立**的 djb2 副本，未随之改动
12. **内置 Playwright MCP（默认激活，2026-09-08 新增）**：上游只有 WebFetch/WebSearch 这类纯 HTTP 调用，拿不到 JS 渲染后的页面、无法点击/登录/填表，大片网页因此不可达。fork 内置了 `@playwright/mcp`，但**它不是进程内 server，而是 spawn 一个 Node 子进程走 stdio** —— 原因见下面的「Bun 坑」，这是本条最要紧的知识。实现：① `setupPlaywrightMCP()` 往 `dynamicMcpConfig` 塞一条 `type:'stdio'` + `scope:'dynamic'` 的真实配置（`command` = 找到的 Node，`args` = `@playwright/mcp` 的 `cli.js` + `--browser/--headless/--isolated/--output-dir/--executable-path`）；② 把 `mcp__playwright__*` 加入 `allowedTools` 免权限弹窗。实现在 `src/utils/playwrightMcp/{common,command,setup}.ts`，注入点 `main.tsx`（CU 块之后，仅交互式会话），保留名拦截见 `config.ts` 的 `addMCPServer` 与 `main.tsx` 的 `--mcp-config` 校验，埋点白名单见 `services/analytics/metadata.ts` 的 `BUILTIN_MCP_SERVER_NAMES`。**坑 1（Bun，最关键）**：Playwright 在 Bun 下**根本连不上浏览器**，两条传输路径都超时，而同样的代码在 Node 下都正常（本机实测矩阵）：

   | 传输 | Node | Bun |
   |---|---|---|
   | `--remote-debugging-pipe`（fd 3/4） | ✅ | ❌ 超时 |
   | `--remote-debugging-port` + WebSocket | ✅ | ❌ 超时 |

   Bun 能 `fetch()` 通 CDP 的 HTTP 端点，挂的是管道/WebSocket 传输层。doge 跑在 Bun 上，所以**必须**用 Node 子进程；改回 in-process 会直接复现「navigate 超时 180s」。**坑 2**：`allowedTools` 必须手工拼 `mcp__<server>__*` —— `buildMcpToolName()` 会把通配符 `*` 规范化成 `_`，生成匹配不到任何工具的死规则。**浏览器来源**：默认**复用系统已装的 Chrome / Edge**（`detectSystemBrowser()` 按平台探测常见路径 → `--executable-path`），零下载开箱即用。别指望"以前装过 @playwright/mcp 就能用"：旧版会自动下载一批 `mcp-chrome-<hash>`（本机已攒 8 个、几百 MB），但那是按它自己的版本 hash 命名的，跟 playwright-core 绑定的 chromium 修订版（当前 **1243**）互不相认，换版本就得重下。机器上一个浏览器都没有、或没有 Node 时才需要 `bunx playwright install chromium`（没 Node 则整个 server 不注册）；`DOGE_PLAYWRIGHT_EXECUTABLE_PATH` 可强制指定、`DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER=0` 关探测改用自带版本。浏览器仍是**首次工具调用时懒启动**；产物写 `os.tmpdir()/doge-playwright-mcp`（上游默认 `<cwd>/.playwright-mcp`，污染用户项目）。可用 `/mcp` 禁用或 `DOGE_PLAYWRIGHT_MCP=0` 关闭。**有头 / 无头**：默认无头（传 `--headless`）；`DOGE_PLAYWRIGHT_HEADLESS=0` 则拉起真实窗口，配 `--isolated` 用独立临时 profile，不碰用户现有 Chrome 的窗口与登录态，手动关掉后下次工具调用会重开。**坑**：`.doge/settings.json` 里的 `env` 对 Playwright **无效** —— `applyConfigEnvironmentVariables()` 在 `main.tsx` 的 2020/2628/2650 行，晚于 `setupPlaywrightMCP()`（1671 行），注入时机在读取之后；只能用进程环境变量，而且 MCP server 在启动时 spawn，**改完必须重启 doge**（会话内 `/mcp` 重连会用同一份 argv，不起作用）。测试：`src/utils/playwrightMcp/{command,setup}.test.ts`（单测 16 例）+ `test/e2e-playwright-mcp.ts`（真实 spawn + 24 工具 + 权限通配覆盖 + 真开 example.com 取快照）

## 技术栈与运行时

- 语言：TypeScript（ESM，`"type": "module"`），React JSX（`react-jsx` 转换）+ Ink 实现 TUI
- 运行时：Bun ≥ 1.3.5（`packageManager: bun@1.3.5`），Node.js ≥ 24
- 依赖锁定：`bun.lock`（根目录同时存在 `package-lock.json`，但以 Bun 为准）
- `tsconfig.json`：target/module ESNext，`moduleResolution: bundler`，`strict: false`，路径别名 `src/*` → `./src/*`
- `bunfig.toml`：定义编译期常量 `BUDDY = "true"`

## 构建与运行命令

本仓库没有打包构建产物，直接以 Bun 运行 TypeScript 源码：

```bash
bun install                # 安装依赖（含 shims/ 下的本地 file: 包）
bun run dev                # 启动 CLI/TUI（入口 src/bootstrap-entry.ts）
bun run start              # 同 dev
bun run version            # 输出版本号，用于冒烟验证 CLI 可启动
bun run dev:restore-check  # 启动 src/dev-entry.ts，检查缺失 import（恢复期工具）
bun link                   # 注册全局 doge 命令（包名 @doge-code/cli）
```

`package.json` 中**没有** `lint`、`test`、`build` 脚本。源码级更新流程：`git pull && bun install && bun link`。

## 测试策略

- 测试框架：`bun:test`（`import { test, expect } from 'bun:test'`），运行 `bun test`
- 项目自身测试与代码同目录放置（`*.test.ts`），目前位于 `src/services/api/`、`src/services/mcp/`、`src/commands/model/`、`src/commands/provider/`、`src/utils/model/`、`src/utils/playwrightMcp/`、`src/utils/computerUse/`（autoGrant/appNames + `win32/` windowGuard/windowClassify/installedApps）、`src/hooks/`、`src/utils/`（sessionStoragePortable.test.ts）下；另有实机 e2e 脚本 `test/computer-use-e2e.ts`（Computer Use 只读链路验证）、`test/e2e-cu-input-guard.ts`（CU 输入前置卫兵 + 应用枚举/request_access 解析实机验证，会短暂开关并激活一个 notepad，自带沙箱清理）、`test/e2e-cu-emulator-input.ts`（CU 对 Android 模拟器/Qt 自绘窗口的点击拖拽实机验证，adb getevent 断言触摸到达，缺模拟器/adb 时 SKIP）、`test/e2e-playwright-mcp.ts`（内置 Playwright MCP 进程内连接 + 工具集 + 权限通配覆盖）、`test/e2e-project-dirs.ts`（项目目录 v2 编码 + v1 兼容读取，可重复运行、自带沙箱清理）、`test/e2e-model-picker.ts`（/model 列表 provider 命名 + 档位隔离渲染）、`test/e2e-tier-session-switch.ts`（档位会话级切换 + Default 语义 + 遗留状态清理，均可重复运行、自带沙箱清理）
- 注意：裸跑 `bun test` 会连带执行 `needs/skills/claude-to-im/node_modules/` 里 vendored zod 的测试（实测共 22 个文件、约 250 个用例）；只跑项目测试时用路径过滤，如 `bun test src/services/api/`
- 已知既有失败（截至当前提交，非本次改动引入）：`src/hooks/useMainLoopModel.test.ts` 中 `does not fall through to customApiStorage when AppState fields are null` 用例失败
- 新增测试应放在被测模块旁边，以模块或被测行为命名
- 除单测外，改动后用 `bun run version` 冒烟 + `bun run dev` 手动验证受影响路径
- 测试产物（临时脚本、图片、视频、样例文件等）统一写入项目 `test/` 目录，测试结束后的清理要求见下方「开发纪律」

## 代码组织

入口与核心：

- `src/bootstrap-entry.ts` — CLI 入口（`bin.doge` 指向它）
- `src/main.tsx` — 主应用 UI 组件（约 808KB 超大文件，修改需格外谨慎）
- `src/commands.ts` — 命令路由表
- `src/interactiveHelpers.tsx` — 交互模式辅助
- `src/query.ts` / `src/QueryEngine.ts` — 查询处理引擎
- `src/Task.ts` / `src/Tool.ts` — Task 与 Tool 抽象

主要目录：

| 目录 | 用途 |
|------|------|
| `src/commands/` | 所有 `/` 斜杠命令实现，每命令一个 kebab-case 目录 |
| `src/components/` | React/Ink TUI 组件 |
| `src/services/` | 业务逻辑服务（API、Compact、MCP、LSP 等） |
| `src/tools/` | 内置 Tool 实现（BashTool、FileEditTool、AgentTool 等） |
| `src/skills/` | 内置 Skill 系统（含 `bundled/debug.ts` 即 `/debug` 技能） |
| `src/utils/` | 工具函数（认证、配置、模型、调试、ComputerUse 等，详见下文） |
| `src/bridge/` | 远程桥接与会话管理 |
| `src/cli/` | CLI 传输层（SSE/WebSocket/Hybrid）与输出格式化 |
| `src/entrypoints/` | SDK 运行时类型与入口 |
| `src/context/`、`src/coordinator/`、`src/plugins/`、`src/memdir/`、`src/jobs/`、`src/schemas/` | 上下文窗口管理、多智能体协调、插件系统、Memory 目录、后台任务调度、Zod 模式 |
| `shims/` | 恢复期 shim 包，替代无法还原的原生/私有模块（以 `file:` 依赖引用） |
| `packages/@ant/` | 内部 @ant-scoped 包 |
| `vendor/` | 第三方/原生组件源码（audio-capture、image-processor 等） |
| `needs/` | claude-to-im 集成所需的 skills、hooks 与 settings.json |

关键子系统细节：

- **API 层**（`src/services/api/`）：`claude.ts`（约 135KB）主客户端做多提供商分发；`openaiCompat.ts` / `responsesCompat.ts` 协议转换；`client.ts` 凭证解析与 SDK 客户端初始化；`errors.ts` / `withRetry.ts` / `errorUtils.ts` 错误处理与重试
- **认证与配置**（`src/utils/`）：`auth.ts` 认证逻辑（含自定义 API 绕过密钥审批）；`customApiStorage.ts` ModelProfile 持久化；`dogeConfigDir.ts` 配置目录入口（`CLAUDE_CONFIG_DIR ?? ~/.doge`）；`effort.ts` / `thinking.ts` Effort/Thinking 能力检测与模型兼容
- **模型选择**（`src/utils/model/`）：`model.ts` Agent 模型选择与 fallback；`providers.ts` API 提供商检测（firstParty/bedrock/vertex/foundry）；`modelSupportOverrides.ts` 第三方模型能力覆盖
- **Computer Use**（`src/utils/computerUse/`）：`platforms/win32.ts` Windows 后端（HWND SendMessage + SendInput fallback），`win32/` 子模块（窗口管理/截图/OCR/输入/UI Automation/`windowGuard.ts` 输入前置卫兵/`installedApps.ts` 应用枚举/`windowClassify.ts` 自绘框架分类），`platforms/darwin.ts` macOS 后端
- **Playwright MCP**（`src/utils/playwrightMcp/`）：`common.ts` server 名常量与判定谓词 + 提示词 hint，`command.ts` 定位 Node / `@playwright/mcp` CLI 并拼 argv（含系统 Chrome/Edge 探测），`setup.ts` 产出 dynamic MCP config 与 `allowedTools`

## API 兼容架构

内部代码始终使用 Anthropic Messages 格式，协议转换只发生在 API 边界。由 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 选择提供商：

| 提供商 | 端点 | 转换方式 |
|--------|------|----------|
| `anthropic` | `/v1/messages` | 直接使用 Anthropic SDK |
| `openai` | `/v1/chat/completions` | `openaiCompat.ts` 双向转换（含流式事件回转） |
| `responses` | `/v1/responses` | `responsesCompat.ts` 双向转换（含流式事件回转） |

凭证解析优先级：`customApiStorage` → 运行时保存的设置 → `DOGE_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 环境变量 → 默认值。

### 环境变量

| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` | 指定 API 格式：`anthropic` / `openai` / `responses` |
| `ANTHROPIC_BASE_URL` | 自定义 API 端点 |
| `DOGE_API_KEY` | API 密钥，以 `x-api-key` header 发送（与 `ANTHROPIC_AUTH_TOKEN` 互斥，同时存在时启动卫兵按激活 profile/DOGE 优先裁决并删除另一个） |
| `ANTHROPIC_AUTH_TOKEN` | API 密钥的另一接入方式，以 `Authorization: Bearer` header 发送（仅认 Bearer 的网关用它；`/provider` 表单的 "Key type" 步骤可选） |
| `ANTHROPIC_MODEL` | 默认模型 |
| `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL` | 各层级 Agent 模型 |
| `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` | 能力声明，如 `effort,max_effort,thinking,adaptive_thinking` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子智能体模型覆盖 |
| `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` | 覆盖上下文窗口大小（字节） |
| `CLAUDE_CODE_EFFORT_LEVEL` | 努力等级：`low` / `medium` / `high` / `max` |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 禁用非必要网络请求 |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | 禁用非流式回退 |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | 强制启用 effort 参数 |
| `DOGE_MODEL_SCOPE` | 模型切换作用域：`session`（默认，仅当前终端） / `global`（切换即写全局配置） |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | 设为 `1` 启用 teammate 群聊模式（亦可改用 `--agent-teams` 旗标） |
| `CLAUDE_CONFIG_DIR` | 覆盖配置目录（默认 `~/.doge`） |
| `DOGE_PLAYWRIGHT_MCP` | 设为 `0` / `false` / `off` 关闭内置 Playwright MCP（默认开启） |
| `DOGE_PLAYWRIGHT_BROWSER` | 浏览器内核：`chromium`（默认）/ `firefox` / `webkit` |
| `DOGE_PLAYWRIGHT_HEADLESS` | 设为 `0` 拉起真实浏览器窗口（默认无头）；**需重启 doge**，且 settings.json 的 `env` 对此无效 |
| `DOGE_PLAYWRIGHT_OUTPUT_DIR` | Playwright 产物目录（默认 `os.tmpdir()/doge-playwright-mcp`） |
| `DOGE_PLAYWRIGHT_EXECUTABLE_PATH` | 直接指定浏览器可执行文件（优先级最高） |
| `DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER` | 设为 `0` 关闭系统 Chrome/Edge 自动探测，改用 playwright 自带版本 |
| `DOGE_PLAYWRIGHT_NODE_PATH` | 直接指定跑 MCP server 的 Node 可执行文件（桌面壳用它指向自带运行时；路径不存在则回退 PATH 查找） |

### 特殊模型行为

- `[1m]` / `[2m]` 后缀仅在本地从模型名中剥离用于上下文窗口计算，不发送到 API
- DeepSeek：`max_tokens` 自动限制 32k，`reasoning_content` 映射为 thinking 块
- 第三方 API：上下文窗口硬编码 + `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` 可覆盖
- 非 Anthropic 模型：上下文溢出错误映射为 PTL（触发 reactive compact）

### 启动脚本

根目录的 `start_*.ps1` 是针对不同提供商的启动脚本，开头会清理旧环境变量再注入新配置，可作为配置参考（切换提供商务必走脚本，避免旧 env 残留）：

- `start_deepseek.ps1` / `start_deepseek_ant.ps1` / `start_deepseek_rep.ps1` — DeepSeek（分别对应不同 API 格式/转接层）
- `start_glm.ps1` — GLM 模型
- `start_kimi.ps1` — Kimi 模型
- `start_qwen.ps1` — Qwen 模型
- `start_opencode_go.ps1` — OpenCode Go 接入
- `sync_to_cti.ps1` — 同步配置到 claude-to-im

## 代码风格约定

- TypeScript ESM；多数文件**无分号、单引号**；与周围文件风格保持一致
- camelCase 变量/函数，PascalCase 组件/类，kebab-case 命令目录
- 带 `ANT-ONLY import markers must not be reordered` 注释的 import 禁止重排序
- 优先小型聚焦模块，不做宽泛工具堆砌；坚持最小化、可审计的改动

## 安全注意事项

- API Key 等凭证持久化在 `~/.doge` 下（`customApiStorage.ts`），**不要**把真实密钥写入仓库或提交到 git
- Fork 修改了认证流程：使用自定义提供商（`openai`/`responses` 或非官方 Anthropic URL）时会跳过密钥审批流程，改动 `src/utils/auth.ts` 相关逻辑时注意保持这一行为有意为之
- 仓库会读取 `ANTHROPIC_BASE_URL`、`DOGE_API_KEY` 等环境变量；调试或日志输出时注意不要把密钥打进日志
- `needs/` 内含嵌套 `node_modules` 与第三方 vendored 代码，审查改动时注意区分自有代码与 vendor 代码
- `src/utils/computerUse/`（Windows 后端 HWND SendMessage + SendInput fallback）涉及真实键鼠注入与截图，属于高风险面，改动需充分手动验证

## 提交与协作约定

- 这是真实 git 仓库（有提交历史）。分支使用与任务收尾流程必须遵守下方「开发纪律」（硬性规定）
- 提交信息用简短祈使句（历史风格如 `Support web search for openai and responses API formats`，中英文均有）
- 无 CI、无发布流水线；分发方式就是 git 源码 + `bun link`
- 这是还原树而非 pristine 上游：恢复期 fallback/shim 与 Fork 魔改并存，为恢复兜底添加的变通方案要在代码或文档中注明
- 修复历史记录在 `debug_updates_1.md` ~ `debug_updates_6.md`，修改相关区域前可先查阅

## 开发纪律（硬性规定，违反即测试无效）

1. **新开分支**：每次执行新开发任务，开工前必须从基线分支（通常为 main）新开 git 分支（`git checkout -b feature/<任务名>`），禁止直接在 main 上开发合并。
2. **收尾一做与二问**：任务完成时，必须向用户逐条提醒并等待确认，未经答复不得擅自执行：
   - ① 确认好自己本轮做的修改，然后立即提交分支修改（如有非自己做的修改，请不要提交，列出这下未提交改动先列出文件清单，让用户确认后提交）；
   - ② 是否将分支合并进 main（确认后 `git checkout main && git merge feature/<任务名>`，并复核 main 可构建/冒烟通过，本仓库用 `bun run version`）；
   - ③ 是否删除该功能分支（确认合并后 `git branch -d`；若要删除尚未合并的分支，必须由用户明确授权 `-D`）。

   三问均有着落任务才算收尾；用户明确表示"都不用"可跳过。
3. **测试产物规定**：在本项目下建 `test/` 文件夹用于测试，脚本、图片、视频、文件等测试产物均写入 `test/` 下。测试结束后，除对测试有利的可复用脚本外，其余测试脚本与数据全部删除。
4. **C 盘写入纪律**：向 C 盘（或任何系统盘/系统临时目录）写入任何内容必须遵守——测试期间如需向 C 盘写入数据，测试结束后必须删除本次产生的全部测试数据，不允许留存在 C 盘内。

## 调试

- 调试日志写入 `~/.doge/debug/<sessionId>.txt`
- `--debug` 启动或 `/debug` 命令动态开启；`--debug=api,hooks` 白名单过滤，`--debug=!file` 黑名单；另有 `--debug-to-stderr`、`--debug-file=<path>`、`CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose`
- 核心实现：`src/utils/debug.ts`（日志管线：过滤/缓冲/写入/symlink）、`src/utils/debugFilter.ts`（分类过滤）、`src/skills/bundled/debug.ts`（`/debug` 内置技能）

## 修复历史

- `debug_updates_1.md` — Chapter 1-10（登录/上下文/Computer Use/高DPI）
- `debug_updates_2.md` — Chapter 11-25（Windows 输入/压缩/模型管理/持久化）
- `debug_updates_3.md` — Chapter 26+（凭据覆盖/effort 一致性/模型切换）
- `debug_updates_4.md` — 最新修改（effort 全链路修复/thinking 守卫）
- `debug_updates_5.md` — TUI 卡顿修复（skills 跳过 node_modules / `/clear` 软清 fileIndex / 非 git 大目录限深扫描）+ 新增 xhigh 思考档位 + 原生模型 ID 升级 Opus 4.6→4.8、Sonnet 4.6→5
- 多行输入被压成一行（2026-09-08）：`BaseTextInput` 多行模式由 `truncate-end` 改 `wrap`。Ink 的 `truncate*` 是对**整串**量宽度再切（`\n` 计 0 宽），所以多行文本只要总宽超过终端宽度就会被拦腰截断、尾部静默丢弃——首行超宽时更是只剩一行加一个 `…`。表现为「打了一屏多行字，发送后 Esc 打断回填，只剩一行，没法在后面增删」。`wrap` 由 render-node-to-output 按 `\n` 分行后逐行处理，不吞内容。决策抽成 `inputTextWrapMode()`，单行输入（搜索框等）保持 `truncate-end` 不变。见 `src/components/BaseTextInput.tsx` + `src/components/BaseTextInput.test.ts`

## 常见问题速查

| 问题 | 检查 |
|------|------|
| API 连接失败 | `ANTHROPIC_BASE_URL` + `DOGE_API_KEY` + `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 三者匹配 |
| 配置冲突 | 清除旧 env var 再切换（`start_*.ps1` 开头都有清理） |
| DeepSeek | `max_tokens` ≤ 32k，`reasoning_content` 必需 |
| Agent 模型 "not found" | 设置 `ANTHROPIC_DEFAULT_*_MODEL` 环境变量 |
| 上下文窗口错误 | 使用 `[1m]` 后缀或 `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` |
| 多终端模型互相影响 | 默认已是会话级隔离（档位切换也只在本终端生效）；如需固化当前模型为全局默认，用 `/model <model> --save` |
| 不同 provider 分不清 | `/provider add` 起始步填 Provider name（唯一），`/model` 列表显示 `Custom model(名称)` |
| Windows Computer Use | 管理员应用需要管理员终端；Electron/CEF 自动 SendInput |
| 依赖/运行报错 | `bun install` + `bun link`，确认 Bun 1.3.5+ |
| 首次运行报错 | 确保 `~/.doge/.claude.json` 中 `hasCompletedOnboarding: true` |
| 多行输入只剩一行 + `…` | 已修（`BaseTextInput` 多行用 `wrap`）；若仍复现，检查是否被 `maxVisibleLines` 视口裁剪（仅全屏模式生效） |
| 想看到 Playwright 的浏览器窗口 | 启动前设 `DOGE_PLAYWRIGHT_HEADLESS=0` 并**重启 doge**（settings.json 的 `env` 无效） |

## 其他参考文档

- `README.md` — 项目定位、安装、更新流程（中文）
- `computer_use.md`、`SYNC_CTI_CONFIG.md` — 专项说明
- `debug_updates_1.md` ~ `debug_updates_6.md` — 修复历史（见上文）

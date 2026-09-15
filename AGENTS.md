# AGENTS.md — Doge Code 仓库指南

面向 AI 编码代理（Claude Code / Doge Code 等），假设读者对项目一无所知；内容基于当前仓库实际核实，不要凭空假设。**任何任务开始前先读第一节开发纪律。**

## 一、开发纪律（硬性规定，违反即测试无效）

1. **新开分支**：每次执行新开发任务，开工前必须从基线分支（通常为 main）新开 git 分支（`git checkout -b feature/<任务名>`），禁止直接在 main 上开发合并。
2. **收尾三问**：任务完成时，必须向用户逐条提醒并等待确认，未经答复不得擅自执行：
   - ① 确认好本轮自己的修改，然后提交分支修改（如有非自己做的修改，不要提交，先列出未提交改动的文件清单让用户确认）；
   - ② 是否将分支合并进 main（确认后 `git checkout main && git merge feature/<任务名>`，并复核 main 可构建/冒烟通过，本仓库用 `bun run version`）；
   - ③ 是否删除该功能分支（确认合并后 `git branch -d`；若要删除尚未合并的分支，必须由用户明确授权 `-D`）。

   三问均有着落任务才算收尾；用户明确表示"都不用"可跳过。
3. **测试产物规定**：本项目下建 `test/` 文件夹用于测试，脚本、图片、视频、样例文件等测试产物均写入 `test/` 下。测试结束后，除对测试有利的可复用脚本外，其余测试脚本与数据全部删除。
4. **C 盘写入纪律**：向 C 盘（或任何系统盘/系统临时目录）写入任何内容必须遵守——测试期间如需写入，测试结束后必须删除本次产生的全部测试数据，不允许留存在 C 盘内。
5. **提交与风格**：提交信息用简短祈使句（历史风格如 `Support web search for openai and responses API formats`，中英文均有）；坚持最小化、可审计的改动；带 `ANT-ONLY import markers must not be reordered` 注释的 import 禁止重排序。

## 二、项目概述

**Doge Code**（`@doge-code/cli`，全局命令 `doge`）是 Claude Code 的第三方 Fork：基底是从 source map 逆向还原的 Claude Code 源码树，其上做了自主魔改，聚焦多提供商 API 兼容与自托管接入。它不是官方上游镜像，行为与官方 Claude Code 存在差异。

- 支持自定义 Anthropic 兼容端点与 API Key；经协议转换层支持 OpenAI Chat Completions 与 OpenAI Responses 两种 API 格式（**实验性，不完全稳定**）
- 自定义模型与模型档案（ModelProfile）管理；Agent 模型等级不够时自动 fallback
- **与官方 Claude Code 数据完全隔离（创始原则，2026-09-05 起全面生效）**：全局配置目录 `~/.doge`（全局文件 `~/.doge/.claude.json`，`CLAUDE_CONFIG_DIR` 可覆盖），不要与 `~/.claude` 混用；项目级一切资源（agents/skills/commands/rules/worktrees/settings/agent-memory/定时任务等）一律在 `<项目>/.doge/` 对应目录下（settings 为 `.doge/settings.json` 与 `.doge/settings.local.json`，**不读取** `.claude/settings*.json`），代码不读也不写任何 `.claude/` 路径。嵌套项目记忆为 `.doge/CLAUDE.md`；根目录 `CLAUDE.md`/`CLAUDE.local.md` 文件名约定保持不变（跨工具记忆文件）。唯二例外（有意保留的官方互操作）：`src/utils/ide.ts` 读官方 VSCode 扩展 lockfile、`src/utils/doctorDiagnostic.ts` 检测官方安装
- 技术栈：TypeScript（ESM）+ React JSX/Ink TUI；运行时 Bun ≥ 1.3.5（`packageManager: bun@1.3.5`）、Node ≥ 24；依赖锁定以 `bun.lock` 为准；`tsconfig.json` target/module ESNext、`moduleResolution: bundler`、`strict: false`、别名 `src/*`；`bunfig.toml` 定义编译期常量 `BUDDY = "true"`
- **无打包构建产物**，直接以 Bun 运行 TS 源码；无 CI、无发布流水线，分发方式就是 git 源码 + `bun link`；代码风格：多数文件无分号、单引号，camelCase/PascalCase/kebab-case 常规约定

## 三、构建思路（Fork 架构主线）

**核心设计：内部代码始终使用 Anthropic Messages 格式，协议转换只发生在 API 边界**，由 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 选择提供商：

| 提供商 | 端点 | 转换方式 |
|--------|------|----------|
| `anthropic` | `/v1/messages` | 直接使用 Anthropic SDK |
| `openai` | `/v1/chat/completions` | `src/services/api/openaiCompat.ts` 双向转换（含流式事件回转） |
| `responses` | `/v1/responses` | `src/services/api/responsesCompat.ts` 双向转换（含流式事件回转） |

凭证解析优先级：`customApiStorage` → 运行时保存的设置 → env（`DOGE_API_KEY`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`）→ 默认值。API 层（`src/services/api/`）：`claude.ts`（约 135KB）主客户端做多提供商分发，`client.ts` 凭证解析与 SDK 初始化，`errors.ts`/`withRetry.ts`/`errorUtils.ts` 错误处理与重试。

**双密钥严格区分**（仅有的两种密钥接入方式）：`DOGE_API_KEY` → SDK `apiKey` → `x-api-key` header；`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer` header（`client.ts configureApiKeyHeaders`）。`ModelProfile.authTokenType` 记录每个 provider 用哪种，`/provider` 表单有 "Key type" 步骤，`applyModelProfile` 按类型互斥写 env。两者同时泄漏进 `process.env` 曾致双 header 矛盾 401：`enforceApiKeyExclusivity`（`src/utils/apiKeyExclusivity.ts`）在 `managedEnv.ts` 两个 apply 入口收敛互斥（激活 profile 声明 Bearer 且 key 匹配则保留 AUTH_TOKEN，否则 DOGE 优先），`configureApiKeyHeaders` 在 DOGE 存在时跳过 Bearer 兜底；卫兵只改本进程 env，不影响并行终端。

### 关键子系统（干什么 → 在哪 → 关键机制与坑）

1. **认证绕过（有意行为，改 `src/utils/auth.ts` 必须保持）**：使用自定义提供商（`openai`/`responses` 或非官方 Anthropic URL）时直接返回 API key，跳过官方密钥审批流程。

2. **ModelProfile 持久化（provider 为中心）**：`src/utils/customApiStorage.ts` 持久化每 provider 完整配置（providerName/provider/baseURL/apiKey/contextWindow/三档位模型/Key type）。`/provider` 表单第一步为 **Provider name**（必填、全局唯一，重复拒绝；存量无名 profile 兼容显示）。**身份键 = providerName**：`isSameProviderEntry`（两侧都有名按名、否则按模型）统一冲突豁免与 upsert 判定；写入在 `src/commands/provider/provider-storage.ts` 的 `upsertModelProfile`（编辑改名原地替换，并把被换条目旧模型名清出 savedModels，否则 /provider 菜单留幽灵行）；读时 `normalizeCustomApiStorageData` 按名去重（激活者胜否则后写胜）；启动迁移 `migrateDuplicateProviderProfiles`（`cli.tsx`，须 `--help` 这类完整启动链才跑，`--version` 不经过）物理修复并把 `.claude.json` 镜像对齐权威源。测试：`src/commands/provider/provider-storage.test.ts` + `src/utils/customApiStorage.test.ts` + `test/e2e-provider-identity.ts`。

3. **会话级模型切换（多终端隔离）**：`/model` 切换默认只作用于当前进程（`process.env` + AppState 的 `mainLoopModelForSession`），**不写任何磁盘配置**，多终端互不影响；`/model <model> --save` 显式固化为全局默认，`DOGE_MODEL_SCOPE=global` 恢复"切换即持久化"。**档位（opus/sonnet/haiku）切换一律会话级、永不持久化**：旧的 `activeTier`/`tierModels` 全局持久化已废弃（曾把一个终端选的档位强加给所有终端），启动时 `restoreTierState` 仅从激活 profile 档位字段注入 `ANTHROPIC_DEFAULT_*_MODEL` env 且**绝不**改写 `ANTHROPIC_MODEL`，遗留字段由 `clearLegacyTierState()`/启动迁移抹除。**Default（recommended）语义** = 当前 provider 的 sonnet 档模型，未配置则回落主模型，单一实现 `resolveSessionDefaultModel`（env sonnet 档 → 激活 profile sonnet 字段 → env `ANTHROPIC_MODEL` → 磁盘基线；激活 provider 永远压过磁盘基线）；`/model <tier> --save` 不持久化档位。实现：`src/utils/model/{modelSwitchScope,switchModelProfile,restoreTierState,modelOptions}.ts`（切换 provider 走 `switchModelProfileAtomic`）、`src/commands/model/handlers.ts`、`src/state/onChangeAppState.ts`（settings.json 写入 gate）。`/model` 列表第三方模型显示 `Custom model(<providerName>)`；Doge Code 桌面壳的 provider 下拉直接读写本存储。

4. **/auto 与三态权限模式**：TUI 内 `/auto`（支持 `[on|off]`）直接切换 bypassPermissions，Shift+Tab 在 auto → accept → plan 间循环；刻意不改 `isBypassPermissionsModeAvailable`（保持旗标启动会话语义）。**auto 会话全放行语义**：共享判定 `isAutoBypassActive`（`src/utils/permissions/autoBypass.ts`）供中央管道与 CU 接缝共用——① auto 会话里模型进 plan 模式后工具依旧全放行（deny 规则、显式 ask、safetyCheck 与 requiresUserInteraction 工具仍先行）；② CU 的 `request_access` 授权对话框在 auto 会话自动全授权（`autoGrant.ts` 镜像 Allow 语义，缺 OS 权限分支仍弹窗）；③ **plan 审批框（`ExitPlanModePermissionRequest`）保留且罗列全部执行模式由用户选，auto 不代选不放行**，模式解析集中 `resolvePlanApprovalMode`。见 `src/commands/auto/`、`src/utils/permissions/getNextPermissionMode.ts`、`src/components/permissions/ExitPlanModePermissionRequest/`。

5. **Computer Use Windows（默认启用，高风险面，改动需充分手动验证）**：HWND SendMessage + SendInput fallback，`src/utils/computerUse/`（`platforms/win32.ts`、`platforms/darwin.ts`、`win32/` 子模块）。fork 已解闸全部官方门控：`src/utils/computerUse/gates.ts` 的 `getChicagoEnabled()`/`hasRequiredSubscription()` 硬编码 true，`src/services/mcp/config.ts` 的 `isDefaultDisabledBuiltin` 恒 false（`computer-use` server 默认连接，仍可 `/mcp` 禁用）；`main.tsx` 注入 CU MCP 时无条件 append 本地提示 `COMPUTER_USE_MCP_PROMPT_HINT`（第三方端点没有服务端提示）。关键机制：
   - **输入前置卫兵**：Windows 所有输入动作先过 `guardBoundWindow`（`platforms/win32.ts`）——检查 IsWindow/前台归属 → 死窗口按 PID/进程名重绑 → 真实输入路径经 `ensureWindow`（`win32/windowGuard.ts`，单条 PowerShell 内恢复最小化 + AttachThreadInput 前台锁绕行 + ALT 微扰 + 重试校验）→ 通过才发输入，否则抛面向模型的错误；SendMessage 路径只做存活检查（后台安全）
   - **应用枚举**：`win32/installedApps.ts` 五阶段并行枚举（注册表/App Paths/快捷方式单 COM/Get-StartApps/运行中窗口）+ 单飞缓存，658 应用约 1.3s；`appNames.ts` win32 分支用系统目录排除制
   - **自绘窗口通道 + 拖拽**：`win32/windowClassify.ts` 按窗口类名识别 Chromium vs 自绘框架（Qt/SDL/GLFW/Unity/SunAwt——Android 模拟器即 Qt），自绘窗口鼠标键盘一律走真实输入（SendMessage 对自绘表面是应用层空操作）；拖拽为单条 PowerShell down→缓动帧→up 整手势（`sendInputDrag`/`windowMessage.sendDrag`），修复旧版 drag=3 次点击的错

6. **PTL 错误映射**：Anthropic/OpenAI 格式的上下文溢出错误 → 统一 reactive compact。

7. **agent-teams TUI（统一 agent 面板）**：TUI 底部 `CoordinatorTaskPanel`（`CoordinatorAgentStatus.tsx`，PromptInputFooter 末尾无条件渲染）是**唯一列表**：常驻 `main-<模型>` 行 + 所有子代理行——local_agent 任务（`sub-agent-<模型id>-<描述>`）与 in_process_teammate 任务（`sub-agent-<人名>-<模型>-<活动>`，人名带 swarm 色，模型来自 task 的 `model` 字段=in-process spawn 已解析规格/tmux 注册也传入，缺省显示 `inherit`，`[stopping]`/`[awaiting approval]` 标记，见 `TeammateAgentLine.tsx`；行标签构造在可测的 `teammateRowLabel`）统一按 startTime 排序；行首图标：实心 `●`（`BLACK_CIRCLE`）=正在查看的 transcript（leader 视图下的 main 行），空心 `○`（`WHITE_CIRCLE`，`constants/figures.ts`）=未查看——**不要换回 `figures.circle`**（其 Windows 回退是 `( )`，曾被用户当成杂散括号）；`Ctrl+Shift+A` 聚焦（`Ctrl+T` 同义快捷键：切换面板聚焦 tasks↔null——2026-09 从"expandedView todo 展开切换"改来，旧实现在模型无 todo 时按下毫无视觉反应，被用户报为 bug；todo 列表仍在模型写入时内联渲染，`expandedView` 仅剩 `showExpandedTodos` 配置入口），↑↓ 导航、Enter 切 transcript（`footer:openSelected` → `enterTeammateView`，local/teammate 行通用；main 行 Enter=回 leader 视图）、`x` 停止（teammate 运行中首按=优雅关闭 mailbox shutdown_request，再按=硬杀；终态=立即隐藏）、Esc 返回，鼠标点击同款；键盘链路 e2e 见 `test/e2e-agent-panel-keys.ts`（真实 PromptInput+键位系统驱动）。teammate 终态的 30s 面板宽限由面板 1s tick 经 `components/tasks/teammatePanel.ts` 纯函数统一管理（swarm 运行时转换不设 evictAfter）。**旧 teammate 专属 UI 已退役**：footer @name pill 行与 spinner 树已移除（`BackgroundTaskStatus` 只汇总其余后台任务；`TeammateSpinnerTree/Line` 已删；`useBackgroundTaskNavigation` 只剩查看态 Esc 中止当前轮次；ctrl+shift+o 预览绑定删除），查看时的 @name 色 banner（`useSwarmBanner`）保留。内置 Explore/Plan 子代理在 `src/tools/AgentTool/builtInAgents.ts` 强制启用（源码运行下 `feature()` 恒 false 的兜底）。**开启方式（三层，2026-09 内化）**：① `/agent-teams <需求>` 内置 prompt 型命令（`src/commands/agent-teams/`，`source:'builtin'` 不暴露给模型）——调用即 `enableAgentSwarmsForSession()` 本进程内启用并展开为团队编排提示词；② 用户消息含明确多 agent 协作关键词（"agent teams/agent swarm/多agent协作/多agent协同/多智能体协同/多智能体协作/agent集群/智能体集群/智能体队伍"，匹配器 `src/utils/agentTeamsKeywords.ts`，引号/路径/斜杠前缀/问号排除）且**尚未** opt-in 时自动启用并转投 `/agent-teams <原文>`（`processUserInput.ts` ultrapan 同款转投块，`isAgentSwarmsOptedIn()` 已启用则透传不劫持）；③ 启动期 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 或 `--agent-teams`（teammate 子进程恒带此 env）。门控单一来源 `isAgentSwarmsEnabled()` 每次调用动态读 env，`getAllBaseTools()` 每查询现算，故运行时改 env 下一次查询即含 TeamCreateTool。teammate 模型按任务难度自主选择：Agent 工具 `model` 枚举含 `opus/sonnet/haiku/inherit`（`getAgentModel` 把 tool 显式 `'inherit'` 视同未指定，防止字面量打到 API），指引写在 `/agent-teams` 提示词、`leadPromptAddendum` 与 TeamCreateTool prompt。**shutdown 协议的字符串逃生门（2026-09 修复，用户实测 teammate 批准关闭三次仍永远运行）**：模型（lead 与 teammate 双方）常把协议负载序列化成 JSON 字符串走 `message` 纯文本通道（结构化 union 处理器从不运行、requestId 从不生成、无人体检 `shutdown_response` 字典）——`SendMessageTool` 现在两处兜底：`validateInput` **开头**就提升（无 summary 的字符串化协议消息此前被"summary is required"拒之门外）、`call()` 再提升一次（UDS/bridge 发送之后），核心是 `parseStructuredMessageFromString`（JSON 解析成功且 schema 全匹配才提升）；新增协议类型时该提升是闭环关键，别绕开。**in-process 审批绝不落 `gracefulShutdown(0)`**（2026-09 修复）：该函数是全进程退出，in-process teammate 与 lead 同进程——`handleShutdownApproval` 的 in-process 分支（判 `isInProcessTeammate() || backendType==='in-process'`）必须提前 return，只 abort 自己的 task。**团队文件 config.json 必须锁定 RMW**（2026-09 修复，并发 spawn 丢注册实测）：所有成员变更（spawn 注册×3 处、`removeTeammateFromTeamFile`、`setMemberActive`）一律走 `teamHelpers.mutateTeamFileAsync`（proper-lockfile，邮箱同款），裸 read→push→write 会最后写者覆盖丢成员。**in-process 成员退出必须写 `isActive=false`**：`inProcessRunner` 退出路径（completed/failed）调 `setMemberActive(...,false)`（in-process 无 Stop 钩子，TeamDelete 按 `isActive !== false` 算活跃）；TeamDeleteTool 另有僵尸豁免（`backendType==='in-process'` 且 AppState 无 running task 的成员不阻塞删除——AppState 任务表是 in-process 成员的活跃真源）；lead 侧 poller 收 `shutdown_approved` 时注册表查不到也按 `parsed.from` 名字兜底删文件+完结任务。**lead 会话必须可 /resume（2026-09 修复，用户实测团队会话从 /resume 列表消失）**：`useLogMessages` 给启用 swarms 后的一切消息盖 `teamName` 章（含 lead 自己），`sessionStorage.ts` 的 `enrichLog` 过滤条件是 `teamName && agentName`（仅 teammate 工人会话），**不能**只看 teamName——会把用户自己的对话藏起来。**teammate 消息的转录渲染不得依赖实时 flag（2026-09 修复，/resume 后 `<teammate-message>` 信封连同 idle/shutdown 协议噪音裸显）**：`UserTextMessage` 的 teammate 分支原以 `isAgentSwarmsEnabled()` 门控，resume 出的新进程未 opt-in → 信封按普通用户消息原文渲染。修复：`Message.tsx` 的 UserMessage 从消息自身的持久化 `teamName` 戳（`useLogMessages` 盖在每条消息上、`removeExtraFields` 不剥、resume 后仍在内存对象上）推导 `isTeamTranscriptEntry` 传入，与实时 flag 取或——带戳即按 teammate 渲染，无戳文本（如用户粘贴的信封）在非 swarm 会话仍字面透传不劫持。回归见 `test/e2e-teammate-resume-render.ts`。**编排纪律注入（自休眠 coordinator 提示词移植，2026-09）**：lead 侧一次性 `<system-reminder>`（`src/utils/swarm/leadPromptAddendum.ts` 的 `getLeadOrchestrationReminder` 按 team 名去重），随 TeamCreateTool 与 spawnMultiAgent `handleSpawn` 成功结果投递，内容为四阶段流水线/并发纪律/先消化再派活/失败续聊的 swarm 语义映射；teammate 侧附言 `teammatePromptAddendum.ts` 增补结果汇报/验证/失败上报纪律，in-process 与 tmux 两后端共用。见 `src/hooks/useGlobalKeybindings.tsx`。

8. **内置 Playwright MCP（默认激活）**：补上游纯 HTTP 抓取拿不到 JS 渲染页面的短板。实现在 `src/utils/playwrightMcp/{common,command,setup}.ts`，注入点 `main.tsx` 的 `setupPlaywrightMCP()`（CU 块之后，仅交互式会话）。**最要紧的坑：Bun 下 Playwright 连不上浏览器**（`--remote-debugging-pipe` 与 WebSocket 传输均超时，Node 下都正常；Bun 能 fetch 通 CDP 的 HTTP 端点，挂的是传输层）——所以 **spawn 一个 Node 子进程走 stdio，绝不能改回 in-process**（会复现 navigate 超时 180s）。`setupPlaywrightMCP()` 往 `dynamicMcpConfig` 塞 `type:'stdio'` 配置（command=找到的 Node，args=`@playwright/mcp` cli.js + `--browser/--headless/--isolated/--output-dir/--executable-path`），并把 `mcp__playwright__*` 加入 `allowedTools`。浏览器默认**复用系统已装 Chrome/Edge**（`detectSystemBrowser()` → `--executable-path`，零下载开箱即用；playwright 自带 chromium 修订版与本机旧 `mcp-chrome-<hash>` 下载缓存互不相认）；首次工具调用懒启动；产物写 `os.tmpdir()/doge-playwright-mcp`（不污染用户项目）。`/mcp` 可禁用，`DOGE_PLAYWRIGHT_MCP=0` 可关闭。**settings.json 的 `env` 对它无效**（`applyConfigEnvironmentVariables()` 晚于 `setupPlaywrightMCP()`），只能用进程环境变量，且改完必须重启 doge。保留名拦截见 `config.ts` 的 `addMCPServer`；埋点白名单 `services/analytics/metadata.ts` 的 `BUILTIN_MCP_SERVER_NAMES`。

9. **内置 Anthropic 技能库**：18 个技能（17 个 Anthropic 官方 docx/pdf/pptx/xlsx/canvas-design/skill-creator/mcp-builder/webapp-testing 等 + 自研 `python`）vendored 进 `src/skills/bundled/anthropic/<name>/`（约 10MB，含字体/xsd/示例 PDF；`needs/` 原件保留作上游源），经 `initBundledSkills()` 末尾的 `initAnthropicSkills()` 注册为 `source:'bundled'`，`/docx` `/pdf` 等可手动调用、frontmatter description 自动触发。`gen-manifest.ts` 生成每技能 `<skill>.content.ts`（文本 `with { type: 'text' }` 静态导入 + 二进制 `copyFrom` 字节流复制）与 `manifest.ts`（frontmatter + 懒加载 thunk），注册纯内存零 IO、内容首次调用时懒提取到 nonce 临时目录。**纪律：新增/删除 vendored 文件或改 SKILL.md frontmatter 后必须重跑 `bun run src/skills/bundled/anthropic/gen-manifest.ts`**（正文改动无需）。同名去重按名跳过（编译构建下 feature 门控的定制版 claude-api 优先）。headless 配套：initialize 应答 commands 每项带 `type`（prompt|local）与 `source`（bundled|projectSettings|userSettings|plugin|mcp|workflow）字段——`src/cli/print.ts` 的 `handleInitializeRequest` + `src/entrypoints/sdk/coreSchemas.ts` 的 `SlashCommandSchema`，桌面壳 /skills 分组依赖机器字段（description 里的来源标记是给人看的）。`/skills` 面板内外置分组见 `src/components/skills/SkillsMenu.tsx`。

10. **项目目录命名 v2 编码**：`~/.doge/projects/<encoded-cwd>` 目录名由 v1（非字母数字全→`-`，不可反解）改为**可逆编码**：`\`/`/` → `~`，`~` → `%7e`，其余非字母数字按 UTF-8 转 `%xx`，`[a-zA-Z0-9-]` 保留（例：`E:\ClaudeCode\doge-code` → `E%3a~ClaudeCode~doge-code`）；>200 字符截断 + hash 后缀与 v1 相同。实现集中 `src/utils/sessionStoragePortable.ts`（`sanitizePath`/`legacySanitizePath`/`sanitizePathCandidates`/`decodeProjectDirName`/`findProjectDir`）。**兼容策略：写永远 v2，读同时认 v1**——旧会话恢复后留 v1 目录、新会话落 v2 目录（并存是预期过渡态）；auto-memory 优先复用已存在 v1 memory 目录以免记忆"重置"。启动迁移 `migrateLegacyProjectDirs()`（`cli.tsx` 通用路径每次启动执行）：v1 目录按最新 jsonl cwd 恢复真实路径后原子 rename 成 v2 名，目标已存在则逐文件合并（newest-mtime 胜）；无 cwd 或被活会话锁定（EPERM）→ 跳过下次重试；幂等。`cachePaths.ts` 的缓存目录命名是刻意独立的 djb2 副本，未随之改动。

## 四、使用方法

### 常用命令

```bash
bun install                # 安装依赖（含 shims/ 下的本地 file: 包）
bun run dev / start        # 启动 CLI/TUI（入口 src/bootstrap-entry.ts）
bun run version            # 输出版本号，冒烟验证 CLI 可启动
bun run dev:restore-check  # 启动 src/dev-entry.ts 检查缺失 import（恢复期工具）
bun link                   # 注册全局 doge 命令
```

`package.json` **没有** `lint`/`test`/`build` 脚本。源码级更新流程：`git pull && bun install && bun link`。（注：根目录原有 `start_*.ps1` 提供商启动脚本已删除（commit 67be696），配置方式见环境变量表与 git 历史。）

### 测试策略

- 框架 `bun:test`，运行 `bun test`；测试与代码同目录（`*.test.ts`），新增测试放被测模块旁，以模块或被测行为命名。单测现分布于 `src/services/api/`、`src/services/mcp/`、`src/commands/model/`、`src/commands/provider/`、`src/utils/model/`、`src/utils/playwrightMcp/`、`src/utils/computerUse/`（含 `win32/`）、`src/hooks/`、`src/utils/`、`src/components/`
- **裸跑 `bun test` 会连带执行 `needs/skills/claude-to-im/node_modules/` 里 vendored zod 的测试**（22 文件约 250 用例）；只跑项目测试用路径过滤，如 `bun test src/services/api/`
- **已知既有失败**（非新改动引入，且与环境相关）：`src/hooks/useMainLoopModel.test.ts` 的 `does not fall through to customApiStorage when AppState fields are null`——该用例读真实 `~/.doge` 凭证状态，凭证被清空时失败、恢复后自动通过
- **特殊环境要求**：`bun test src/skills/bundled/anthropic/` 须独立跑（自设 `CLAUDE_CODE_TMPDIR` 沙箱并自清理）；`test/e2e-skills-menu.ts` 须 `NODE_ENV=test` + `CLAUDE_CONFIG_DIR` 沙箱（否则撞 config 门禁）；**provider 存储 e2e 别用 `NODE_ENV=test`**——saveGlobalConfig 在 test 下写内存桩不落盘，镜像断言假失败
- 实机 e2e 脚本（`test/` 下，均可重复运行、自带沙箱清理）：`computer-use-e2e.ts`（CU 只读链路）、`e2e-cu-input-guard.ts`（输入卫兵+应用枚举，短暂激活 notepad）、`e2e-cu-emulator-input.ts`（Qt 自绘窗口点击拖拽，缺模拟器/adb SKIP）、`e2e-playwright-mcp.ts`、`e2e-project-dirs.ts`、`e2e-migrate-projects.ts`、`e2e-provider-form.ts`、`e2e-provider-identity.ts`、`e2e-model-picker.ts`、`e2e-tier-session-switch.ts`、`e2e-skills-menu.ts`
- 除单测外，改动后 `bun run version` 冒烟 + `bun run dev` 手动验证受影响路径

### 配置与环境变量

| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` | API 格式：`anthropic` / `openai` / `responses` |
| `ANTHROPIC_BASE_URL` | 自定义 API 端点 |
| `DOGE_API_KEY` | 密钥，`x-api-key` header（与 `ANTHROPIC_AUTH_TOKEN` 互斥，同时存在时启动卫兵按激活 profile/DOGE 优先裁决并删除另一个） |
| `ANTHROPIC_AUTH_TOKEN` | 密钥另一接入方式，`Authorization: Bearer` header（仅认 Bearer 的网关用） |
| `ANTHROPIC_MODEL` | 默认模型 |
| `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL` | 各层级 Agent 模型 |
| `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` | 能力声明，如 `effort,max_effort,thinking,adaptive_thinking` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子智能体模型覆盖 |
| `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` | 覆盖上下文窗口大小（字节） |
| `CLAUDE_CODE_EFFORT_LEVEL` | 努力等级：`low` / `medium` / `high` / `xhigh` / `max` |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 禁用非必要网络请求 |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | 禁用非流式回退 |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | 强制启用 effort 参数 |
| `DOGE_MODEL_SCOPE` | 模型切换作用域：`session`（默认）/ `global`（切换即写全局配置） |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | 设 `1` 启用 teammate 群聊（亦可 `--agent-teams`；会话内可用 `/agent-teams <需求>` 或消息含多 agent 协作关键词自动启用，只影响本进程） |
| `CLAUDE_CONFIG_DIR` | 覆盖配置目录（默认 `~/.doge`） |
| `DOGE_PLAYWRIGHT_MCP` | 设 `0`/`false`/`off` 关闭内置 Playwright MCP（默认开启） |
| `DOGE_PLAYWRIGHT_BROWSER` | 浏览器内核：`chromium`（默认）/ `firefox` / `webkit` |
| `DOGE_PLAYWRIGHT_HEADLESS` | 设 `0` 拉起真实浏览器窗口（默认无头）；**需重启 doge**，settings.json 的 env 无效 |
| `DOGE_PLAYWRIGHT_OUTPUT_DIR` | Playwright 产物目录（默认 `os.tmpdir()/doge-playwright-mcp`） |
| `DOGE_PLAYWRIGHT_EXECUTABLE_PATH` | 直接指定浏览器可执行文件（优先级最高） |
| `DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER` | 设 `0` 关闭系统 Chrome/Edge 探测，改用 playwright 自带版本 |
| `DOGE_PLAYWRIGHT_NODE_PATH` | 指定跑 MCP server 的 Node 可执行文件（桌面壳用；路径不存在回退 PATH） |

**特殊模型行为**：`[1m]`/`[2m]` 后缀仅本地剥离用于上下文窗口计算，不发送到 API；DeepSeek `max_tokens` 自动限 32k、`reasoning_content` 映射为 thinking 块；第三方 API 上下文窗口硬编码 + `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` 可覆盖；非 Anthropic 模型上下文溢出映射为 PTL。

### 调试

- 日志写 `~/.doge/debug/<sessionId>.txt`；`--debug` 启动或 `/debug` 命令动态开启；`--debug=api,hooks` 白名单、`--debug=!file` 黑名单；另有 `--debug-to-stderr`、`--debug-file=<path>`、`CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose`
- 核心：`src/utils/debug.ts`（管线：过滤/缓冲/写入/symlink）、`src/utils/debugFilter.ts`（分类过滤）、`src/skills/bundled/debug.ts`（`/debug` 技能）

## 五、关键经验（只留要紧的坑）

- **Bun `.md` loader 转 HTML**：Bun 下 `.md` 默认 loader 会转成 HTML、未知扩展名默认 file loader 返回路径——文本文件必须显式 `with { type: 'text' }`（曾静默 HTML 化 `claudeApiContent.ts`/`verifyContent.ts`）
- **Playwright × Bun**：必须 Node 子进程，见子系统 8
- **`NODE_ENV=test` 陷阱**：saveGlobalConfig 写内存桩不落盘，涉及磁盘镜像断言的 e2e 会假失败
- **JS 模板字符串嵌 PowerShell**：PS 注释含 `E:\Git\usr\bin` 之类裸路径会因 `\u` 非法转义炸整文件
- **Ink truncate 与 wrap**：`truncate*` 对整串量宽再切（`\n` 计 0 宽），多行文本超终端宽就被拦腰截断、尾部静默丢弃只剩一行加 `…`——多行输入用 `wrap`（`src/components/BaseTextInput.tsx` 的 `inputTextWrapMode()`，单行搜索框仍 truncate-end）
- **渲染管线吞 `<...>` 占位符**：命令文案/提示禁用 `<xxx>` 占位符形式（会被吞）
- **React Compiler 编译产物编辑**：`SkillsMenu.tsx` 等按"_c(n) 缓存槽读写对称扩槽加 prop"纪律改；内嵌 sourcemap 落后于编译输出，读码以输出为准
- **allowedTools 通配符**：必须手工拼 `mcp__<server>__*`——`buildMcpToolName()` 会把 `*` 规范化成 `_`，生成匹配不到任何工具的死规则
- **`main.tsx` 约 808KB 超大文件，修改需格外谨慎**；定位用函数名不要硬编码行号（行号会漂移，`setupPlaywrightMCP` 约 1673 行、`applyConfigEnvironmentVariables` 约 2028/2636/2658 行仅供参考）
- **这是还原树而非 pristine 上游**：恢复期 fallback/shim 与 Fork 魔改并存，为恢复兜底添加的变通要在代码或文档中注明；`needs/` 内含嵌套 `node_modules` 与 vendored 代码，审查时区分自有与 vendor

## 六、代码组织速查

- **入口链**：`src/bootstrap-entry.ts`（bin.doge 指向）→ `src/main.tsx`（主 UI）→ `src/entrypoints/cli.tsx`（启动迁移：`migrateLegacyProjectDirs` + `migrateDuplicateProviderProfiles`）；`src/commands.ts` 命令路由；`src/query.ts`/`src/QueryEngine.ts` 查询引擎；`src/Task.ts`/`src/Tool.ts` 抽象；`src/interactiveHelpers.tsx` 交互辅助
- **认证与配置**（`src/utils/`）：`auth.ts` 认证逻辑（含绕过审批）；`dogeConfigDir.ts` 配置目录入口（`CLAUDE_CONFIG_DIR ?? ~/.doge`）；`effort.ts`/`thinking.ts` Effort/Thinking 能力检测与模型兼容
- **模型选择**（`src/utils/model/`）：`model.ts` Agent 模型选择与 fallback；`providers.ts` 提供商检测（firstParty/bedrock/vertex/foundry）；`modelSupportOverrides.ts` 第三方模型能力覆盖

| 目录 | 用途 |
|------|------|
| `src/commands/` | 所有 `/` 斜杠命令实现，每命令一个 kebab-case 目录 |
| `src/components/` | React/Ink TUI 组件（SkillsMenu 在 `components/skills/` 子目录） |
| `src/services/` | 业务逻辑服务（API、Compact、MCP、LSP 等） |
| `src/tools/` | 内置 Tool 实现（BashTool、FileEditTool、AgentTool 等） |
| `src/skills/` | 内置 Skill 系统（`bundled/` 内置技能，含 `bundled/anthropic/` 18 技能与 `debug.ts`） |
| `src/utils/` | 工具函数（认证/配置/模型/调试/computerUse/playwrightMcp/permissions 等） |
| `src/bridge/`、`src/cli/`、`src/entrypoints/` | 远程桥接 / CLI 传输层（SSE/WebSocket/Hybrid）与 headless（`cli/print.ts`）/ SDK 类型（`entrypoints/sdk/coreSchemas.ts`） |
| `src/context/`、`src/coordinator/`、`src/plugins/`、`src/memdir/`、`src/jobs/`、`src/schemas/` | 上下文窗口管理、多智能体协调、插件系统、Memory 目录、后台任务调度、Zod 模式 |
| `shims/` | 恢复期 shim 包，替代无法还原的原生/私有模块（`file:` 依赖引用） |
| `packages/@ant/` | 内部 @ant-scoped 包（computer-use-input/mcp/swift 等） |
| `vendor/` | 第三方/原生组件源码（audio-capture、image-processor 等） |
| `needs/` | claude-to-im 集成遗留的 skills、hooks 与 settings.json（含嵌套 node_modules） |

## 七、修复历史与常见问题

修复历史按章记录在 `debug_updates_1.md` ~ `debug_updates_6.md`，修改相关区域前可先查阅：

- `debug_updates_1.md` — 登录/上下文/Computer Use/高DPI；`debug_updates_2.md` — Windows 输入/压缩/模型管理/持久化；`debug_updates_3.md` — 凭据覆盖/effort 一致性/模型切换；`debug_updates_4.md` — effort 全链路/thinking 守卫；`debug_updates_5.md` — TUI 卡顿修复 + xhigh 档位 + 模型 ID 升级；`debug_updates_6.md` — CU 自绘窗口通道/拖拽/输入卫兵

| 问题 | 检查 |
|------|------|
| API 连接失败 | `ANTHROPIC_BASE_URL` + `DOGE_API_KEY` + `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 三者匹配 |
| 配置冲突 | 清除旧 env var 再切换（DOGE_API_KEY/ANTHROPIC_* 残留互踩，双密钥互斥卫兵会裁决） |
| DeepSeek | `max_tokens` ≤ 32k，`reasoning_content` 必需 |
| Agent 模型 "not found" | 设置 `ANTHROPIC_DEFAULT_*_MODEL` 环境变量 |
| 上下文窗口错误 | 使用 `[1m]` 后缀或 `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` |
| 多终端模型互相影响 | 默认已是会话级隔离（档位也只在本终端生效）；固化用 `/model <model> --save` |
| 不同 provider 分不清 | `/provider add` 首步填 Provider name（唯一），`/model` 列表显示 `Custom model(名称)` |
| Windows Computer Use | 管理员应用需要管理员终端；Electron/CEF 自动 SendInput |
| 依赖/运行报错 | `bun install` + `bun link`，确认 Bun 1.3.5+ |
| 首次运行报错 | 确保 `~/.doge/.claude.json` 中 `hasCompletedOnboarding: true` |
| 多行输入只剩一行 + `…` | 已修（多行用 `wrap`）；若仍复现，检查 `maxVisibleLines` 视口裁剪（仅全屏模式生效） |
| 想看到 Playwright 浏览器窗口 | 启动前设 `DOGE_PLAYWRIGHT_HEADLESS=0` 并**重启 doge**（settings.json 的 env 无效） |

## 八、安全注意事项

- API Key 等凭证持久化在 `~/.doge` 下（`customApiStorage.ts`），**不要**把真实密钥写入仓库、提交到 git 或打进日志
- `src/utils/computerUse/` 涉及真实键鼠注入与截图，属高风险面，改动需充分手动验证

## 九、其他参考文档

- `README.md` — 项目定位、安装、更新流程（中文）
- `computer_use.md` — Computer Use 专项说明
- `debug_updates_1.md` ~ `debug_updates_6.md` — 修复历史（见第七节）

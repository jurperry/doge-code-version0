# Doge Code CLI 架构现状

> 对照基线 `5060f42`（版本 2.1.345）核实。可复用经验与坑见 `../development_logs.md`，Computer Use 专项见 `./COMPUTER_USE.md`；代码路径相对仓库根。

## 1. 定位与 Fork 原则

Doge Code（`@doge-code/cli`，命令 `doge`）是 Claude Code 的第三方 Fork：source map 还原的源码树（含 shim/fallback/恢复缺口）+ 本 Fork 改动。

1. **内部协议不变**：主逻辑始终按 Anthropic Messages 组织，OpenAI/Responses 转换只在 `src/services/api/` 边界，不渗入 query/tool 层。
2. **数据隔离**：全局 `~/.doge`、项目 `<项目>/.doge/`，不读写 `.claude/`（§8 三处例外）。
3. **自定义接入一等公民**：端点/密钥/模型目录/档位由 `~/.doge/` 持久化数据驱动，不依赖官方登录态。
4. **恢复代码如实标注**：shim、原生包替身、缺失模块不伪装成上游；文档只写可核实行为。
5. **桌面壳可驱动**：CLI 是邻仓 `doge-code-app` 的唯一 agent 引擎，headless stream-json 与 `task_*`/控制请求是稳定契约。

## 2. 运行时与入口

- 无打包构建：`bun run dev` = `bun run ./src/bootstrap-entry.ts`；`bin` 的 `doge` 同指向该文件。启动链 `bootstrap-entry.ts`（注入 `MACRO`）→ `src/entrypoints/cli.tsx`（快速路径：`--version`、`--computer-use-mcp`、`remote-control`、`daemon`、`ps/logs/attach/kill`、`--worktree --tmux` 等）→ `main.tsx`（Commander + 初始化 + 分发）。
- `initializeEntrypoint()` 设 `CLAUDE_CODE_ENTRYPOINT`（`cli`/`sdk-cli`/`mcp` 等）；非交互判定 `hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !stdout.isTTY`（main.tsx:813）。`src/entrypoints/init.ts` 是 memoized 启动初始化（settings/env/hooks/LSP/遥测/cleanup 注册）。
- 构建期能力门：`feature('...')`（`bun:bundle`）与 `"external" === 'ant'` 字面量；本树按 external 面运行。

| 形态 | 入口 | 说明 |
|---|---|---|
| TUI | `replLauncher.tsx` → `src/screens/REPL.tsx` | Ink/React；各子命令最终 `launchRepl` |
| headless / SDK 子进程 | `src/cli/print.ts` `runHeadless()` | `-p`；`--output-format text/json/stream-json`、`--input-format stream-json`、`--resume`；stream-json 强制 `--verbose`（print.ts:825） |
| 协议层 | `src/cli/structuredIO.ts`、`src/cli/remoteIO.ts` | control_request/response、权限询问、SDK 事件下发 |
| MCP server | `src/entrypoints/mcp.ts`（`doge mcp serve`） | stdio MCP server |
| HTTP/SSH/直连 | `main.tsx` `server`/`ssh`/`open` | `feature('DIRECT_CONNECT')`/`feature('SSH_REMOTE')` 门后；**恢复缺口**：`src/server/` 仅 direct-connect 三件套，`server.ts`/`sessionManager.ts`/`backends/` 缺失，未实测 |
| IM 远程 | `im` 子命令 + `src/utils/imRemote/` | Telegram/飞书/企业微信/扫码网页；状态 `~/.doge/im-remote*.json`、`im-remote-daemon.log` |
| SDK 类型 | `src/entrypoints/sdk/{coreSchemas,controlSchemas}.ts` + `src/entrypoints/agentSdkTypes.ts` | 只有 schema；SDK 运行时在外部 `@anthropic-ai/claude-agent-sdk`，由它 spawn 本 CLI |

## 3. API 协议层

**三协议转换链**（`CLAUDE_CODE_COMPATIBLE_API_PROVIDER`；仅接受 `openai`/`responses`，其余值回落**已持久化的 provider，再回退 `anthropic`**）：

- anthropic：`api/claude.ts`（主循环）+ `api/client.ts`（SDK client/header/BaseURL/自定义头），原生流式 Messages。
- openai：`api/openaiCompat.ts` 把 Messages 请求改写为 Chat Completions（文本/图片 part、tools、tool_choice、reasoning_effort、web_search 字段），远端 SSE 回转成内部 `BetaRawMessageStreamEvent`（reasoning_content、tool_calls 增量、usage）。
- responses：`api/responsesCompat.ts` 改写为 Responses API（`input_text`/`input_image`、`function_call`/`function_call_output`），复用 openaiCompat 工具，流式回转。
- 共用：`withRetry.ts`（按错误类拆预算）、`streamErrors.ts`、`requestLifecycle.ts`（流生命周期与 keep-alive-only SSE 上限，`CLAUDE_STREAM_EVENT_GAP_MS` 默认 180s）、`streamRecovery.ts`（已完整 tool block 前的重放）。

**双密钥互斥**：`DOGE_API_KEY` → SDK `apiKey` → `x-api-key`；`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`。并存时 `src/utils/apiKeyExclusivity.ts` `enforceApiKeyExclusivity()` 在 settings env 落地后按激活 profile 的 `authTokenType` 裁决：删除落败一方并告警，不拒绝启动（ssh auth-proxy/CCD 场景跳过）。其余认证：`ANTHROPIC_CUSTOM_HEADERS`（每行 `Name: Value`）、`CLAUDE_CODE_OAUTH_TOKEN(_FILE_DESCRIPTOR)`、`DOGE_ACTIVE_MODEL_PROFILE`/`DOGE_ACTIVE_CONNECTION_ID`。

**Reasoning / effort 网关**：内部单一五档 `low|medium|high|xhigh|max`；能力与 wire 表达由 catalog 的 `ReasoningPolicy` 声明（`thinking`/`effort`/`response`）。`src/utils/model/reasoningPolicy.ts` 读策略并按「连接+provider+baseURL+模型」路由键禁用，`reasoningRequest.ts` 算可用档/预算/思考参数，`effortGateway.ts` 做网关映射（anthropic/openai/deepseek/glm/kimi/qwen/openrouter/xai/gemini/catalog/generic），`effortCapabilities.ts` + `effortMatrix.json` 管内建模型能力。环境门禁：`CLAUDE_CODE_EFFORT_LEVEL`（默认档）、`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`、`CLAUDE_CODE_DISABLE_EFFORT`。**诚实汇报**：`applied/downgraded/reason` 区分用户所选与真正发到 API 的档，网关不支持时可能不发字段；400 后该路由的 policy 进程内禁用，重试不再发同一参数；响应展示（`response.display` = full/summary/none、`openaiFields`）在 wire 失败后仍生效。

## 4. 模型目录与路由

**单一事实源** `~/.doge/model-catalog.json`（`src/utils/model/modelCatalog.ts`，顶层 `modelCatalog`、`version:2`、原子写 `0o600`）：

- 结构：`connections[]`（`protocol/baseURL/apiKey/authTokenType/models/defaultModelId/roles{opus,sonnet,haiku,subagent}`）、`models[]`（`upstreamModel/contextWindow/maxOutputTokens/reasoning`）、`defaultModel{connectionId,modelId}`。
- `.credentials.json`/`.claude.json` 不得持久化 model 配置；catalog 存在后旧 `customApiEndpoint` 永不回退。唯一迁移：启动 `migrateLegacyModelConfig()`（`src/utils/customApiStorage.ts`）读旧两存储 → `writeCatalogFromEndpoint` → 物理删除旧字段；之后每进程最多 scrub 一次。
- 环境物化：`src/utils/managedEnv.ts` `applyPersistedCustomApiEndpointEnv` 只补缺失值（避免磁盘 A 档混入启动 B）；`profileIdentity.ts` 做 profile 匹配。

| 解析 | 代码 | 规则 |
|---|---|---|
| 主会话模型 | `src/hooks/useMainLoopModel.ts` `resolveMainLoopModel` | `mainLoopModelForSession > mainLoopModel > 默认设置`；`parseUserSpecifiedModel` 解别名/`[1m]`/`[2m]`，`getRuntimeMainLoopModel` 依权限模式运行时升级；**`customApiStorage.model` 故意不在链上** |
| 普通 Agent | `src/utils/model/agentModelSelection.ts` `resolveAgentModelSelection` | 有效 `CLAUDE_CODE_SUBAGENT_MODEL` > 工具 `model` 参数 > Agent 定义 > 父模型；产出 `requestedModel/resolvedModel/source` |
| 队友 | `src/tools/shared/spawnMultiAgent.ts` `resolveTeammateSelection` | 同一解析机制；显示统一 `formatAgentModel`（`agentModelIdentity.ts`） |
| 档位 | `tierResolver.ts`、`restoreTierState.ts` | `ANTHROPIC_DEFAULT_*_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`；启动只补缺失 env |

**切换/快照/恢复**：`src/utils/model/switchModelProfile.ts` 的 `apply → persist → commit` 三阶段事务（失败按阶段回滚 env 快照，会话级跳过磁盘回滚）；`runtimeModelContext.ts` 的 `captureModelEnvironment`/`runWithModelEnvironment` 让 worker 保留创建时连接/认证/模型快照，父会话切模不改写；跨进程恢复按转录中的非敏感 profile/协议/端点身份，profile 被删要显式报错。

**`/model` 三条路径**（`src/commands/model/handlers.ts`）：P1 匹配 profile → 原子切连接+模型；P2 档位别名/`default` → 当前连接内解析；P3 未知裸模型名 → 只写 AppState，不碰 env/连接。默认会话级，`--save`/`DOGE_MODEL_SCOPE=global` 才持久化；档位别名始终只作用会话。边界：`best`/`opusplan` 是主模型/Agent 定义语法，不等于 Agent 工具 schema 接受；opusplan 还有启动配置条件；tmux 队友环境白名单不含认证密钥。

## 5. 工具与任务

**工具面**：`src/tools/<ToolName>/`，装配于 `src/tools.ts` + `src/hooks/useMergedTools.ts` + `src/utils/toolPool.ts`，MCP 工具经 `src/services/mcp/` 注入。按层：文件（FileRead/Edit/Write、Glob/Grep）、Shell（Bash/PowerShell）、Web（WebFetch/WebSearch/WebBrowser）、MCP、编排（Agent/Team/Workflow/Task*/Plan/Worktree）、交互（AskUserQuestion/TodoWrite/Skill/Monitor）、内部工具（Config/REPL 等，部分 feature 门后）。Fork 特有子系统：`coordinator/`、`buddy/`、`voice/`、`proactive/`、`memdir/`、`remote/`、`upstreamproxy/`、`bridge/`、`skills/bundled/`、`native-ts/`。命令解释器由 `settings.defaultShell` 与 `/shell` 装配 Bash↔PowerShell（`src/utils/shell/`）；Bash 权限与命令注入检测在 `src/tools/BashTool/bashPermissions.ts`（`CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` 可关）。

**Task 生命周期**：类型 `local_bash`/`local_agent`/`local_workflow`/`in_process_teammate`/`remote_agent`/`monitor_mcp`/`dream`（`src/tasks/`）。`src/utils/task/framework.ts` 统一登记/更新/驱逐；终态事件由各 task 实现自己发；`src/tasks/stopTask.ts` 服务 TaskStopTool 与 SDK `stop_task`（错误码 `not_found|not_running|unsupported_type`，shell 停止 join `pendingShellKill`）；`task_started` 在 resume 后再次发出，带 `output_file`/`command`/`model`/`model_selection`（`src/utils/sdkEventQueue.ts`）。后台输出在 `src/utils/task/diskOutput.ts`：`<tmp>/doge/<sanitized-cwd>/<sessionId>/tasks/<taskId>.output`，磁盘上限 5GB、读取默认 8MB tail；agent 转录用 symlink。回合末 `backgroundTaskCloseout.ts` 只**提示**主模型接管仍在跑的后台 shell（给 task_id/command/output_file），不自动杀。

**Agent / teammate / workflow**：Agent 走 `src/tools/AgentTool/{runAgent,resumeAgent}.ts` + `src/coordinator/`，创建时快照模型环境；teammate 走 `TeamCreateTool`/`SendMessageTool` + `src/tools/shared/spawnMultiAgent.ts` 与 `src/utils/swarm/{spawnInProcess,inProcessRunner,teamHelpers,permissionSync,reconnection}.ts`，数据在 `~/.doge/teams/<team>/`（inboxes/config/锁）；Workflow 走 `src/tools/WorkflowTool/`（`spec.ts` 的 MD+frontmatter、`engine.ts`、`checkpoint.ts`、`headlessStep.ts` 跨 API 子步骤），以 `local_workflow` 伞任务运行。

**headless stream-json 协议**：`--input-format stream-json` 为 NDJSON 输入；输出 assistant/user/system/result/stream。控制请求（`src/entrypoints/sdk/controlSchemas.ts`）：`initialize`、`interrupt`、`set_permission_mode`、`set_model`、`stop_task`、`cancel_async_message`、`mcp_set_servers`、`reload_plugins`、`refresh_resources`、`can_use_tool`（权限询问，双向）；响应双层 `response.response.*`。**事件顺序**：先 drain `task_started/task_progress`，再 `task_notification`，最后 `session_state_changed(idle)`——`idle` 是「回合真正结束」的权威信号（后台 agent 会延迟 result）。命令队列在 `src/utils/messageQueueManager.ts`，回合中到达的输入先入队、回合末按优先级 drain；取消信号传至工具边界。

## 6. MCP 与内置能力

- **MCP 体系**：`src/services/mcp/`（client 连接/生命周期、config 接线、auth/oauth、officialRegistry）；作用域 user/project(`.mcp.json`)/local + 内置 dynamic；`--strict-mcp-config` 只允许 `--mcp-config`。内置 CU 是**进程内 MCP**：`client.ts` 按 `isComputerUseMCPServer` 拦截，`.call()` 覆盖直接 dispatch，不启子进程。
- **Computer Use**：注册条件 `平台 macos|windows` 且（非交互或 `DOGE_HEADLESS_BUILTIN_MCP`）且 `getChicagoEnabled()`（`DOGE_COMPUTER_USE_MCP` falsy 关闭）；`setup.ts` 注册 `mcp__computer-use__*` 并注入本地 availability hint。工具/权限/坐标/UAC 细节见 [COMPUTER_USE.md](COMPUTER_USE.md)。
- **Playwright 双服务**：Playwright 无法从 Bun 驱动浏览器（pipe/WS 传输均超时），故 `playwright`（无头）/`playwright-headed`（可见）都是 Node stdio 子进程（`src/utils/playwrightMcp/`）；桌面壳按浏览器偏好改注册 `playwright-chrome|edge[-headed]`。开关 `DOGE_PLAYWRIGHT_MCP=0`；`DOGE_PLAYWRIGHT_HEADLESS=0` 让 `playwright` 也可见（legacy）；默认用系统 Chrome/Edge（`DOGE_PLAYWRIGHT_USE_SYSTEM_BROWSER`），输出目录在系统临时目录；无 Node 则不注册。权限用服务级 `mcp__<server>__*` 规则。
- **桌面壳 browser bridge**：App 注入 `DOGE_APP_PLAYWRIGHT_BRIDGE=<bridge.cjs>`；`setup.ts` 只把该脚本前置到**无头**服务 argv（headed 不挂桥）。bridge 在 App 侧懒拉起无头浏览器并以 `--cdp-endpoint` 接管，CLI 只透传、不校验；浏览器缺失/非 Chromium 由 App 回落原生 MCP。
- **headless 内置 MCP**：默认 `-p` 不注册 CU/Playwright（避免残留浏览器/锁）；桌面壳长驻 headless 用 `DOGE_HEADLESS_BUILTIN_MCP=1` 显式开启。

## 7. 存储与数据生命周期

| 位置 | 内容 |
|---|---|
| `~/.doge`（`CLAUDE_CONFIG_DIR` 可覆盖） | `settings.json`、`.claude.json`（全局配置历史命名）、`.credentials.json`、`model-catalog.json`、`backups/`、`projects/<sanitized-cwd>/`（`*.jsonl` 转录、`tool-results/`、`memory/`）、`teams/`、`tasks/<taskListId>/*.json`（文件任务列表）、`plans/`、`plugins/`、`cache/`、`file-history/`、`shell-snapshots/`、`debug/`、`history.jsonl`、`agents/`、`skills/`、`rules/`、`workflows/`、`jobs/`、`uploads/`、`im-remote*`、`computer-use.lock` |
| `<项目>/.doge/` | `settings.json`/`settings.local.json`、`agents/`、`skills/`、`commands/`、`rules/`、`workflows/`、`CLAUDE.md`、`agent-memory*/`、`worktrees/`、`scheduled_tasks.json`；已 gitignore |
| OS 临时目录 | 任务输出 `<tmp>/doge/<sanitized-cwd>/<sessionId>/tasks/<taskId>.output`（Windows `%TEMP%\doge\`，Unix `/tmp/doge-<uid>/`）、`scratchpad/`、bundled skills 解压（随机 nonce）；日志缓存在 `env-paths('claude-cli')` |

**生命周期**：`src/utils/cleanup.ts` 以 `cleanupPeriodDays`（默认 30）清旧 `projects/**/*.jsonl|.cast`、`tool-results/`、`plans/`、`file-history/`、`shell-snapshots/`、`debug/`、旧缓存；项目 `memory/` 与会话转录是用户数据，不在清理目标内，**不可当垃圾删**。**不可删清单**：`~/.doge/projects/<proj>/memory/`、会话 `.jsonl`（未过期）、`~/.doge/.credentials.json`（重建需重新配密钥）。**迁移遗留**：启动时一次性把旧 `customApiEndpoint` 的 model 配置搬入 catalog 并 scrub 旧存储；`.claude.json` 保留其它全局字段，备份会剥离明文 key，catalog/配置写盘 `0o600`。

## 8. 安全边界

- **权限模式**（`types/permissions.ts`）：`default`、`plan`、`acceptEdits`、`bypassPermissions`（界面名 Auto）、`dontAsk`；`auto`/`bubble` 为 feature 门后。规则来源 user/project/local/flag/policy/cli/command/session，行为 allow/deny/ask。headless 权限询问走 `can_use_tool` control_request，`--permission-prompt-tool` 可交给 MCP 工具。
- **Hooks**：settings 事件含 `PreToolUse`/`PostToolUse(Failure)`/`UserPromptSubmit`/`SessionStart`/`Setup(init|maintenance)`/`SubagentStart`/`PermissionDenied`/`PermissionRequest`/`Notification`/`Elicitation(Result)`/`CwdChanged`/`FileChanged`/`WorktreeCreate`/`WorktreeRemove`（`src/utils/hooks/hooksConfigManager.ts`）；hooks 可拒绝/改写工具调用，与权限同级；项目 settings 在信任对话前不应用。
- **沙箱**：`src/utils/sandbox/sandbox-adapter.ts` 包装 `@anthropic-ai/sandbox-runtime`（文件读写/网络 host 限制/违规事件）；doge 追加 deny-write `<cwd>/.doge/settings*.json` 与上游 `.claude` 对应项；`/sandbox`（`src/commands/sandbox-toggle/`）开关/配置；沙箱网络请求以 `SandboxNetworkAccess` 走权限询问。
- **密钥与敏感数据**：凭证存 `~/.doge/.credentials.json`（secureStorage，写后 `0600`）；catalog/转录/team 文件 `0600`、目录 `0700`；配置备份剥离明文 key；`src/utils/subprocessEnv.ts` 默认清除子进程 doge 凭证（`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 三态）。`.claude/` 例外仅三处：`src/utils/ide.ts` 读官方扩展 lockfile、`src/utils/doctorDiagnostic.ts` 检测官方安装、`src/utils/sandbox/sandbox-adapter.ts` 对 `.claude/settings*.json`/`.claude/skills` deny-write。
- **ANT-ONLY**：带 `ANT-ONLY import markers must not be reordered` 注释的 import 禁止重排（构建期 DCE/依赖顺序）；`"external" === 'ant'` 分支在本树全部关闭。

## 9. 测试与验证规范

**门禁**：定向 `bun test` → 全量裸 `bun test` → `bun tools/run-isolated-tests.ts` → 相关 e2e/实机 → `bun run version` → `git -c core.whitespace=cr-at-eol diff --check` → 独立 review（Critical/Important 闭环）→ 清理 `test/`、后台任务、沙箱。`package.json` 无 lint/test/build 脚本，勿虚构命令。可复用 e2e/repro/probe/mock/check 进 `tools/`，一次性产物进 `test/` 并清空。

**隔离**：`bunfig.toml` preload `tools/test-setup.ts`（缺失凭证时给 dummy `DOGE_API_KEY`）；裸测暴露共享进程交互，隔离器每文件独立进程 + 独立 `CLAUDE_CONFIG_DIR`，二者互补，隔离器通过不能替代裸测。

**环境变量污染源**：`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`、`DOGE_ACTIVE_MODEL_PROFILE`、`ANTHROPIC_BASE_URL`、`CLAUDE_CODE_COMPATIBLE_API_PROVIDER`、双密钥、`CLAUDE_CODE_OAUTH_TOKEN(_FILE_DESCRIPTOR)`、`CLAUDE_CODE_UNATTENDED_RETRY`、`TERM_PROGRAM`、`ANTHROPIC_MODEL`/tier env、custom headers。测试显式隔离、不继承宿主。

**常见假红**：全局 `mock.module()` 跨文件污染；模型测试需同时 reset `runtimeModelContext`/`managedEnv`/config cache/settings cache/`getAutoMemPath.cache`；`saveGlobalConfig` 合并更新（清字段用 `undefined`）；`file:` 依赖是 node_modules 静态副本，改 `packages/@ant/*` 后必须 `bun install`；Bun `spawnSync.timeoutMs` 无效（用 Node `spawnSync.timeout`）；Windows 第三次点击可能报 `1,2,1`；原生滚轮首次反向被防抖。失败必须归因，禁止「基线问题」、改断言求绿、skip 覆盖、只跑隔离器。

## 10. 已知限制 / ant-only / 未实测

- **macOS CU 不可用**：`@ant/computer-use-swift` 解析到 `shims/ant-computer-use-swift`（固定 1440×900 空白 JPEG、`tcc` 检查恒 false），input 侧只有 osascript 实现；实机未验证。
- **Linux CU 未注册**：`src/utils/computerUse/platforms/linux.ts` 存在但注册仅 windows/macos。
- **server/ssh/open 恢复不完整**：见 §2；相关子命令未实测。
- **ANT-ONLY**：`up/rollback/task/log/error/export`、部分工具与提示在本树不注册；`USER_TYPE=ant` 运行时分支仍存在。
- **SDK**：本仓只有 schema + stream-json 子进程协议；SDK 运行时在外部包。
- **Playwright**：依赖 Node 与 `@playwright/mcp`（任一缺失不注册）；桌面镜像还需 App 侧 `bridge.cjs`。
- **目录边界**：`best` 上下文后缀、opusplan 启动配置条件、队友 tmux 环境白名单按 §4 现状，不要写成已修复。
- **未实测**：macOS CU、混合 DPI 多屏、无管理员账户/受限令牌 CU、旧 catalog 迁移全部变体、server/ssh 端到端、IM 真实账号链路。

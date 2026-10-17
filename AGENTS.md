# AGENTS.md — Doge Code 仓库指南

面向 AI 编码代理（Claude Code / Doge Code 等），假设读者对项目一无所知；内容基于当前仓库实际核实，不要凭空假设。**任何任务开始前先读第一节开发纪律。**修复历史（每条三行：问题/解决/位置）见 [development_logs.md](development_logs.md)。

## 一、开发纪律（硬性规定，违反即测试无效）

1. **新开分支**：每次执行新开发任务，开工前必须从基线分支（通常为 main）新开 git 分支（`git checkout -b feature/<任务名>`），禁止直接在 main 上开发合并。
2. **收尾三问**：任务完成时，必须向用户逐条提醒并等待确认，未经答复不得擅自执行：
   - ① 确认好本轮自己的修改，然后提交分支修改（如有非自己做的修改，不要提交，先列出未提交改动的文件清单让用户确认）；
   - ② 是否将分支合并进 main（确认后 `git checkout main && git merge feature/<任务名>`，并复核 main 可构建/冒烟通过，本仓库用 `bun run version`）；
   - ③ 是否删除该功能分支（确认合并后 `git branch -d`；若要删除尚未合并的分支，必须由用户明确授权 `-D`）。

   三问均有着落任务才算收尾；用户明确表示"都不用"可跳过。
3. **测试目录分工（test=临时，tools=可复用）**：`test/` 只存放临时测试产物（脚本、图片、视频、日志、沙箱、样例文件等），测试结束后全部删除，不在 git 内跟踪；`tools/` 是可复用测试脚本（e2e、repro、probe、mock、验证脚本等）的唯一存放地，受 git 跟踪。任何测试类脚本禁止散落在仓库其他位置——要复用的进 `tools/`，一次性用完即删的进 `test/`。
4. **C 盘写入纪律**：向 C 盘（或任何系统盘/系统临时目录）写入任何内容必须遵守——测试期间如需写入，测试结束后必须删除本次产生的全部测试数据，不允许留存在 C 盘内。
5. **提交与风格**：提交信息用简短祈使句（历史风格如 `Support web search for openai and responses API formats`，中英文均有）；坚持最小化、可审计的改动；带 `ANT-ONLY import markers must not be reordered` 注释的 import 禁止重排序。
6. **收尾必过 code-review 与全量测试回归**：每次完成开发，必须发起子代理对本轮改动做 code-review，并做好全量的功能测试与回归验证（单测 + 相关 e2e + `bun run version` 冒烟），review 与全量功能测试回归通过才算完成。
7. **代码各司其职**：编码全程遵循高内聚低耦合、代码规范清晰，调试文字要少（能删则删，不留临时 console/debug 输出）。

## 二、项目概述

**Doge Code**（`@doge-code/cli`，全局命令 `doge`）是 Claude Code 的第三方 Fork：基底是从 source map 逆向还原的 Claude Code 源码树，其上做了自主魔改，聚焦多提供商 API 兼容与自托管接入。它不是官方上游镜像，行为与官方 Claude Code 存在差异。

- **核心设计**：内部代码始终使用 Anthropic Messages 格式，协议转换只发生在 API 边界，由 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 选择提供商：`anthropic`（`/v1/messages`，SDK 直连）、`openai`（`src/services/api/openaiCompat.ts`）、`responses`（`src/services/api/responsesCompat.ts`；两者均为双向转换含流式回转，"实验性"是本仓库对稳定性的定性，代码内无对应标注）
- **双密钥严格互斥**：`DOGE_API_KEY` → `x-api-key` header；`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`；并存时启动卫兵 `enforceApiKeyExclusivity`（`src/utils/apiKeyExclusivity.ts`）按激活 profile 裁决：删除落败一方的 env 并告警，不拒绝启动
- **与官方 Claude Code 数据完全隔离（创始原则）**：全局配置目录 `~/.doge`（`CLAUDE_CONFIG_DIR` 可覆盖；注意全局配置文件名为 `~/.doge/.claude.json`，是隔离原则下保留的历史命名）。项目级一切资源（agents/skills/commands/settings 等）一律在 `<项目>/.doge/` 下，代码不读也不写任何 `.claude/` 路径。接触 `.claude/` 的例外共三处：`src/utils/ide.ts` 读官方 VSCode 扩展 lockfile、`src/utils/doctorDiagnostic.ts` 检测官方安装（均为有意的官方互操作）；`src/utils/sandbox/sandbox-adapter.ts` 对 `<cwd>/.claude/settings*.json` 与 `.claude/skills` 加 deny-write 沙箱保护（防写，非读写）
- 技术栈：TypeScript（ESM）+ React JSX/Ink TUI；CLI 解析用 Commander（`src/main.tsx`）；运行时 Bun ≥ 1.3.5、Node ≥ 24，依赖以 `bun.lock` 为准；**无打包构建产物**，直接以 Bun 运行 TS 源码（分发 = git 源码 + `bun link`，无 CI）；`tsconfig.json` `strict: false`、别名 `src/*`；代码风格：多数文件无分号、单引号
- **模型配置优先级**：启动时显式 env / settings.env 优先；`applyPersistedCustomApiEndpointEnv` 按显式 Profile 身份、主模型与连接定位 Profile，仅补齐缺失值，避免磁盘 A 档位混入启动 B。未指定启动主模型/连接时恢复持久化 activeProfileId；`/model` 默认会话级，`--save` 才固化。运行中 worker 保留创建时模型/连接快照，排障同时检查启动配置、活跃 Profile 与 worker 创建时间（详见 development_logs.md）
- **高风险面**：`src/utils/computerUse/` 涉及真实键鼠注入与截图，改动需充分手动验证；API Key 持久化在 `~/.doge`（`.credentials.json`，另有 `~/.doge/.claude.json` 镜像与 `~/.doge/backups/` 备份），不得写入仓库、提交 git 或打进日志

### 关键环境变量（完整语义见源码与 development_logs.md）

| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` | API 格式：`anthropic` / `openai` / `responses`（非法值回落 `anthropic`） |
| `ANTHROPIC_BASE_URL` + `DOGE_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`） | 自定义端点 + 密钥（双密钥互斥） |
| `ANTHROPIC_CUSTOM_HEADERS` | 每行 `Name: Value`，为每个 API 请求追加自定义头 |
| `ANTHROPIC_MODEL` | 默认模型；`[1m]`/`[2m]` 后缀仅本地剥离用于上下文窗口计算，不发给 API |
| `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL` | 各层级 Agent 模型（未设时 fallback 到主模型） |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Task/subagent 层模型覆盖 |
| `ANTHROPIC_SMALL_FAST_MODEL` | 轻量后台任务（haiku 层）模型 |
| `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` | 覆盖上下文窗口大小（token 数，如 `200000`） |
| `CLAUDE_CODE_EFFORT_LEVEL` | 努力等级：`low` / `medium` / `high` / `xhigh` / `max` |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | 无视模型名单，强制启用 effort 参数 |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | 子进程密钥清理三态：未设=默认清除 doge 凭证；truthy=全量清单；falsy=关闭 |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | 设 truthy（如 `1`）启用 teammate 群聊（亦可 `--agent-teams` 或 `/agent-teams`） |
| `DOGE_MODEL_SCOPE` | 模型切换作用域：`session`（默认）/ `global` |
| `CLAUDE_CONFIG_DIR` | 覆盖配置目录（默认 `~/.doge`） |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 关闭遥测/tips 等非必要网络流量 |
| `CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` | 关闭 Bash 命令注入检测（安全相关，慎用） |
| `DOGE_RIPGREP_PATH` | 覆盖内置 ripgrep 二进制路径 |
| `DOGE_HEADLESS_BUILTIN_MCP` | headless 模式下启用内置 MCP（含 Playwright） |
| `DOGE_PLAYWRIGHT_MCP` / `DOGE_PLAYWRIGHT_*` | 内置 Playwright MCP 开关与浏览器配置（`DOGE_PLAYWRIGHT_MCP=0` 关闭） |

- **Auto 自动计划（2.1.280）**：`autoPlan` 只标记模型从 bypassPermissions 进入的 Plan，手动 Plan（含旗标启动会话）保留交互；只读工具和当前计划文件可执行，配置/hook allow 不可越过边界。ExitPlan 自动回 Auto；切到其他模式统一清 prePlanMode/autoPlan。远程接入/新 prompt 保留自动 Plan；`plan_mode` attachment（含 compact）记录来源，历史按 snapshot 渲染。AskUserQuestion（2.1.300）保留人工询问：CLI单一300000ms期限，未提交按label末尾推荐标记自动选择（无推荐首项、多选全部推荐），结果诚实标自动来源；TUI与mailbox队首展示才起钟，stdio/MCP/无宿主/队友共用一次性决胜，取消/人工答复结束计时与迟到副作用。MCP elicitation 表单/URL retry 仍走原共享自动应答并过 ElicitationResult hooks 与 SDK schema 校验，不挂询问队列；显式 deny 与 killswitch 保留。测试：tools/auto-plan.test.ts、tools/auto-elicitation.test.ts，App tools/verify-auto-plan.mjs 与 verify-im-remote R18。

## 三、仓库地图（src 之外的关键目录，勿误解/误删）

- `needs/` — 随仓库维护的默认资源暂存：hooks 脚本、`settings.json` 模板、skills 副本，面向 `~/.doge/`（其中 hook 命令指向 `~/.doge/hooks/`）；不被 src 直接引用，改动后需自行同步到目标位置
- `shims/` — 缺失原生/私有包的本地 `file:` 替身（`ant-claude-for-chrome-mcp`、`ant-computer-use-swift`、`color-diff-napi`、`modifiers-napi`、`url-handler-napi`）
- `packages/@ant/` — 本地实体包：`computer-use-input`（键鼠注入）、`computer-use-mcp`、`computer-use-swift`、`claude-for-chrome-mcp`
- `vendor/` — 原生模块源码（`audio-capture-src`、`image-processor-src`、`modifiers-napi-src`、`url-handler-src`）
- 根级 `image-processor.node`、`build/bin/` — 原生二进制与脚本
- `tools/` — 可复用测试脚本（e2e、repro、probe、mock，git-tracked）；`test/` — 临时测试产物（用完即删，不跟踪）
- `development_logs.md`、`README.md`、`computer_use.md`

### src 内 fork 特有子系统（无上游可对照，改动前先读对应模块）

`src/coordinator`（coordinator/worker 编排）、`src/buddy`（BUDDY 桌宠）、`src/voice`、`src/proactive`、`src/services/autoDream`、`src/memdir`（记忆目录）、`src/tasks`（`doge task`）、`src/remote` + `src/upstreamproxy`（远程/上游代理）、`src/bridge`（REPL 桥接）、`src/skills/bundled`（内置 skills，如 `/debug`）、`src/services/mcp/`（内置 MCP 体系：连接管理/OAuth/registry；computer-use 走 `packages/@ant/computer-use-mcp` + `src/utils/computerUse/hostAdapter.ts`）

## 四、CLI 使用面（产品形态）

- **关键 flags**（定义于 `src/main.tsx`）：`-p/--print`（headless）、`--output-format text|json|stream-json`、`--input-format`、`--settings <file-or-json>`、`--mcp-config`、`--agents <json>`、`--permission-mode`、`--dangerously-skip-permissions`、`--bare`（最小模式：跳过 hooks/LSP/插件同步/auto-memory/CLAUDE.md 自动发现等，认证仅走 `DOGE_API_KEY`/apiKeyHelper）、`-w/--worktree [name]`（配 `--tmux`）、`--agent-teams`、`--debug[=<pattern>]`
- **子命令**：`mcp`（serve/add/add-json/remove/list/get/reset-project-choices）、`server`（HTTP 会话服务器）、`ssh <host> [dir]`（远程部署 + auth 隧道回连本地）、`open <cc-url>`（连接远端 server）、`auth login/status/logout`、`plugin`（含 `marketplace`）、`agents`、`doctor`、`update`/`install`、`rollback`、`auto-mode`、`remote-control`、`im`（IM 远程控制守护进程：多频道并存——自定义 bot 读 ~/.doge/im-remote.json（Telegram/飞书/企业微信智能机器人长连接），扫码网页频道读 ~/.doge/im-remote-web.json（独立文件：0.0.0.0 内嵌手机聊天页 + 令牌门 WS，QR=`http://<局域网IP>:<port>/#t=<token>`，主地址经 nicPriority 过滤排序——虚拟网卡〔中英文网卡名都要盖：vEthernet/VMware/vgate/蓝牙/Bluetooth/本地连接\*/Local Area Connection\*/Wi-Fi Direct〕与 169.254 排除、192.168 网段优先，勿回退 networkInterfaces 原序）；**localhost Bun.serve 必须 try/catch（端口被占同步抛，不接住=适配器在跑+状态文件停更的僵尸）；ImAdapterHandlers.onStopped 是终态回传通道（disconnected_event 类事件勿只在适配器内部置 stopped——daemon running 会谎报）；wecom 出站 ack 的 req_id 是透传的（无 aibot_ 前缀勿按前缀识别）；Auto 强切判定单点 utils/imRemote/autoMode.ts；daemon 日志记扫码 URL 必须 redactWebUrl（状态文件/monitor 帧保留完整）**；127.0.0.1 WS 会话自动接入（im/web 任一 token 均可）；无会话时暂存 prompt 并发 no_session 帧给壳唤起；飞书接收走官方长连接〔pbbp2 protobuf 帧，开发者后台需选「使用长连接接收事件」〕+ 历史轮询保底、双路 message_id 去重；每条入站消息前重读磁盘配对态，未捕获异常一律先落 im-remote-daemon.log；**配对按平台隔离（2.1.274）：`pairs`/`allowedUsersByPlatform`/`outboundChats` 三键均 daemon 属主、每平台各一份——/pair 按来源平台验码与消耗（跨平台码互斥）、broadcastIm 只发有配对用户的 bot 平台（web 恒放行）、出站会话绑定走 ImAdapter.bindChat 门后绑定（配对 force 接管、变更持久化 outboundChats、启动恢复——勿回退任何平台在门内自绑，勿把绑定改回内存态）**；模块 src/utils/imRemote/，详见 development_logs.md 第十二/十三节）、`assistant`、`completion`、`setup-token`；`up`/`task`/`log`/`error`/`export` 为 [ANT-ONLY]
- **多形态入口**：`src/entrypoints/`（`sdk/`、`cli.tsx`、`init.ts`、`mcp.ts`）——TUI 之外还有 SDK、MCP server、HTTP server、SSH 远程等形态
- **Hooks 系统**：settings.json 可配 hooks；doge 扩展了 `WorktreeCreate`/`WorktreeRemove` 等事件与 Setup/maintenance/init 触发（`src/utils/hooks/hooksConfigManager.ts`，样例见 `needs/settings.json`）

## 五、常用命令与测试

```bash
bun install / bun link      # 安装依赖并注册全局 doge 命令
bun run dev                 # 启动 CLI/TUI（入口 src/bootstrap-entry.ts）
bun run version             # 输出版本号，冒烟验证 CLI 可启动
bun test <路径>             # bun:test 单测；裸跑会执行 src/ 与 tools/ 下全部测试文件（bun 自动跳过 node_modules），较慢，建议按路径过滤
bun tools/e2e-xxx.ts        # e2e 为独立脚本直接运行（非 bun:test），自建 CLAUDE_CONFIG_DIR 临时沙箱并自清理
```

- package.json **没有** `lint`/`test`/`build` 脚本；单测与代码同目录（`*.test.ts`）；实机 e2e/repro/probe 脚本在 `tools/` 下（git-tracked、自带沙箱清理、可重复运行）
- 改动后除单测外，`bun run version` 冒烟 + `bun run dev` 手动验证受影响路径
- 调试：`--debug`（`--debug=<pattern>` 白名单、`!` 前缀黑名单，另有 `--debug-to-stderr`/`--debug-file`）、`/debug` 命令；日志在 `~/.doge/debug/<sessionId>.txt`
- `~/.doge/` 布局：`settings.json`/`settings.local.json`、`.claude.json`（全局配置）、`projects`/`sessions`/`tasks`/`teams`/`plans`/`plugins`/`cache`/`file-history`/`shell-snapshots`/`backups`/`debug`

## 六、参考文档

- [development_logs.md](development_logs.md) — 修复历史（每条三行：问题/解决/位置）
- `README.md` — 项目定位、安装、更新流程（中文）；`computer_use.md` — Computer Use 专项说明

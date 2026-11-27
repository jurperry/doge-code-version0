# AGENTS.md — Doge Code 仓库指南

面向 AI 编码代理（Claude Code / Doge Code 等），假设读者对项目一无所知；内容基于当前仓库实际核实。**任何任务开始前先读第一节开发纪律。** 架构与机制见 [docs/DESIGN.md](docs/DESIGN.md)，可复用经验/版本索引/欠账见 [development_logs.md](development_logs.md)，定位与安装见 [README.md](README.md)。

## 一、开发纪律（硬性规定，违反即测试无效）

1. **新开分支**：每次执行新开发任务，开工前必须从基线分支（通常为 main）新开 git 分支（`git checkout -b feature/<任务名>`），禁止直接在 main 上开发合并。
2. **收尾三问**：任务完成时，必须向用户逐条提醒并等待确认，未经答复不得擅自执行：
   - ① 确认好本轮自己的修改，然后提交分支修改（如有非自己做的修改，不要提交，先列出未提交改动的文件清单让用户确认）；
   - ② 是否将分支合并进 main（确认后 `git checkout main && git merge feature/<任务名>`，并复核 main 可构建/冒烟通过，本仓库用 `bun run version`）；
   - ③ 是否删除该功能分支（确认合并后 `git branch -d`；若要删除尚未合并的分支，必须由用户明确授权 `-D`）。

   三问均有着落任务才算收尾；用户明确表示"都不用"可跳过。
3. **测试目录分工（test=临时，tools=可复用）**：`test/` 只存放临时测试产物（脚本、图片、视频、日志、沙箱、样例文件等），测试结束后全部删除，不在 git 内跟踪；`tools/` 是可复用测试脚本（e2e、repro、probe、mock、验证脚本等）的唯一存放地，受 git 跟踪。任何测试类脚本禁止散落在仓库其他位置——要复用的进 `tools/`，一次性用完即删的进 `test/`。
4. **C 盘写入纪律**：向 C 盘（或任何系统盘/系统临时目录）写入任何内容必须遵守——测试期间如需写入，测试结束后必须删除本次产生的全部测试数据，不允许留存在 C 盘内。
5. **提交与风格**：提交信息用简短祈使句（历史风格如 `Support web search for openai and responses API formats`，中英文均有）；坚持最小化、可审计的改动；带 `ANT-ONLY import markers must not be reordered` 注释的 import 禁止重排序。**一个功能分支只允许递增一次版本号——无论该版本是否已编译、打包、装机或交付，跨会话继续开发、修复、重编都沿用该分支已定的版本号，不得再次递增；分支被删除之前不再对该分支做任何版本递增决定，分支删除时它的版本号即为最终版本，下一次递增只能随下一个任务的新分支进行（一个分支一个版本号是铁律）**。`development_logs.md` 新增记录必须使用三段式——`1. 遇到问题：…`、`2. 解决方法：…`、`3. 代码位置：…`，保持简洁，末尾的 `## §2 版本里程碑索引` 表格首行必须补充 `| 2.1.xxx | MM-DD | 精简的描述修订内容 |`，表头固定为 `| 版本 | 日期 | 主题与关键点 |`（历史表为 `| 版本 | 里程碑 |` 时保持原表头），分隔行为 `|---|---|---|`；该索引行不得混入三段式正文。
6. **收尾必过 code-review 与全量测试回归**：每次完成开发，必须发起子代理对本轮改动做 code-review，并做好全量的功能测试与回归验证（单测 + 相关 e2e + `bun run version` 冒烟），review 与全量功能测试回归通过才算完成。
7. **代码各司其职**：编码全程遵循高内聚低耦合、代码规范清晰，调试文字要少（能删则删，不留临时 console/debug 输出）。
8. **分支结束必同步安装源码**：`doge-code-install/` 是可整体拷到别的电脑、`bun install --frozen-lockfile && bun link` 即可使用的最小无依赖安装源码（只含运行源码与本地包，不含测试、工具、文档与 `node_modules`）。每次分支开发**提交之后、合并之前**必须运行 `bun tools/sync-install-source.ts --verify` 并把输出一并提交（通常紧跟功能提交再提一笔），之后再直接分发使用。该目录除 `README.md` 的说明正文外全部由工具按清单从已提交的源码逐字节生成，禁止手改；运行时新增目录、本地包或源码资源时先改工具里的清单再同步；`bun tools/sync-install-source.ts --check` 用于确认它没有过期。

## 二、项目简述

`@doge-code/cli`（命令 `doge`）是 Claude Code 的第三方 Fork：还原源码 + 自主二开，聚焦多提供商 API 兼容与自托管接入。

- **核心设计**：内部统一 Anthropic Messages，协议转换只在 API 边界（`src/services/api/{openaiCompat,responsesCompat}.ts` 双向转换 + 流式回转）；自定义接入由 `~/.doge/` 持久化数据驱动，不依赖官方登录态。
- **数据隔离**：全局 `~/.doge`（`CLAUDE_CONFIG_DIR` 可覆盖）、项目级 `<项目>/.doge/`；不读写 `.claude/`，例外仅 IDE lockfile、doctor 检测、沙箱 deny-write 三处（DESIGN §8）。
- **模型目录**：`~/.doge/model-catalog.json` 为单一事实源；旧 `customApiEndpoint` 只在启动迁移时读，之后不回退；`/model` 默认会话级，worker 保留创建时快照（DESIGN §4）。
- **技术栈**：TypeScript（ESM）+ React/Ink；Commander（`src/main.tsx`）；Bun ≥1.3.5、Node ≥24；`bun.lock` 为准；无打包产物，Bun 直跑 TS；`tsconfig.json` `strict:false`、别名 `src/*`。
- **高风险面**：`src/utils/computerUse/` 与 `packages/@ant/computer-use-mcp` 涉及真实键鼠/截图，改动必须实机验证；API Key 在 `~/.doge/.credentials.json`，不得入库、提交或打进日志。

### 关键环境变量（关键子集，完整语义见 DESIGN §3/§4 与源码）

| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` | `anthropic` / `openai` / `responses`（非法值→持久化 provider→anthropic） |
| `ANTHROPIC_BASE_URL` + `DOGE_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` | 自定义端点 + 密钥（双密钥互斥） |
| `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` | 主模型与各层级模型；`[1m]`/`[2m]` 后缀仅本地剥离 |
| `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` / `CLAUDE_CODE_DISABLE_EFFORT` | effort 档位与门禁（自定义端点由 model catalog 声明） |
| `DOGE_MODEL_SCOPE` | 模型切换作用域：`session`（默认）/ `global` |
| `CLAUDE_CONFIG_DIR` | 覆盖配置目录（默认 `~/.doge`） |
| `DOGE_HEADLESS_BUILTIN_MCP` | headless 模式注册内置 MCP（CU/Playwright） |
| `DOGE_COMPUTER_USE_MCP` / `DOGE_PLAYWRIGHT_MCP` | 内置 CU / Playwright MCP 开关（`=0` 关闭） |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | 子进程密钥清理三态（未设=清 doge 凭证；truthy=全量；falsy=关） |
| `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` / `DOGE_HEADLESS_AUTO_MEMORY` | 壳注入的上下文窗口覆盖 / headless 自动记忆开关（App↔CLI 集成契约，勿删读侧） |

## 三、仓库地图（src 之外）

- `needs/` — 面向 `~/.doge/` 的默认资源暂存（settings 模板、hooks、skills）；不被 src 直接引用。
- `shims/` — 缺失原生/私有包的 `file:` 替身（`ant-computer-use-swift`、`ant-claude-for-chrome-mcp`、`*-napi`）；`package.json` 依赖实际指向这里。
- `packages/@ant/` — 本地实体包：`computer-use-mcp`（工具/权限/批次/坐标）、`computer-use-input`（macOS 键鼠后端）、`computer-use-swift`（macOS 原生层，依赖实际指向 `shims/`）、`claude-for-chrome-mcp`。
- `vendor/` — 原生模块源码；根级 `image-processor.node`。
- `doge-code-install/` — 最小可安装源码分发（纪律第 8 条）：`src/`（不含测试）、`packages/@ant/{computer-use-input,computer-use-mcp}`、`shims/`、`vendor/{modifiers-napi-src,url-handler-src}` 与锁文件，由 `tools/sync-install-source.ts` 从已提交的源码逐字节生成，可整体拷走独立安装。
- `tools/` 可复用测试脚本（git），其中 `tools/sync-install-source.ts` 生成并校验 `doge-code-install/`；`test/` 临时产物（不跟踪）；根文档见 §六。

## 四、CLI 使用面

- **关键 flags**（`src/main.tsx`）：`-p/--print`、`--output-format text|json|stream-json`（stream-json 需 `--verbose`）、`--input-format`、`--settings`、`--mcp-config`、`--agents`、`--permission-mode`、`--dangerously-skip-permissions`、`--bare`（跳过 hooks/LSP/插件同步/auto-memory/CLAUDE.md 自动发现，认证仅 `DOGE_API_KEY`/apiKeyHelper）、`-w/--worktree`（配 `--tmux`）、`--agent-teams`、`--model`、`--effort`、`-c/--continue`、`-r/--resume`、`--debug[=<pattern>]`。
- **子命令**：`mcp`（serve/add/add-json/remove/list/get/add-from-claude-desktop/reset-project-choices）、`auth login/status/logout`、`plugin`（含 `marketplace`）、`agents`、`doctor`、`update`/`install`、`auto-mode`、`im`、`completion`、`setup-token`；`server`/`open`/`remote-control`/`assistant` 在 `feature()` 门后且部分为恢复缺口（DESIGN §2/§10，勿当可用现状）；`ssh` 已实装，源码运行依赖系统 OpenSSH（Windows App 安装版随包提供）与远端预装 doge CLI：交互形态是本地 REPL 驱动远端（`/model` 与权限模式都会同步到远端）；另有两个供桌面 App 驱动的管道形态——`--stream` 把本机 stdio 中继到远端 headless 会话、`--files` 在一条连接上提供远端文件读取与项目管理（POSIX sh 循环；归档/删除只收单段项目目录名与会话号，改动只落在项目目录之内与以会话号命名的附属数据上，项目目录是符号链接时拒绝），两者都在 `init()` 之前运行（管道 stdout 否则会被归为 --print）。支持 `--probe` 诊断与 `--local` 协议测试；隧道令牌只在 initialize 后经控制通道下发、不得写入 argv；发往远端的环境只取 `remoteModelEnvironment` 白名单，密钥/真实端点/本机路径不出本机；暂不支持自动部署；`up`/`rollback`/`task`/`log`/`error`/`export` 为 ANT-ONLY（本树不注册）。
- **Hooks**：settings.json 可配，事件含 `PreToolUse`/`PostToolUse`/`Setup`/`SubagentStart`/`WorktreeCreate`/`FileChanged` 等（`src/utils/hooks/hooksConfigManager.ts`，样例 `needs/settings.json`）。

## 五、常用命令与门禁

```bash
bun install / bun link      # 安装并注册全局 doge（改 packages/@ant/* 后必须重跑 install）
bun run dev                 # TUI（入口 src/bootstrap-entry.ts）
bun run version             # 版号 + 冒烟
bun test <路径>             # 定向 bun:test
bun test                    # 全量裸测（src/ 与 tools/，较慢）
bun tools/run-isolated-tests.ts   # 每文件独立进程 + CLAUDE_CONFIG_DIR 隔离
bun tools/e2e-model-routing.ts    # e2e 直接运行（自建沙箱并自清理；其余脚本见 tools/）
bun tools/sync-install-source.ts --verify   # 同步 doge-code-install/ 并在仓库外独立安装验证（分支提交后、合并前）
bun tools/sync-install-source.ts --check    # 确认 doge-code-install/ 没有过期
```

**收尾门禁**：定向 `bun test` → 全量裸 `bun test`（改 afterAll reset 的连跑两次）→ `bun tools/run-isolated-tests.ts` → 相关 e2e/实机 → `bun run version` → 安装源码同步（`bun tools/sync-install-source.ts --verify` 并提交输出，纪律第 8 条）→ `git -c core.whitespace=cr-at-eol diff --check` → 独立 review（Critical/Important 闭环）→ 清理 `test/`/后台任务/沙箱。调试用 `--debug`（pattern 白名单、`!` 前缀黑名单）、`/debug`，日志 `~/.doge/debug/<sessionId>.txt`。门禁细节与常见假红见 DESIGN §9。

## 六、文档索引

- [docs/DESIGN.md](docs/DESIGN.md) — 架构、API 协议、模型目录与路由、工具任务、MCP、存储、安全、测试、已知限制
- [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md) — CU 工具矩阵、授权与坐标、输入与批次、实机验证
- [development_logs.md](development_logs.md) — 可复用经验与坑、版本里程碑、已知欠账
- [README.md](README.md) — 定位、安装、更新、常用命令

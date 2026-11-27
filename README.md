# Doge Code

> Claude Code 的第三方 Fork：以 source map 还原的源码树为基底继续二开，聚焦多协议模型接入、自托管端点与桌面自动化（Computer Use / Playwright）。

本仓库是独立 CLI（`@doge-code/cli`，全局命令 `doge`）。桌面壳在邻仓 `doge-code-app`，以 headless `doge -p --output-format stream-json` 驱动本 CLI；CLI 也保留完整 TUI。

## 是什么

- **基底**：从 source map 逆向还原并补齐缺失模块的 Claude Code 源码树，含恢复期 shim / fallback，**不是**官方上游镜像。
- **本 Fork**：三协议（`anthropic`/`openai`/`responses`）模型接入、统一模型目录、内置 CU 与 Playwright MCP、IM 远程控制、Auto 计划、agent-teams、声明式 workflows。
- **数据隔离（创始原则）**：全局 `~/.doge`、项目级 `<项目>/.doge/`，不与官方 `.claude` 混用（三处官方互操作例外见 [docs/DESIGN.md](docs/DESIGN.md) §8）。

## 与官方 Claude Code 的主要差异

| 方面 | 本仓库 |
|---|---|
| API 协议 | 内部统一 Anthropic Messages，只在 API 边界转换：`CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 选 `anthropic`/`openai`/`responses` |
| 密钥 | `DOGE_API_KEY`（`x-api-key`）与 `ANTHROPIC_AUTH_TOKEN`（Bearer）严格互斥，启动由 `enforceApiKeyExclusivity` 裁决 |
| 模型 | `~/.doge/model-catalog.json` 为连接/模型/角色/档位单一事实源；reasoning/effort 由目录策略驱动 |
| 内置 MCP | `computer-use`（Windows/Linux X11，macOS 原生后端待恢复）；`playwright`（无头）/`playwright-headed`（可见）两个 Node stdio 服务 |
| 分发 | 无打包构建，Bun 直接跑 TS 源码；`bun link` 注册全局 `doge` |
| 文案 | 命令/提示统一 `doge`；`--version` 仍输出 `2.1.347 (Claude Code)`（上游宏保留） |

## 架构总览

```text
src/bootstrap-entry.ts     注入 MACRO 后载入
└─ src/entrypoints/cli.tsx 快速路径（--version / --computer-use-mcp / remote-control / daemon / tmux worktree）
   └─ src/main.tsx         Commander 参数 + 初始化 + 形态分发
      ├─ replLauncher → src/screens/REPL.tsx   TUI（Ink/React）
      ├─ src/cli/print.ts runHeadless()        -p / SDK / 桌面壳 headless（stream-json）
      ├─ src/entrypoints/mcp.ts                `doge mcp serve`
      └─ server / ssh / im                 设计保留，部分为恢复缺口（DESIGN §2）
```

- **运行时**：Bun 直接执行 TS；`feature('...')`（`bun:bundle`）与 `"external" === 'ant'` 是构建期能力门。
- **协议网关**：`src/services/api/claude.ts` 与 `openaiCompat.ts`/`responsesCompat.ts`（双向转换 + 流式回转）。
- **数据根**：`src/utils/dogeConfigDir.ts` → `CLAUDE_CONFIG_DIR ?? ~/.doge`。

## 运行时要求

| 依赖 | 版本 / 说明 |
|---|---|
| Bun | `>=1.3.5`（`package.json` engines/packageManager；依赖以 `bun.lock` 为准） |
| Node.js | `>=24`（Playwright MCP 以 Node 子进程运行） |
| 平台 | 主目标 Windows；macOS 可运行（CU 原生层为恢复期 shim）；Linux 支持 [X11 窗口 Computer Use](docs/COMPUTER_USE.md) |

无 `lint`/`test`/`build` npm 脚本；单测与源码同目录（`*.test.ts`），实机脚本在 `tools/`。

## 安装与更新（源码级）

```bash
git clone <repo-url> doge-code && cd doge-code
bun install          # 本地 file: 包（packages/@ant/*、shims/*）由此写入 node_modules
bun link             # 注册全局 doge（package.json bin → src/bootstrap-entry.ts）
doge                 # 或 bun run dev
```

更新：`git pull && bun install && bun link`。**改 `packages/@ant/*` 后必须 `bun install`**，否则单测过而 CLI 仍跑 node_modules 旧副本。

没有仓库、只想在另一台电脑上安装：单独拷贝本仓库的 `doge-code-install/` 目录即可。它是可独立使用的最小安装源码（不含测试、工具与文档），安装方法见其 `README.md`。

## SSH 远程会话

源码运行需本机有 OpenSSH 客户端（Windows 桌面安装版已随包内置）；远端 Linux 主机需预装 `doge`（默认查 PATH、`~/.bun/bin/doge`、`~/.doge/bin/doge`、`~/.local/bin/doge`）。Linux 源码入口带 LF 换行的 `#!/usr/bin/env bun`，执行 `bun install && bun link` 后可直接运行 `doge`；SSH 远端脚本会显式补充 Bun 常见 bin 路径，避免非交互 shell 找不到解释器。模型请求经带随机令牌的反向隧道转发，本地代理注入凭据，不向远端配置文件或命令行写入真实 API Key；隧道令牌也只在 initialize 成功后经控制通道下发，不进入 argv。

```bash
doge ssh ubuntu@example.com /srv/project
doge ssh build-box --identity-file ~/.ssh/id_ed25519 --cli-path ~/.doge/bin/doge
doge ssh build-box --probe   # 结构化连接/远端 CLI 诊断
doge ssh --local localhost  # 无 SSH 的本地协议 E2E
```

`build-box` 也可以是 `~/.ssh/config` 的 Host 别名。密钥密码、私钥密码交互和远端 CLI 自动部署当前不支持；认证失败或 CLI 缺失时按 `--probe` 的诊断处理。已用真实 Linux/OpenSSH 主机验证默认与显式路径探测、指定工作目录、反向隧道模型回合及正常退出；ProxyJump/ProxyCommand 与长时 OAuth 会话仍需另行实测。

## 常用命令

```bash
bun run dev                 # TUI
bun run version             # 版号 + CLI 可启动冒烟
bun test <路径>             # 定向 bun:test
bun test                    # 全量裸测（src/ 与 tools/，进程内共享状态）
bun tools/run-isolated-tests.ts   # 每测试文件独立进程 + CLAUDE_CONFIG_DIR 隔离
bun tools/e2e-model-routing.ts    # e2e 直接运行（自建沙箱并自清理）
```

## 配置与密钥

- 配置根 `~/.doge`：`settings.json`（用户设置）、`.claude.json`（全局配置历史命名）、`.credentials.json`、`model-catalog.json`；`settings.local.json` 只存在于项目级 `<项目>/.doge/`。
- 自定义端点：`ANTHROPIC_BASE_URL` + 双密钥二选一；`ANTHROPIC_CUSTOM_HEADERS` 每行 `Name: Value`。
- 项目资源 `<项目>/.doge/`：`settings.json`/`settings.local.json`、`agents/`、`skills/`、`commands/`、`rules/`、`workflows/`（已 gitignore）。
- 完整环境变量与目录布局见 [docs/DESIGN.md](docs/DESIGN.md) §3/§4/§7；`settings.json` 样例见 `needs/settings.json`。

## 测试与验证

门禁、隔离与常见假红见 [docs/DESIGN.md](docs/DESIGN.md) §9；Computer Use 实机验证见 [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md) §6。本仓库约定 `test/` 只放一次性产物（结束清空），`tools/` 放可复用脚本（git 跟踪）。

## 文档索引

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 开发纪律、仓库地图、常用命令与门禁 |
| [docs/DESIGN.md](docs/DESIGN.md) | 架构、API 协议、模型目录与路由、工具任务、MCP、存储、安全、测试、已知限制 |
| [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md) | CU 工具矩阵、授权、坐标、输入、验证 |
| [development_logs.md](development_logs.md) | 可复用经验与坑、版本里程碑、已知欠账 |

## 上游与许可

- 上游 Anthropic Claude Code（还原源码树 + 本 Fork 改动），行为与官方存在差异，不代表官方立场。
- `package.json` 声明 `"license": "SEE LICENSE IN LICENSE.md"`；本仓库未跟踪 `LICENSE.md`，许可沿用上游条款，分发/商用前自行核对上游许可与还原代码的合规边界。
- 恢复期 shim 与还原代码可能与上游不同，见 [docs/DESIGN.md](docs/DESIGN.md) §10。

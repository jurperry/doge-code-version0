# Doge Code 最小可安装源码（doge-code-install）

<!-- sync:start -->
> **当前版本** `2.1.361` · 源码等同 `doge-code` 提交 `78aaabba59e2`（2026-11-27）· 2615 个文件
> 本目录由 `bun tools/sync-install-source.ts` 按清单生成；除本文件的说明正文外请勿手改。
<!-- sync:end -->

`@doge-code/cli`（命令 `doge`）的**最小可安装源码分发**：只保留运行所需源码与本地包，可以整体拷到另一台电脑，安装依赖后直接使用。

- **无工作区依赖**：公开 npm 依赖之外，本地 `file:` 包均随本目录自带，不依赖完整开发仓库或桌面 App。
- **不含 `node_modules`**：首次使用需执行 `bun install --frozen-lockfile`（联网，或使用本机 Bun 缓存）。
- **不是桌面安装包**：本目录仅包含 CLI 源码，不包含 Electron、内置 OpenSSH 或原生 `doge.exe`。

## 这是什么

Doge Code 是 Claude Code 的第三方 Fork：以 source map 还原的源码树为基底继续二开，聚焦多协议模型接入（`anthropic` / `openai` / `responses`）、自托管端点与桌面自动化。本目录保留 TUI、headless、MCP、Computer Use、Playwright、IM 远程、agent-teams、workflows 等运行源码，以及 SSH 连接实现；测试、架构文档和开发资产不在分发内。

## 目录结构

```text
doge-code-install/
├─ package.json        # @doge-code/cli；bin.doge → src/bootstrap-entry.ts
├─ bun.lock            # 依赖锁定（配合 --frozen-lockfile 复现安装）
├─ bunfig.toml         # Bun 配置（无测试 preload）
├─ tsconfig.json
├─ .gitattributes      # bootstrap-entry.ts 固定 LF（Linux shebang）
├─ README.md
├─ src/                # CLI 全部运行源码（不含 *.test.ts(x)）
├─ packages/@ant/      # computer-use-mcp、computer-use-input
├─ shims/              # 原生/私有包的 file: 替身
└─ vendor/             # shims 引用的 modifiers-napi、url-handler 源码
```

## 与完整仓库 doge-code 的差异

| 内容 | 本分发 | 完整仓库 |
|---|---|---|
| `src/` 运行源码 | 全部保留，不含测试 | 含 `*.test.ts(x)` |
| `packages/@ant/computer-use-input`、`computer-use-mcp` | 保留 | 保留 |
| `packages/@ant/claude-for-chrome-mcp`、`computer-use-swift` | 裁剪，由 `shims/` 同名包解析 | 保留 |
| `shims/` | 全部保留 | 全部保留 |
| `vendor/modifiers-napi-src`、`vendor/url-handler-src` | 保留 | 保留 |
| `vendor/audio-capture-src`、`vendor/image-processor-src`、根级 `image-processor.node` | 裁剪，运行时不引用 | 保留 |
| `tools/`、`test/`、测试文件 | 不包含 | 包含 |
| `docs/`、`AGENTS.md`、`development_logs.md`、`needs/`、`skills-lock.json` | 不包含 | 包含 |

`needs/` 是面向用户数据目录的默认资源暂存，`src/` 不直接引用，故不随包分发。

## 环境要求

| 依赖 | 版本 / 说明 |
|---|---|
| Bun | `>=1.3.5`；本快照用 Windows Bun 1.3.11 验证 |
| Node.js | `>=24`，仅内置 Playwright MCP 以 Node 子进程运行需要 |
| OpenSSH | 源码方式使用 SSH 时需系统 `ssh` 在 `PATH` 中；桌面 App 的随包 OpenSSH 不属于本源码包 |
| 本地平台 | Windows 10/11 为主目标；Linux 可运行；macOS 未实测。Computer Use 能力依平台而异 |
| 远端平台 | SSH 远端需提供 POSIX `sh`、Bun，并已安装可执行的 Doge Code CLI |

## 安装

```bash
cd doge-code-install
bun install --frozen-lockfile
bun link
doge --version                  # 期望与顶部「当前版本」一致
```

确认 `~/.bun/bin`（Windows 为 `%USERPROFILE%\.bun\bin`）已加入 `PATH`；`bun link` 后若命令未生效，请重开终端。`bun link` 会改变全局 `doge` 指向，不需要全局安装时不要执行。

也可只在本目录运行：

```bash
bun run dev                                  # TUI
bun run ./src/bootstrap-entry.ts -p "你好"    # 单次输出
bun run version                              # 版号与启动冒烟
```

本包无构建步骤，Bun 直接执行 TypeScript。Linux 入口使用 LF 换行的 `#!/usr/bin/env bun`，`bun link` 后可直接执行 `doge`，无需手动添加 shebang 或修改换行。复制到其他电脑后必须重新安装依赖；不要复制其他机器的 `node_modules`。

实测范围：每个版本同步时都会在仓库之外复制一份本目录，实测 `bun install --frozen-lockfile` 与 `bun run version`（Windows）。Linux（Bun 1.4.5）上的 `bun install --frozen-lockfile`、`bun link` 与链接后的 `doge --version` 在早先版本上实测过；macOS 未实测。

## 首次配置（模型接入）

首次启动会创建 `~/.doge`（可用 `CLAUDE_CONFIG_DIR` 覆盖）。在 TUI 输入 `/provider`，配置供应商的 base URL、API Key 和模型，持久化到 `~/.doge/model-catalog.json`。

也可用环境变量：

```bash
export ANTHROPIC_BASE_URL=https://api.example.com
export DOGE_API_KEY=sk-...
export CLAUDE_CODE_COMPATIBLE_API_PROVIDER=anthropic  # anthropic | openai | responses
export ANTHROPIC_MODEL=your-model-name
```

`DOGE_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN` 互斥。凭证不得写入源码目录或日志；分发前不要带入个人 `~/.doge` 配置。

## SSH 连接

先在本地配置好模型，再在远端安装 Doge Code CLI。连接命令：

```bash
doge ssh <user@host|config-alias> [dir]
```

示例：

```bash
doge ssh ubuntu@192.0.2.10
doge ssh devbox ~/project                 # ~/.ssh/config 中的 Host 别名
doge ssh ubuntu@192.0.2.10 --probe       # 只诊断，输出 JSON，不进入 TUI
doge ssh devbox --identity-file ~/.ssh/id_ed25519 --port 22
doge ssh devbox --cli-path ~/.local/bin/doge
```

- 远端 CLI 默认依次查找 `PATH` 中的 `doge`、`~/.bun/bin/doge`、`~/.doge/bin/doge`、`~/.local/bin/doge`；非默认路径用 `--cli-path` 指定。远端脚本会显式补充 Bun 常见 bin 路径，避免非交互 shell 找不到解释器。
- `[dir]` 是远端工作目录；缺省使用远端登录目录。
- 支持 `--model`、`--continue` / `-c`、`--resume` 和权限模式等会话参数。
- 在 SSH 终端按 Shift+Tab 会把权限模式同步到远端。远端禁用 Auto 时仍可切换到「接受编辑」和「计划」。
- 本地 CLI 通过 SSH 反向 Unix socket 转发模型请求；隧道令牌只在会话 initialize 后通过控制通道下发，不写入进程参数，远端不保存本地 API Key。
- 源码运行时调用系统 OpenSSH，读取用户的 `~/.ssh/config` 与密钥；首次连接的新主机密钥按 `accept-new` 策略处理。
- **当前不支持向远端自动部署 CLI**。`--probe` 报告未安装或不可执行时，请先在远端安装并用 `doge --version` 核验。
- SSH 模式使用本地完整 TUI 驱动远端会话，不支持与 `-p` / `--print` 组合。

本地协议自检（不建立 SSH 网络连接，仅验证本地 REPL 与子 CLI 的桥接）：

```bash
doge ssh --local localhost
```

桌面 App 连接 SSH 远端时用的也是远端安装的这份 CLI：模型请求同样经反向隧道回到本机，由本机注入凭据，远端不需要配置 API Key。

## 常用命令

```bash
doge                                                  # TUI
doge -p "解释这个项目"                                  # 非交互单次输出
doge -p --output-format json "..."                    # JSON 结果
doge -p --output-format stream-json --verbose "..."   # 流式 JSON
doge mcp serve                                        # stdio MCP 服务
doge doctor                                           # 环境自检
```

TUI 常用斜杠命令：`/provider`、`/model`、`/effort`、`/mcp`、`/doctor`、`/memory`、`/init`。

## 数据目录与隔离

- 全局数据根为 `~/.doge`，包含模型目录、凭证、会话、插件等；`CLAUDE_CONFIG_DIR` 可覆盖。
- 项目级数据位于 `<项目>/.doge/`。
- 升级或重装无需删除 `~/.doge`，用户配置与会话会保留。
- 删除用户数据不可恢复，不属于普通源码升级步骤。

## 更新与卸载

升级时用同结构的新源码快照替换本目录，再执行 `bun install --frozen-lockfile`；若之前使用过 `bun link`，再执行一次 `bun link` 并核对 `doge --version`。`doge update` / `doge install` 不是本源码分发的升级方式。

若已全局链接，可在本目录执行 `bun unlink` 后删除源码目录；用户数据是否保留由你自行决定。

## 在开发仓库里的位置（给维护者）

本目录位于开发仓库 `doge-code/` 之内，但自成一体：拷走 `doge-code-install/` 这一个目录即可分发，目标机器不需要其余内容。目录内容由 `tools/sync-install-source.ts` 从仓库**已提交**的源码逐字节生成，每次分支开发结束都会重新同步（见仓库 `AGENTS.md` 第一节）；除本文件的说明正文外不要手改，改了也会在下一次同步时被覆盖。

不要在开发仓库里就地 `bun install` 来验证本分发包：Bun 会向上找到主仓的 `node_modules`，把缺失的依赖掩盖掉。要验证分发包本身，把它拷到仓库之外再装，或在开发仓库里运行 `bun tools/sync-install-source.ts --verify`。

## 故障排查

| 现象 | 处理 |
|---|---|
| `doge: command not found` | 检查 Bun 全局 bin 的 `PATH`，或直接运行 `bun run dev` |
| SSH 报告 CLI 未安装 | 在远端安装 Doge Code，或用 `--cli-path` 指定实际路径 |
| SSH 连接失败 | 先运行 `doge ssh <host> --probe`；检查地址、端口、网络和密钥 |
| 远端目录不存在 | 核对 `[dir]`，或在远端创建后重试 |
| `ssh` 未找到 | 安装系统 OpenSSH 并确保 `ssh` 在本地 `PATH` 中 |
| Playwright 工具不可用 | 确认 Node >=24，或设置 `DOGE_PLAYWRIGHT_MCP=0` 后重启 |
| 改源码不生效 | 确认使用本目录的 `bun run` / `bun link`；改本地包后重新 `bun install` |

## 声明与许可

基底为 Anthropic Claude Code 的 source map 还原源码树与本 Fork 改动，不是官方发布。`package.json` 声明 `"license": "SEE LICENSE IN LICENSE.md"`；本分发未包含 `LICENSE.md`，许可沿用上游条款，分发或商用前请自行核对合规边界。使用产生的 API 费用、数据与合规责任由使用者承担。

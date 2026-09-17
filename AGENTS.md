# AGENTS.md — Doge Code 仓库指南

面向 AI 编码代理（Claude Code / Doge Code 等），假设读者对项目一无所知；内容基于当前仓库实际核实，不要凭空假设。**任何任务开始前先读第一节开发纪律。**修复历史（每条三行：问题/解决/位置）见 [development_logs.md](development_logs.md)。

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

- **核心设计**：内部代码始终使用 Anthropic Messages 格式，协议转换只发生在 API 边界，由 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 选择提供商：`anthropic`（`/v1/messages`，SDK 直连）、`openai`（`src/services/api/openaiCompat.ts`）、`responses`（`src/services/api/responsesCompat.ts`，两者均为**实验性**双向转换含流式回转）
- **双密钥严格互斥**：`DOGE_API_KEY` → `x-api-key` header；`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`；并存时启动卫兵 `enforceApiKeyExclusivity` 按激活 profile 裁决
- **与官方 Claude Code 数据完全隔离（创始原则）**：全局配置目录 `~/.doge`（`CLAUDE_CONFIG_DIR` 可覆盖）；项目级一切资源（agents/skills/commands/settings 等）一律在 `<项目>/.doge/` 下，代码不读也不写任何 `.claude/` 路径。唯二例外（有意保留的官方互操作）：`src/utils/ide.ts` 读官方 VSCode 扩展 lockfile、`src/utils/doctorDiagnostic.ts` 检测官方安装
- 技术栈：TypeScript（ESM）+ React JSX/Ink TUI；运行时 Bun ≥ 1.3.5、Node ≥ 24，依赖以 `bun.lock` 为准；**无打包构建产物**，直接以 Bun 运行 TS 源码（分发 = git 源码 + `bun link`，无 CI）；`tsconfig.json` `strict: false`、别名 `src/*`；代码风格：多数文件无分号、单引号
- **高风险面**：`src/utils/computerUse/` 涉及真实键鼠注入与截图，改动需充分手动验证；API Key 持久化在 `~/.doge`，不得写入仓库、提交 git 或打进日志

### 关键环境变量（完整语义见源码与 development_logs.md）

| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` | API 格式：`anthropic` / `openai` / `responses` |
| `ANTHROPIC_BASE_URL` + `DOGE_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`） | 自定义端点 + 密钥（双密钥互斥） |
| `ANTHROPIC_MODEL` | 默认模型；`[1m]`/`[2m]` 后缀仅本地剥离用于上下文窗口计算，不发给 API |
| `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL` | 各层级 Agent 模型（未设时 fallback 到主模型） |
| `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` | 覆盖上下文窗口大小（字节） |
| `CLAUDE_CODE_EFFORT_LEVEL` | 努力等级：`low` / `medium` / `high` / `xhigh` / `max` |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | 子进程密钥清理三态：未设=默认清除 doge 凭证；truthy=全量清单；falsy=关闭 |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | 设 `1` 启用 teammate 群聊（亦可 `--agent-teams` 或 `/agent-teams`） |
| `DOGE_MODEL_SCOPE` | 模型切换作用域：`session`（默认）/ `global` |
| `CLAUDE_CONFIG_DIR` | 覆盖配置目录（默认 `~/.doge`） |
| `DOGE_PLAYWRIGHT_MCP` / `DOGE_PLAYWRIGHT_*` | 内置 Playwright MCP 开关与浏览器配置（`DOGE_PLAYWRIGHT_MCP=0` 关闭） |

## 三、常用命令与测试

```bash
bun install / bun link      # 安装依赖并注册全局 doge 命令
bun run dev                 # 启动 CLI/TUI（入口 src/bootstrap-entry.ts）
bun run version             # 输出版本号，冒烟验证 CLI 可启动
bun test <路径>             # bun:test，务必按路径过滤（裸跑会连带执行 vendored 测试）
```

- package.json **没有** `lint`/`test`/`build` 脚本；测试与代码同目录（`*.test.ts`），实机 e2e 脚本在 `test/` 下（自带沙箱清理，可重复运行）
- 改动后除单测外，`bun run version` 冒烟 + `bun run dev` 手动验证受影响路径
- 调试：`--debug`（可白名单/黑名单）、`/debug` 命令；日志在 `~/.doge/debug/<sessionId>.txt`

## 四、参考文档

- [development_logs.md](development_logs.md) — 修复历史（每条三行：问题/解决/位置）
- `README.md` — 项目定位、安装、更新流程（中文）；`computer_use.md` — Computer Use 专项说明

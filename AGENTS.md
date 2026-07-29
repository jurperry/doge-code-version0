# AGENTS.md — Doge Code 仓库指南

本文件面向 AI 编码代理，假设读者对本项目一无所知。所有内容均基于对当前仓库的实际核实，不要凭空假设。

## 项目概述

**Doge Code**（`@doge-code/cli`）是 Claude Code 的第三方 Fork：基底是从 source map 逆向还原的 Claude Code 源码树，在此之上做了自主魔改，聚焦多提供商 API 兼容与自托管接入。它不是官方上游镜像，行为与官方 Claude Code 存在差异。

核心定位：

- 支持自定义 Anthropic 兼容接口地址与 API Key
- 通过中间转接层支持 OpenAI Chat Completions 与 OpenAI Responses 两种 API 格式（协议级转换，**实验性功能，不完全稳定**）
- 自定义模型与模型档案（ModelProfile）管理
- 与原版 Claude Code 数据隔离：默认配置目录为 `~/.doge`（全局配置文件 `~/.doge/.claude.json`），可用 `CLAUDE_CONFIG_DIR` 覆盖；不要与 `~/.claude` 混用
- 全局命令名为 `doge`（非 `claude`）

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
- 项目自身测试与代码同目录放置（`*.test.ts`），目前位于 `src/services/api/`、`src/commands/model/`、`src/utils/model/`、`src/hooks/` 下
- 注意：裸跑 `bun test` 会连带执行 `needs/skills/claude-to-im/node_modules/` 里 vendored zod 的测试（实测共 22 个文件、约 250 个用例）；只跑项目测试时用路径过滤，如 `bun test src/services/api/`
- 已知既有失败（截至当前提交，非本次改动引入）：`src/hooks/useMainLoopModel.test.ts` 中 `does not fall through to customApiStorage when AppState fields are null` 用例失败
- 新增测试应放在被测模块旁边，以模块或被测行为命名
- 除单测外，改动后用 `bun run version` 冒烟 + `bun run dev` 手动验证受影响路径

## 代码组织

入口与核心：

- `src/bootstrap-entry.ts` — CLI 入口（`bin.doge` 指向它）
- `src/main.tsx` — 主应用 UI 组件（约 808KB 超大文件，修改需格外谨慎）
- `src/commands.ts` — 命令路由表
- `src/query.ts` / `src/QueryEngine.ts` — 查询处理引擎
- `src/Task.ts` / `src/Tool.ts` — Task 与 Tool 抽象

主要目录：

| 目录 | 用途 |
|------|------|
| `src/commands/` | 所有 `/` 斜杠命令实现，每命令一个 kebab-case 目录 |
| `src/components/` | React/Ink TUI 组件 |
| `src/services/` | 业务逻辑服务（API、Compact、MCP、LSP 等） |
| `src/services/api/` | API 层：`claude.ts` 主客户端（多提供商分发）、`openaiCompat.ts`、`responsesCompat.ts` 协议转换、`client.ts` 凭证解析 |
| `src/tools/` | 内置 Tool 实现（BashTool、FileEditTool、AgentTool 等） |
| `src/utils/` | 工具函数（`auth.ts`、`customApiStorage.ts`、`dogeConfigDir.ts`、`model/`、`computerUse/` 等） |
| `src/skills/` | 内置 Skill 系统 |
| `src/bridge/` | 远程桥接与会话管理 |
| `src/cli/` | CLI 传输层（SSE/WebSocket/Hybrid）与输出格式化 |
| `src/context/`、`src/coordinator/`、`src/plugins/`、`src/memdir/`、`src/jobs/`、`src/schemas/` | 上下文管理、多智能体协调、插件系统、Memory 目录、后台任务、Zod 模式 |
| `shims/` | 恢复期 shim 包，替代无法还原的原生/私有模块（以 `file:` 依赖引用） |
| `packages/@ant/` | 内部 @ant-scoped 包 |
| `vendor/` | 第三方/原生组件源码（audio-capture、image-processor 等） |
| `needs/` | claude-to-im 集成所需的 skills、hooks 与 settings.json |

## API 兼容架构

内部代码始终使用 Anthropic Messages 格式，协议转换只发生在 API 边界。由 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 选择提供商：

- `anthropic` → `/v1/messages`，直接使用 Anthropic SDK
- `openai` → `/v1/chat/completions`，由 `openaiCompat.ts` 双向转换（含流式事件回转）
- `responses` → `/v1/responses`，由 `responsesCompat.ts` 双向转换

凭证解析优先级：`customApiStorage` → 运行时保存的设置 → `DOGE_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 环境变量 → 默认值。关键环境变量还有：`ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_MODEL_CONTEXT_WINDOW`、`CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CONFIG_DIR`（完整清单见 `CLAUDE.md`）。

根目录的 `start_*.ps1`（`start_deepseek.ps1`、`start_glm.ps1`、`start_kimi.ps1`、`start_qwen.ps1` 等）是针对不同提供商的启动脚本，开头会清理旧环境变量再注入新配置，可作为配置参考。

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

- 这是真实 git 仓库（有提交历史），但按 `CLAUDE.md` 约定：**进行代码开发前先询问用户是否新建 git 分支，不要直接在主分支上开发**
- 提交信息用简短祈使句（历史风格如 `Support web search for openai and responses API formats`，中英文均有）
- 无 CI、无发布流水线；分发方式就是 git 源码 + `bun link`
- 这是还原树而非 pristine 上游：恢复期 fallback/shim 与 Fork 魔改并存，为恢复兜底添加的变通方案要在代码或文档中注明
- 修复历史记录在 `debug_updates_1.md` ~ `debug_updates_5.md`，修改相关区域前可先查阅

## 调试

- 调试日志写入 `~/.doge/debug/<sessionId>.txt`
- `--debug` 启动或 `/debug` 命令动态开启；`--debug=api,hooks` 白名单过滤，`--debug=!file` 黑名单；另有 `--debug-to-stderr`、`--debug-file=<path>`、`CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose`
- 核心实现：`src/utils/debug.ts`（日志管线）、`src/utils/debugFilter.ts`（分类过滤）

## 其他参考文档

- `README.md` — 项目定位、安装、更新流程（中文）
- `CLAUDE.md` — 面向 Claude Code 的仓库指南，含完整环境变量表与常见问题速查（部分启动脚本名称已过时，以根目录实际文件为准）
- `computer_use.md`、`SYNC_CTI_CONFIG.md` — 专项说明

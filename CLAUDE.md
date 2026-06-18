# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**Doge Code** — Claude Code 的第三方重建分支（从 source maps 恢复），聚焦多提供商 API 兼容。
- 数据隔离：使用 `~/.doge`（非 `~/.claude`），可通过 `CLAUDE_CONFIG_DIR` 覆盖
- 三种提供商模式由 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 控制：`anthropic` / `openai` / `responses`
- 运行时: Bun 1.3.5+ / Node.js 24+
- 全局命令: `doge`（通过 `bun link` 注册包 `@doge-code/cli`）

```bash
bun install           # 安装依赖 + 本地 shim 包
bun run dev           # 启动 CLI 开发模式
bun run version       # 输出版本号
bun link              # 注册全局 doge 命令
```

## 项目结构

**核心入口与路由**:
- `src/main.tsx` (~808KB) — 主应用 UI 组件
- `src/commands.ts` — 命令路由表
- `src/interactiveHelpers.tsx` — 交互模式辅助
- `src/query.ts` / `src/QueryEngine.ts` — 查询处理引擎
- `src/Task.ts` / `src/Tool.ts` — Task 和 Tool 抽象

**API 层** (`src/services/api/`):
- `claude.ts` (~135KB) — 主 API 客户端，多提供商路由分发
- `openaiCompat.ts` — Anthropic Messages ↔ OpenAI Chat Completions 协议转换
- `responsesCompat.ts` — Anthropic Messages ↔ OpenAI Responses API 协议转换
- `client.ts` — 凭证解析 / SDK 客户端初始化
- `errors.ts` / `withRetry.ts` / `errorUtils.ts` — 错误处理与重试

**认证与配置** (`src/utils/`):
- `auth.ts` — 认证逻辑（含自定义 API 绕过密钥审批）
- `customApiStorage.ts` — `ModelProfile` 持久化存储（每模型完整配置：provider/baseURL/apiKey/contextWindow/能力声明）
- `dogeConfigDir.ts` — 配置目录入口：`CLAUDE_CONFIG_DIR ?? ~/.doge`
- `model/model.ts` — Agent 模型选择与 fallback 逻辑
- `model/providers.ts` — API 提供商检测（firstParty/bedrock/vertex/foundry）
- `model/modelSupportOverrides.ts` — 第三方模型能力覆盖
- `effort.ts` / `thinking.ts` — Effort/Thinking 能力检测与模型兼容

**API 兼容架构**:

| 提供商 | 端点 | 内部格式 |
|--------|------|----------|
| `anthropic` | `/v1/messages` | 直接使用 Anthropic SDK |
| `openai` | `/v1/chat/completions` | Messages → Chat Completions，流式事件回转 |
| `responses` | `/v1/responses` | Messages → Responses API，流式事件回转 |

所有内部代码始终使用 Anthropic Messages 格式，转换在 API 边界完成。

**凭证解析优先级**: `customApiStorage` → 运行时保存的设置 → `DOGE_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 环境变量 → 默认值

**重要环境变量**:
| 变量 | 用途 |
|------|------|
| `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` | 指定 API 格式: `anthropic` / `openai` / `responses` |
| `ANTHROPIC_BASE_URL` | 自定义 API 端点 |
| `DOGE_API_KEY` | API 密钥（优先于 `ANTHROPIC_AUTH_TOKEN`） |
| `ANTHROPIC_MODEL` | 默认模型 |
| `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL` | 各层级 Agent 模型 |
| `ANTHROPIC_DEFAULT_*_MODEL_SUPPORTED_CAPABILITIES` | 能力声明，如 `effort,max_effort,thinking,adaptive_thinking` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子智能体模型覆盖 |
| `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` | 覆盖上下文窗口大小（字节） |
| `CLAUDE_CODE_EFFORT_LEVEL` | 努力等级: `low` / `medium` / `high` / `max` |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 禁用非必要网络请求 |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | 禁用非流式回退 |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | 强制启用 effort 参数 |
| `CLAUDE_CONFIG_DIR` | 覆盖配置目录（默认 `~/.doge`） |

**特殊模型行为**:
- `[1m]` / `[2m]` 后缀仅在本地从模型名中剥离用于上下文窗口计算，不发送到 API
- DeepSeek: `max_tokens` 自动限制 32k，`reasoning_content` 映射为 thinking 块
- 第三方 API: 上下文窗口硬编码 + `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` 可覆盖
- 非 Anthropic 模型: 上下文溢出错误映射为 PTL（触发 reactive compact）

**启动脚本** (`start_*.ps1`):
- `start_opus.ps1` — Anthropic 兼容接口（代理）
- `start_deepseek.ps1` — DeepSeek（OpenAI 格式）
- `start_glm.ps1` / `start_glm01.ps1` — GLM 模型
- `start_qwen.ps1` — Qwen 模型
- `sync_to_cti.ps1` — 同步配置到 claude-to-im

**Computer Use** (`src/utils/computerUse/`):
- `platforms/win32.ts` — Windows 后端（HWND SendMessage + SendInput fallback）
- `win32/` — 窗口管理 / 截图 / OCR / 输入 / UI Automation 模块
- `platforms/darwin.ts` — macOS 后端

**主要源码目录**:

| 目录 | 用途 |
|------|------|
| `src/commands/` | 所有 `/` 命令实现（每个命令一个目录，kebab-case） |
| `src/components/` | React/Ink TUI 组件 |
| `src/services/` | 业务逻辑服务（API/Compact/MCP/LSP/分析等） |
| `src/tools/` | 内置 Tool 实现（BashTool/FileEditTool/AgentTool 等） |
| `src/skills/` | 内置 Skill 系统 |
| `src/utils/` | 工具函数（模型/认证/调试/ComputerUse 等） |
| `src/bridge/` | 远程桥接 / 会话管理 / 入站消息 |
| `src/cli/` | CLI 传输层（SSE/WebSocket/Hybrid）与输出格式化 |
| `src/context/` | 上下文窗口管理 |
| `src/coordinator/` | 多智能体协调 |
| `src/plugins/` | 插件系统 |
| `src/memdir/` | Memory 文件目录管理 |
| `src/entrypoints/` | SDK 运行时类型与入口 |
| `src/schemas/` | Zod 数据模式 |
| `src/jobs/` | 后台任务调度 |
| `shims/` | 恢复期 shim 包（代替缺失的原生模块） |
| `packages/` | @ant-scoped 内部包（computer-use 等） |
| `vendor/` | 第三方代码 |
| `needs/` | claude-to-im 集成需要的 skills 和 hooks |

## 关键 Fork 修改

1. **认证绕过**: 自定义提供商时（`openai`/`responses` 或非 Anthropic URL）跳过密钥审批流程
2. **OpenAI 协议转换**: `openaiCompat.ts` 和 `responsesCompat.ts` 在 API 边界做完整协议翻译
3. **ModelProfile 持久化**: `customApiStorage.ts` 支持每模型保存完整的 provider/baseURL/apiKey/contextWindow 配置
4. **Agent 模型 fallback**: 模型等级不够时自动回退
5. **Computer Use Windows**: HWND SendMessage + SendInput fallback；四层应用发现
6. **PTL 错误映射**: Anthropic/OpenAI 格式的上下文溢出 → unified reactive compact

## 代码风格

- TypeScript ESM，React JSX（`react-jsx` 转换），Bun 运行时类型
- camelCase 变量/函数，PascalCase 组件/类，kebab-case 命令目录
- 多数文件无分号、单引号；匹配周围文件风格
- 禁止重排序有 `ANT-ONLY import markers must not be reordered` 注释的 import
- `src/main.tsx` (~808KB) 为超大文件，修改需谨慎

## 调试

- 调试日志: `~/.doge/debug/<sessionId>.txt`
- `--debug` 启动或 `/debug` 命令动态启用
- 分类过滤: `--debug=api,hooks`（白名单），`--debug=!file`（黑名单）
- `--debug-to-stderr`、`--debug-file=<path>`、`CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose`
- `src/utils/debug.ts` — 核心日志管线（过滤/缓冲/写入/symlink）
- `src/utils/debugFilter.ts` — 分类过滤
- `src/skills/bundled/debug.ts` — `/debug` 内置技能

## 修复历史

- `debug_updates_1.md` — Chapter 1-10（登录/上下文/Computer Use/高DPI）
- `debug_updates_2.md` — Chapter 11-25（Windows 输入/压缩/模型管理/持久化）
- `debug_updates_3.md` — Chapter 26+（凭据覆盖/effort 一致性/模型切换）
- `debug_updates_4.md` — 最新修改（effort 全链路修复/thinking 守卫）

## 常见问题速查

| 问题 | 检查 |
|------|------|
| API 连接 | `ANTHROPIC_BASE_URL` + `DOGE_API_KEY` + `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 三者匹配 |
| 配置冲突 | 清除旧 env var 再切换（`start_*.ps1` 开头都有清理） |
| DeepSeek | `max_tokens`≤32k，`reasoning_content` 必需 |
| Agent 模型 "not found" | 设置 `ANTHROPIC_DEFAULT_*_MODEL` env vars |
| 上下文窗口错误 | 使用 `[1m]` 后缀或 `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` |
| Windows Computer Use | 管理员应用需要管理员终端；Electron/CEF 自动 SendInput |
| 构建报错 | `bun install` + `bun link`，确认 Bun 1.3.5+ |
| 首次运行 ERR | 确保 `~/.doge/.claude.json` 中 `hasCompletedOnboarding: true` |

## 恢复说明

- 从 source maps 重建，含恢复兜底和 shim 行为
- `dev-entry.ts` (`bun run dev:restore-check`) 启动时检查缺失 import
- 修改最小化、可审计，文档化所有变通方案
- 非 git 仓库，仅文件系统追踪变更

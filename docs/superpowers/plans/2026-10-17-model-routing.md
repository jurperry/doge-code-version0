# Model Routing Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. User authorized execution after the design check; no extra handoff approval required.

**Goal:** 明确 API/Profile 身份，收敛模型解析并隔离运行中 agent 的连接配置。

**Architecture:** 保留三类 agent 的策略，底层共用纯档位解析、Profile 引用和 AsyncLocalStorage 上下文。旧 env、模型字符串、存储镜像和工作流名称兼容。

**Tech Stack:** TypeScript ESM, Bun >=1.3.5, Node >=24, existing AsyncLocalStorage; no new dependencies.

**Spec:** ../specs/2026-10-17-model-routing-design.md

## Global Constraints

- feature/model-routing-context，未经确认不提交、不合并、不删分支；本计划的 commit 步骤统一延后到用户确认。
- 新增测试脚本放 tools/，临时产物在 test/ 并清理；不写真实 ~/.doge 或 C 盘测试数据。
- 保留 ANT-ONLY import 顺序、effort 独立、三类 agent 默认/override/inherit、会话切换语义和协议转换边界。
- 镜像存储兼容保留；密钥只存在内存与既有安全存储，绝不传入命令行或团队持久化元数据。

## Review Focus

1. env 主模型 B 与磁盘 A 不得拼接不同 provider 的档位/凭据。
2. 相同模型名的 Profile、改名/删除/重启不得选错 API。
3. 运行中异步 agent 与 teammate 不受 leader 切换影响；新 worker 跟随当前上下文。
4. workflow profile + inherit 必须用目标 Profile 主模型，普通 override 不得泄入步骤。
5. 所有适配器真实请求必须使用同一个上下文的模型、URL、协议、鉴权；错误和取消不得泄漏上下文。

---

### Task 1: 统一档位与启动恢复

**Files:** Create src/utils/model/tierResolver.ts; modify restoreTierState.ts, managedEnv.ts, model.ts, switchModelProfile.bindings.ts, modelOptions.ts, WorkflowTool/headlessStep.ts; test tools/model-routing.test.ts.

**Interfaces:** resolveTierModel({tier, env, profile?, mainModel?, fallback?}): string | undefined; tier = opus|sonnet|haiku. No IO in the pure resolver.

- [x] 写磁盘 A/env B 启动恢复回归，以及缺档位回落主模型、显式档位、上下文后缀的行为测试。
- [x] 运行 bun test tools/model-routing.test.ts，确认旧实现错误分支失败。
- [x] 实现纯解析器，接入显示/切换/工作流；启动仅一次补齐 API 和档位，拆开迁移与早期注入。
- [x] 运行新增测试及 restoreTierState、agent、switchModelProfile、handlers 现有单测，确认 PASS。

### Task 2: Profile 身份与兼容存储

**Files:** Create src/utils/model/profileIdentity.ts; modify customApiStorage.ts, syncModelConfig.ts, switchModelProfile.ts/bindings.ts, provider-{storage,entries,remove}.tsx/ts, provider.tsx, modelOptions.ts, model/handlers.ts, model.tsx, ModelPicker.tsx, modelAllowlist.ts, validateModel.ts; test tools/model-profile-identity.test.ts.

**Interfaces:** getProfileId(profile): string; profileSelection(profile): string; resolveProfileReference(profiles, reference): ModelProfile | undefined. ModelProfile.id?: string; CustomApiStorageData.activeProfileId?: string.

- [x] 写同模型双 provider 可选择、编辑、删除、改名保留 ID、旧字符串兼容、会话不落盘/全局重启身份恢复测试并观察失败。
- [x] 实现纯 ID/引用助手；选择器传 Profile 引用，切换先解引用，所有 API 与状态保留真实模型；集中兼容存储读取。
- [x] 扩展 Profile 的 env patch 与回滚覆盖 active ID；保留旧文件格式与 provider 名工作流匹配。
- [x] 运行身份测试、provider-storage 与现有模型切换/allowlist 测试，确认 PASS。

### Task 3: Worker 运行上下文与真实 API 绑定

**Files:** Create src/utils/model/runtimeModelContext.ts; modify AgentTool/runAgent.ts, utils/swarm/inProcessRunner.ts, model/{model,agent,providers}.ts, services/api/{client,claude}.ts, utils/auth.ts as needed; test tools/model-runtime-context.test.ts and tools/e2e-model-routing.ts.

**Interfaces:** getModelEnvironment(): NodeJS.ProcessEnv; captureModelEnvironment(): ModelEnvironment; runWithModelEnvironment(snapshot, callback); iterateWithModelEnvironment(factory, snapshot?): AsyncGenerator. Snapshot never serialized.

- [x] 写并行 worker A/B + leader 切换、多个 generator yields、异常/return、嵌套 agent 的测试并观察失败。
- [x] 为 runAgent 与整个进程内 teammate 生命周期绑定快照；模型与 API 路由读取上下文；SDK 显式设置 baseURL/key/token。
- [x] mock HTTP API 验证 Anthropic/OpenAI/Responses 的实际 URL、model、auth；旧 worker 固定、新 worker 跟随；workflow profile 子进程保持隔离。
- [x] 运行上下文与既有 agent、workflow、teammate 单测及新 e2e，确认 PASS。

### Task 4: 回归、文档与审查

**Files:** development_logs.md, AGENTS.md 的过时优先级说明，tools/run-isolated-tests.ts 如需纳入 tools 测试；本计划进度记录。

- [x] 执行相关 e2e-model-picker、e2e-provider-form、e2e-provider-identity、e2e-tier-session-switch 与 workflow 相关验证，全部使用 test/ 隔离配置与自清理。
- [x] 跑全量按文件隔离单测（src + tools 的 bun:test 文件），记录失败而不隐藏；bun run version 和隔离 TUI 冒烟。
- [x] 发起独立子代理审查 git diff，修复实质问题，按新增失败用例复验。
- [x] 更新三行修复历史和准确配置说明；核对测试临时产物已清理、只含本轮修改；向用户逐条询问提交、合并、删除分支。

## Execution Ledger

Pre-flight: Task 1 resolver 被 Tasks 2/3 消费；resolver 只接收显式配置。Task 2 的 active ID 被 Task 3 快照捕获；ID 无密钥。Task 3 的 ALS 不写磁盘，不改变 Task 2 固化语义。

Ruling: 按仓库已有分支开发约定在当前 checkout 新开 feature 分支，避免额外 worktree 安装/配置；用户已明确授权复查后实施，不另行索取开工确认。计划/设计暂不提交。


## Final Verification — 2026-10-17

- 基线：src 按文件隔离 94 个文件、743 pass、0 fail；现有单进程共享 mock/设置污染，沿用隔离验证策略。
- 最终全量：`bun tools/run-isolated-tests.ts`，纳入 src + tools 的 109 个测试文件，829 pass、0 fail。新模型路由/身份/上下文/启动/OAuth 来源测试 24 项均通过。
- 实际 HTTP：`bun tools/e2e-model-routing.ts`，Anthropic / OpenAI Chat / Responses 的 URL、模型、鉴权保持同一快照；真实 source CLI Agent Explore 验证 disk A/env B；真实 workflow 同 API 步骤 + 跨 Profile 子进程验证覆盖与 inherit；全部通过。
- 相关 e2e：e2e-model-picker、e2e-tier-session-switch、e2e-provider-form、e2e-provider-identity、e2e-agent-teams-flag 全部通过。一次误写不存在的 e2e-agent-teams.ts 命令未执行测试，已用实际 flag 脚本补跑通过。
- 启动与 UI：`bun run version` 输出 2.1.306；隔离 CLAUDE_CONFIG_DIR、假 key、localhost 无服务地址下 `bun run dev --bare --dangerously-skip-permissions` 成功进入 TUI，打开 /model、选择档位并确认 session only，/exit 正常退出。未发送模型 prompt。
- 独立 review：修复随机 Profile 身份冲突、bootstrap/settings 主模型快照、分阶段 settings.env 同值来源、OAuth 同账户刷新/切换账户隔离、CCR 文件 token 来源、/login 管理 Key 快照；对应失败用例先复现、修复后通过。最终静态复审无剩余 P1/P2。
- 范围：apiKeyHelper 原动态刷新保留；原生云 SDK 外部凭据链和 tmux env-only 密钥传输未改造；验证不调用真实付费 API/OAuth/云账户。
- 方案图已补齐，AGENTS.md 优先级说明与 development_logs.md 第 70 条已同步。临时产物清理后，仅保留本轮源码、可复用测试和文档。
- 初次验收状态：feature/model-routing-context；当时未提交、未合并、未删除分支。用户 2026-10-17 已明确批准两仓提交、合并 main 与删除已合并功能分支；实际收尾执行记录以 git log 为准。

## GUI 同步扩展验收

- 用户要求同步 doge-code-app 后，在 SDK init 增加可选非敏感 `profile_id`，get_settings.applied 增加可空可选 `profileId`；模型名与服务身份仍分开，null 明确没有 Profile。
- 新增 tools/model-profile-wire.test.ts，验证 worker init 使用捕获身份且不泄漏凭据，控制响应保留身份。扩展后完整隔离单测为 110 文件、831 pass、0 fail；真实模型路由 HTTP e2e 再次通过。
- GUI 0.2.154 的构建来源、恢复竞态修复、独立审查与安装验收记录位于相邻仓库 docs/model-routing-sync-validation-2026-10-17.md。两仓收尾已获用户明确授权。

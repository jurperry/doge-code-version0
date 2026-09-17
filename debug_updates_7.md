# debug_updates_7 — 2026-09-17 模型选择与安全审计修复批次

来源：模型选择体系调研报告逐条核实（5 个并行核查代理对照源码验证，约八成主张属实）后的可执行修复批次。分支 `feature/audit-fixes`。明确**不在本批次**（另行立项）：plan 模式会话档位升级语义（问题 7，被测试固化为有意行为，需设计决策）、tmux 僵尸收尸（问题 9）、lead /resume 团队恢复（问题 10）、`.claude.json` 镜像去明文 key（协同改动需先审计读方）。

## 一、统一切换入口（错端点风险根除）

**问题**：PromptInput 内联 ModelPicker 直写全局 `mainLoopModel` 并清 session 槽，不应用所选 provider 的 profile（baseURL/key 不变、无回滚）——内联选 provider 行会把模型名发给旧端点；headless `print.ts` 6 处 `setMainLoopModelOverride` 直写同款（其中 4 处是会话中切换）；P1 按 model id 匹配 profile，两 profile 共用同一 id 时任意取第一个。

**修复**：
- `PromptInput.tsx` `handleModelSelect` 改走与 `/model` 命令完全相同的 `decideAndSwitch`（P1 原子切 profile env + 快照回滚），fast-mode 联动与通知保留，消息加 session-only 后缀。
- 新增 `applyProfileForModelIfMatch`（`switchModelProfile.bindings.ts`）：headless 专用，命中存量 profile 则以会话级（`persist:false`、`noopSyncToDisk`、commit no-op）应用其 env，失败回滚返回 false。`print.ts` 四处接入：`set_model`（`finally` 里写 override + 通知）、`set_settings.model`、SDK `onSetModel`、CCR v2 metadata 恢复。`main.tsx --model` 与 headless agent 定义 model 是合法启动期 override，保留直写。
- 新增 `findProfileByModel`（共享 P1 匹配）：同 model id 多 profile 时优先 env 激活端点（`ANTHROPIC_BASE_URL`+key 比对）那份，否则首个；`model.tsx` 两处内联 lambda 与 PromptInput 统一换用。
- `syncModelConfigToDisk` 从编译产物 `model.tsx` 提取为 `src/utils/model/syncModelConfig.ts` 单一来源（三入口共用；编译产物只留 import，未动 `_c` 缓存槽）。

## 二、子进程密钥默认清除（最高优先安全项）

**问题**：`subprocessEnv.ts` 的清理被 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 门控且默认关闭——Bash 工具、MCP stdio（含内置 Playwright Node 子进程）、hooks、LSP 全部继承明文 `DOGE_API_KEY`，auto 会话下 prompt injection 一句 `echo $DOGE_API_KEY` 即可外带。

**修复**（`subprocessEnv.ts`）：三态门控——未设=默认清除 doge 自身凭证（`DEFAULT_SUBPROCESS_SCRUB`：DOGE_API_KEY/ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_FOUNDRY_API_KEY/ANTHROPIC_CUSTOM_HEADERS + INPUT_ 前缀镜像）；truthy=原 GHA 全量清单（claude-code-action 兼容）；falsy（`0` 等）=完全关闭（逃生门）。云凭证（AWS/AZURE 等）**不进默认清单**——开发机上 Bash 跑 `aws` 是正当工作流。新测试 `subprocessEnv.test.ts` 六用例。

## 三、teams 信箱发送者认证

**问题**：`useInboxPoller.ts` 对 `shutdown_approved` 只查 JSON 形状——任何能写 `~/.doge/teams/<队>/inboxes/team-lead.json` 的内容可按消息体 paneId 杀**任意** tmux pane、按名删任意成员、完结同名 task；`plan_approval_request` 自动批准并把 lead 权限模式（含 bypass/auto）下发给任意请求者。

**修复**：
- `teamHelpers.ts` 新增纯函数 `findRegisteredMember(teamFile, senderName)`（对照团队文件 members，非内存注册表）+ `TeamMember` 命名类型。
- shutdown_approved：未注册发送者整体忽略；killPane 仅当消息 `paneId`+`backendType` 与该成员注册的 `tmuxPaneId`/`backendType` 匹配才执行（不匹配→跳过 kill 记日志，成员移除照常）；registry-miss 兜底（AGENTS.md 记录的并发丢注册修复）保留，但只对团队文件注册名可达。
- plan_approval_request：未注册发送者不自动批准。

## 四、teammate spawn 会话盲区 + tmux env 白名单

**问题**：三处 spawn handler 读原始 `mainLoopModel`，lead 会话内 `/model` 切换后新 spawn 的 teammate（tmux 与 in-process 一致）拿旧全局模型；`TEAMMATE_ENV_VARS` 转发 `ANTHROPIC_BASE_URL` 但不转发 provider 格式与档位 env——tmux teammate 协议回退 anthropic、别名展开成 first-party 模型 id 打第三方端点。

**修复**：
- `spawnMultiAgent.ts` 新增 `getLeaderModel`（`mainLoopModelForSession ?? mainLoopModel ?? getDefaultMainLoopModel()`，TeamCreateTool 同序），三处调用点统一换用。
- `TEAMMATE_ENV_VARS` 补 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER`、三档位 env、两能力 env、`CLAUDE_CODE_MODEL_CONTEXT_WINDOW`。**密钥类绝不进白名单**——`buildInheritedEnvVars` 拼进 ps 可见的 tmux 命令行；新增 `isEnvOnlyCredentialConfig`（纯函数）+ spawn 两处 `warnIfEnvOnlyTeammateCredentials`（env-only 凭证时记 error 日志，teammate 首请求必 401 的可诊断提示；根治=用 /provider 持久化）。

## 五、小修集合

- `agent.ts`：`CLAUDE_CODE_SUBAGENT_MODEL='inherit'`（大小写不敏感）按未指定处理——旧版字面量直发 API 404，且破坏 fork 子代理的同模型缓存一致性。
- `provider-remove.tsx`：清理改用 `PROFILE_MANAGED_ENV_KEYS` 全量清单（旧版只清 5 个档位变量，`CLAUDE_CODE_SUBAGENT_MODEL`/behavior flag 从被删 profile 泄漏给继任者）。
- `/fuck`：补删 `process.env.ANTHROPIC_AUTH_TOKEN`。
- `Settings/Config.tsx`：清 key 时同步删 env（旧 key 不再"会话内继续生效"）；写后补跑 `enforceApiKeyExclusivity`。
- `ConsoleOAuthFlow.persistCustomEndpoint`：env 写入补卫兵 + `writeCustomApiStorage` 改合并式（`...readCustomApiStorage()`）——旧覆盖式写抹掉全部 `modelProfiles[]`（其他 provider 的 key 一并丢失）。
- `writeAtomicJson`：tmp 创建 mode 0600 + rename 后 chmod（POSIX 下镜像不再降级 0644）。
- `config.ts` 备份：新增 `writeConfigBackup`——含 `customApiEndpoint.apiKey` 的 JSON 备份落盘前剥除该字段（secure storage 是权威源，备份非 0600 不宜留 5 份明文 key 轮转）；非 JSON/无 key 文件字节复制不变。MAX_BACKUPS=5 上限为既有行为（审计报告"无上限"说法不实）。

## 六、死代码删除（8903636 漏网）

- 删除 `src/utils/swarm/backends/InProcessBackend.ts`、`PaneBackendExecutor.ts`（`getTeammateExecutor`/`getInProcessBackend` 全仓零调用者；"漏传 model"bug 仅丢 taskState 显示字段，随文件消亡）。
- `registry.ts` 删三个 getter 与缓存变量；`types.ts` 删 `TeammateExecutor`/`TeammateSpawnConfig`/`TeammateSpawnResult`/`TeammateIdentity` 孤儿类型。
- `spawnUtils.ts` 删 `buildInheritedCliFlags`/`getTeammateCommand` 死副本（唯一消费者是上述 executor；live 版本在 `spawnMultiAgent.ts` 局部——审计问题 8 的双胞胎漂移由此消一半，剩 `--teammate-mode` 差异随死副本消失）。

## 七、测试

- 新增：`subprocessEnv.test.ts`（三态门控六用例）、`spawnUtils.test.ts`（白名单转发/密钥不进命令行/引号包裹/env-only 检测）、`spawnMultiAgent.test.ts`（getLeaderModel 三用例）、`teamHelpers.test.ts` 增 findRegisteredMember、`agent.test.ts` 增 env 'inherit' 两用例、`switchModelProfile.bindings.test.ts` 增 findProfileByModel 四用例。
- **修复已知环境依赖失败**：`useMainLoopModel.test.ts` 自带 `CLAUDE_CONFIG_DIR` 沙箱 + 用例内 dummy key——根因是默认链 `getDefaultMainLoopModelSetting → isMaxSubscriber → getAnthropicApiKeyWithSource` 在无凭证时直接 throw（非"读凭证状态断言漂移"）。坑：bun 同进程跑多测试文件时，① afterAll 删沙箱目录会砸掉经传递导入提前捕获锁路径的 teamHelpers 测试、② `process.on('exit')` 在 bun test 下不触发（mkdtemp 目录每次运行泄漏）、③ 模块顶设 dummy `DOGE_API_KEY` 会污染断言 env 优先级的相邻文件（restoreTierState "heals wiped credentials"）——最终方案=固定路径沙箱每次启动 rm+mkdir 重建（残留有界：一个空目录）+ dummy key 用例内 try/finally。
- 全量受影响面：164 用例 0 失败；`bun run version` 2.1.261；`dev:restore-check` 无新增缺失（gen-manifest SKILL.md 提示为 main 既有）。

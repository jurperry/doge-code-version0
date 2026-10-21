# Doge Code 子代理与 Agent-Teams 模型选择机制

核验日期：2026-10-21。产品基线：CLI 2.1.312，源代码提交 `2881a4fea2fc3ae75ab1d8157043060c67599b5e`。

原报告来自 `feature/model-selection-report`（796a2b5，旧基线3046b60）。该分支已完整合入；本文按当前代码更新。旧的“队友先记别名、每轮再解析”和显示不统一等结论已被后续实现取代，原文保留在 Git 历史中。

## 当前链路

1. 主会话模型由 `resolveMainLoopModel` 解析：会话槽 `mainLoopModelForSession` 优先于 `mainLoopModel`，再回落默认设置。别名解析及运行时升级还依赖权限模式等上下文。
2. 普通 Agent 使用 `resolveAgentModelSelection`；队友各后端经 `resolveTeammateSelection` 进入同一解析机制。选择时保存 `requestedModel`、`resolvedModel` 和 `source`。
3. 正常执行复用已解析模型；任务记录、转录身份和展示使用该身份，不在每次唤醒时随全局模型重新解释。
4. worker 创建时通过 `captureModelEnvironment` 捕获连接、认证、模型设置等运行环境，执行在 `runWithModelEnvironment` / `iterateWithModelEnvironment` 内进行。之后父会话切模型不会改写已创建 worker 的快照。
5. `formatAgentModel` 为普通代理和队友统一展示，例如 `opus(实际模型)`。缺少解析身份的旧别名记录显示“未解析”，不把别名冒充实际请求模型。

身份中的请求值用于说明用户选择；发往 API 的是实际模型 ID。`[1m]` / `[2m]` 是本地上下文标记，API 边界会剥离；UI 也可以省略后缀。密钥不应序列化到模型身份或侧栏元数据中。

## 选择优先级与连接

`resolveAgentModelSelection` 调用 `getAgentModel` 完成实际解析，来源优先级为：

1. 有效的 `CLAUDE_CODE_SUBAGENT_MODEL` 环境覆盖。
2. 非 inherit 的工具 model 参数。
3. 非 inherit 的代理定义 model。
4. 继承父会话；队友未指定时另有其默认策略，不能把 undefined 一概当作 inherit。

Agent 工具的 model schema 仍只接受 `opus`、`sonnet`、`haiku`、`inherit` 四种显式值；代理定义和主模型入口的可接受范围不同。

`/model` 的三条路径仍需区分：匹配已保存 profile 时原子切换连接与模型；档位别名在当前连接下解析；未知裸模型名不会自动创造或切换到另一条连接。不能仅凭模型名字判断 baseURL、协议或凭证。

交互式 `/model` 默认仅作用于本会话；`--save` 或显式 `DOGE_MODEL_SCOPE=global` 可启用持久化作用域，档位别名仍只作用于会话。新终端的默认设置与当前会话 override 是两层状态。2.1.312 的取消提示使用有效会话模型；欢迎区在模型/强度改变时刷新冻结快照。

## 恢复与继续执行

进程内继续任务复用创建时的模型/连接快照。跨进程恢复优先按记录的非敏感 profile、协议和端点身份恢复；相关 profile 被删除或连接身份改变时会报错，不悄悄改用当前默认服务。没有身份的旧转录走兼容回落，不能声称能精确还原当时的凭证。

Teams 每轮执行可能产生新的转录 agent_id。task_id 是稳定任务身份，不能将 task_id 永久视为唯一转录文件名。当前进度事件携带实际 agent_id，App 按任务汇集多轮记录。

CLI `/clear` 保留当前配置。App 从新建标签/切项目进入的是默认模型、自动强度和请求询问；App `/clear` 则清上下文并保留当前模型/连接、强度和权限。两种操作不能合并成同一个配置重置语义。

## 仍需区分的边界

- `best`、`opusplan` 等扩展别名属于主模型/代理定义等入口的语法，不能推论为 Agent 工具四值 schema 也接受。
- `best` 的上下文后缀处理仍有现有边界，不能在文档中当作已修复。
- opusplan 的 Plan 升级还检查 `getUserSpecifiedModelSetting()`；仅更改交互会话槽不能保证启动配置也变成 opusplan。旧报告“会话级永远只有 Sonnet”的说法缺少启动配置条件。
- tmux 的 `TEAMMATE_ENV_VARS` 已包含协议、profile 身份、档位模型和能力声明；它仍不显式转发 `CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_SUBAGENT_MODEL`。认证密钥有意不列入该命令行白名单，不能为修正文档而添加密钥转发。
- 这些是现状说明，未在本次纯合并/资料核验中修改产品行为。

## 代码入口与验证

- 主模型与命令：`src/hooks/useMainLoopModel.ts`、`src/utils/model/model.ts`、`src/commands/model/{model.tsx,handlers.ts}`。
- 代理身份与解析：`src/utils/model/{agentModelSelection,agentModelIdentity,agent}.ts`。
- worker 环境与恢复：`src/utils/model/runtimeModelContext.ts`、`src/tools/AgentTool/{runAgent,resumeAgent}.ts`。
- 队友后端与环境：`src/tools/shared/spawnMultiAgent.ts`、`src/utils/swarm/{spawnUtils,inProcessRunner}.ts`。
- 展示：`src/components/CoordinatorAgentStatus.tsx`、`src/components/tasks/TeammateAgentLine.tsx`；App 使用对应的共享模型格式化逻辑。
- 本轮源码全量验证：122个CLI测试文件、924例通过；App双工程typecheck及46项检查通过。安装版0.2.166 / CLI 2.1.312的66项回归证据见邻仓 `docs/validation/2026-10-21-clear-session-config-validation.md`。

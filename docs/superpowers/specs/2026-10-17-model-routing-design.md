# 模型配置与运行上下文收敛设计

## 目标与已批准的行为

统一配置身份、启动恢复、档位解析和请求目标，保留普通 agent、teammate、workflow 各自的默认值、覆盖优先级与 inherit 语义。修复磁盘 Profile A + 启动主模型 B 混合出 A 档位的问题。当前协议适配器和编排生命周期保持不变。

本轮使用 TypeScript、现有 Bun 与 AsyncLocalStorage，不增加依赖。沿用当前 checkout 的 feature/model-routing-context 分支；用户已授权方案复查后直接实施。提交、合并、删分支仍须用户分别确认。

## 兼容契约

- 普通 agent：CLAUDE_CODE_SUBAGENT_MODEL（非 inherit）优先于工具参数，再看 agent 定义，最后父模型。同家族裸别名保留父完整模型、Bedrock 地区前缀、1m/2m 与 Plan 行为保留。
- teammate：显式 inherit 跟随 leader；未指定时保留 teammateDefaultModel 的 undefined/null 区别和内置 Opus fallback。进程内现有 subagent override 语义保留，不暗中统一后端优先级。
- workflow 无 profile：步骤 model → agent 定义 → 父模型，忽略全局 subagent override。
- workflow 指定 profile：step.model 优先，否则显式 agent 的 model；inherit/未指定回落所选 profile 的主模型，档位仅在该 profile 内解析。继续使用子进程，不修改父进程环境。
- /model 默认会话级；--save / DOGE_MODEL_SCOPE=global 保留；裸档位始终会话级；普通 agent 的模型名不隐式切换 API。
- 已启动进程内 worker 固定创建时的 API 连接与档位上下文，leader 切换只影响后续 worker。worker 后续回合和嵌套 agent 继承 worker 上下文。根会话保持即时切换。
- 配置只在 ~/.doge 或 CLAUDE_CONFIG_DIR 下读写。凭据不进入日志、模型选项、团队元数据、命令行或版本库。

## 设计

### A. 一次确定活跃 Profile

早期启动仅做旧字段迁移/凭据修复，不再提前注入档位。managedEnv 的统一恢复按启动环境主模型及显式 Profile 身份定位 Profile，补齐缺失值；settings.env 原有覆盖顺序保留。兼容 restoreTierStateFromStorage 的直接调用时也必须按 env 活跃主模型选档位，不能按磁盘主模型兜底到另一个 provider。

### B. 存储边界

安全存储仍为权威来源，现有 .claude.json 和 settings.json 作为兼容镜像保留。集中合并读取和模型/身份固化，避免新建第四套来源。本轮不做破坏性凭据格式迁移，也不改变 effort 的独立配置。

### C. 共用档位机制，保留策略层

新增纯 resolveTierModel({ tier, env, profile, mainModel, fallback })，顺序为显式 env 档位、所选 profile 档位、上下文主模型、调用方内置 fallback。主模型/普通 alias、菜单与档位切换、workflow Profile 映射共用此机制；普通 agent 的同家族捷径和各类 inherit 在各自策略层先处理。避免档位解析反查会话选中档位造成递归或 Haiku 污染其他档位。

新增 runtimeModelContext（AsyncLocalStorage），承载不可变 env 快照；无局部上下文时读取 process.env。agent async generator 的每次 next/return/throw 都在其快照下运行；进程内 teammate 整个运行循环在创建时快照下执行。API 协议、地址、鉴权及模型解析读取上下文。SDK 客户端显式传入快照的 URL/key/token，避免 SDK 自行读取 leader 的新环境。

### D. 明确 Profile 身份

ModelProfile 添加可选 id，存储添加 activeProfileId，进程以 DOGE_ACTIVE_MODEL_PROFILE 兼容映射。旧 Profile 的临时 ID 由非敏感身份字段确定性生成，显式编辑保存时固化并在改名/换主模型时保留；新建 Profile 使用随机 UUID，避免改名后复用旧名字产生身份冲突。选择器 provider 选项使用内部 profile:<id> 引用，切换前解析为 Profile，状态和 API 中只保留真实模型 ID。相同模型 ID 的多个 provider 都可显示、选择、编辑和删除。旧的模型字符串和 workflow profile 名称仍可使用；身份不明确时保留当前连接优先的旧匹配策略。

跨进程 teammate 继续采用现有安全凭据读取机制，仅传递非敏感 Profile 身份和现有档位配置，不把密钥加入 shell 命令。env-only 的 tmux 凭据限制不在本轮引入新传输协议；必须诚实保留诊断。

## 验证与风险

新增测试仅放 tools/；临时配置、网络 mock、日志在仓库 test/，结束清理，禁止写真实用户配置和系统盘测试数据。

必须验证：A/B 启动混合、同模型不同 provider、改名保留 ID、会话与全局保存、三类 inherit/override、并行 worker/异步生成器在 leader 切换后 API+模型+密钥仍一致、退出/异常上下文清理、workflow 跨 API 与父配置隔离、团队不同后端的继承参数。

执行按文件隔离的全量单测（现有共享 mock/配置全局污染不得掩盖）、相关 e2e、bun run version、隔离配置的 TUI 路径冒烟。最终发起新子代理 code-review，修复实质问题后再报告。未授权提交、合并或删除分支。

## 复查记录

编写者自查：将统一机制与策略分开；明确 workflow inherit 属于所选 Profile；明确进程内 worker 快照寿命覆盖整个 teammate 循环；镜像迁移采用兼容方案；env-only tmux 凭据不承诺自动修复。

独立 builder-check：nothing important left，无需用户补充。实施边界补充：快照捕获有效路由后禁止动态磁盘回落；SDK 未设置鉴权传显式 null，URL 使用确定默认；OAuth 的全局 memoize 不得覆盖已捕获凭据；generator 在调用时而非第一次 next 时捕获；显式 env 主模型压过冲突磁盘 activeProfileId。

## 实施后的走线与收敛点

```mermaid
flowchart TD
  E[启动 env / settings.env] --> R[按显式身份、主模型、连接选 Profile]
  D[安全存储 + 兼容镜像] --> R
  R --> M[仅补齐缺失字段：主模型、三档、协议、地址、凭据]
  S[/model：选择 profile:id 或模型别名] --> M
  M --> ROOT[根会话当前配置]
  ROOT --> SAVE[仅显式保存：固化 activeProfileId 与模型配置]
  ROOT --> C[创建 worker 时捕获运行上下文]
  C --> A[普通子代理策略：全局覆盖 → 工具 → 定义 → 父模型]
  C --> T[进程内团队成员：保留原默认与 inherit 策略]
  C --> W[同 API workflow：步骤 → 定义 → 父模型；忽略全局覆盖]
  D --> P[跨 API workflow：按 profile 引用/名称选择目标]
  P --> SUB[隔离子进程：目标 Profile + 步骤模型；inherit = 目标主模型]
  A --> TR[共用 resolveTierModel：显式档位 → Profile 档位 → 上下文主模型 → 内置默认]
  T --> TR
  W --> TR
  SUB --> TR
  TR --> API[从同一上下文取得协议、URL、鉴权与实际模型]
  API --> N[Anthropic Messages]
  API --> O[OpenAI Chat 适配]
  API --> Q[Responses 适配]
  ROOT -. 后续切换只影响新 worker .-> C
  classDef reduced fill:#dcfce7,stroke:#15803d
  class R,M,TR,API reduced
```

绿色节点是收敛位置：启动档位不再提前单独注入；身份匹配不再仅依赖模型名；档位 fallback 共用纯函数；协议/地址/鉴权从同一运行上下文解析。三类编排策略仍分别保留，避免把 workflow 的 inherit 或团队默认强行改成普通 Agent 的覆盖规则。

快照同时捕获 bootstrap 主模型 override、settings.model、兼容存储、env、自定义 API Key、/login 管理 Key、OAuth 来源和账户。OAuth 同一凭据链允许正常刷新并同步 sibling worker；leader 切换账户后，旧 worker 不能采纳或覆盖新账户的 token/账户元数据。CCR 文件/FD 的 inference token 保留其外部来源，不回退到磁盘 OAuth。

apiKeyHelper 继续使用原动态缓存与刷新机制，本轮不承诺冻结外部 helper 输出；云厂商原生 SDK 的外部凭据刷新链与 tmux env-only 密钥传递也未改造。真实网络验证使用本地 mock，覆盖三种协议、实际 Agent 调用、同 API 与跨 Profile workflow；不使用真实付费 API、OAuth 服务或云厂商账户。

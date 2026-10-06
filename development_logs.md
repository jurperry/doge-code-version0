# development_logs.md — Doge Code 开发日志

> 2026-09-17 由 `debug_updates_1.md` ~ `debug_updates_7.md` 合并精简而成。每条固定三行：问题 / 解决 / 位置。已被后续架构演进取代的记录已剔除，去向见文末「演进注记」。

## 2026-10-06 工作流步骤子进程退出清扫与 shell 停止事件潜伏 bug（2.1.297，App 0.2.130）

1. 遇到问题：App 用户实测（0.2.128 会话 6d663946）：跨 API 工作流步骤里 2 分钟超时自动后台化的 PowerShell 死循环脚本把步骤子进程无限挂住——headless 收尾 do-while「等后台任务清零再退出」对步骤语境是错误语义（模型答完即产出定格，遗留命令不可能再被任何模型轮次消费），整工作流卡死在该步骤不前进；本地 mock 三格式复现实证（anthropic/openai/responses 各一步骤 + 后台 ping）。顺藤摸出两个潜伏 bug：①stopTask 的 shell 抑制检查在 kill 之后读 notified 标志，而 killTask 会先盖上 notified:true——直发 SDK stopped 终态恒被静默跳过（SDK 消费方从未见过 shell 任务正常 stopped）；②treeKill 异步发射后不等落地，即将退出的进程里 taskkill 随父进程而死，被"杀"的命令沦为孤儿继续跑。
2. 解决方法：①spawnHeadlessStep 注入 `DOGE_WORKFLOW_STEP_CHILD=1`（零依赖契约模块 stepChildEnv.ts，print.ts 上游不反向拉重量模块）；②print.ts 收尾按任务族拆分——shell 族（local_bash/monitor_mcp/dream）在步骤子进程模型答完后直接 stopTask 清扫（终态经 finally 排水先于输出流关闭上送，壳行正常收 stopped）、代理族（local_agent/remote_agent）保持等待（输出经 relay 流式记录进父会话转录＝wf-nested 契约，且模型有界）；heldBackResult 对步骤子进程豁免；③stopTask 的 notified 检查挪到 kill 之前（notifiedBefore）；④ShellCommand.#doKill 暴露 killSettled 完成承诺 + killShellTasks.pendingShellKills 注册表，清扫退出前 `Promise.race([pendingShellKills(), sleep(2000)])` 有界等树杀落地。首版曾把代理族也清扫——verify-workflow-cli wf-nested-xapi 转录断言抓回（嵌套后台代理被杀丢尾），按族拆分后归位。验证：CLI 单测 15 + App verify-workflow-cli 0 败（新增 wf-bgexit 场景：三格式各后台化 ping 60s，断言步骤秒级完成、3 行全收 stopped、四步骤+伞 settle）+ verify-workflow-app 50/50 + 进程级断言残留 ping=0。
3. 代码位置：src/tools/WorkflowTool/{stepChildEnv.ts 新、headlessStep.ts}、src/cli/print.ts（hold 豁免+do-while 拆分+清扫）、src/tasks/stopTask.ts（notifiedBefore）、src/utils/ShellCommand.ts（killSettled）、src/tasks/LocalShellTask/killShellTasks.ts（pendingShellKills）；回归 App 仓 tools/workflow-test-fixture.mjs（openai/responses 分路径 mock + OaiFormat/RespFormat profile + wf-bgexit）与 tools/verify-workflow-cli.mjs。

## 2026-10-06 双类重试预算、代理级续跑全覆盖与 teams 实时事件（2.1.296，App 0.2.128）

1. 遇到问题：App 用户三联报障（teams 限额无重试提示且无续接／子代理面板停在初值／teams 会话无占用锁）。取证：所有可重试错误共用 10 轮单桶预算、文案「服务重试中」不分类；in-process 队友裸调 runAgent 没有 2.1.294 的代理级续跑（同步 Task/异步生命周期/工作流进程内步骤有）；lead 回合结束后的 teammate 邮箱轮询循环从不 drainSdkEvents——task_progress 积压（1000 上限丢最旧）直到下条邮箱消息触发 run() 才冲刷＝面板「冻结→跳变」；headless 无 turn 边界信号供壳判占用。另修存量雷：agentToolUtils 异步续跑退避引用 `API_ERROR_RESUME_BACKOFF_MS`（缺 AGENT_ 前缀）——后台代理/进程内步骤一进续跑即 ReferenceError，也即 verify-workflow-cli 停滞流用例「一批即败」校准所依据的（坏）行为。
2. 解决方法：重试规格（App 用户定，修正版）：网络与服务类（断连/408/5xx/529）10 轮、其余（429/409/瞬态上游 4xx）5 轮——RetryBudget infra/other 双计数互不挪用（CLAUDE_CODE_MAX_RETRIES 同钳两类；显式 options.maxRetries 保持旧单一总预算语义），展示帧按类报 x/10 与 x/5；SystemAPIErrorMessage 非网络类改「API Error, 第x/N 次重试…」；代理级续跑三路统一（inProcessRunner 队友接入 + 共享件移 agentApiResume.ts 防 AgentTool→spawnMultiAgent→inProcessRunner import 环 + 修 AGENT_ 前缀 ReferenceError）；**网络类终结不续跑**（claude.ts 错误 assistant 标注 apiErrorTransport；停滞流续跑会重付整额预算 3 批）而 API 类仍续跑 ≤2 次（豁免门每轮重判，勿用循环前快照）；print.ts 邮箱轮询每拍 drainSdkEvents；队友开工/空闲发 task_progress is_idle、roundAgentId 固定本轮使续跑追加同一 sidechain 文件、终态通知带累计 usage、续跑耗尽空闲通知如实带 failureReason；agent 行重试可见（sdkProgress.emitTaskApiRetryProgress；网络分类单点 retryErrorClass，TUI/sdkProgress/engine 复用勿再内联）。验证：withRetry 单测 16（双类/混合/耗尽/x-N 帧）＋黑盒四场景（429×5→成功、恒 429→6 请求报错、断连→10 轮、恒 500→10 轮）＋teams 六项（result 后工具进度流出＝排水实证、is_idle、邮箱驱动）＋gap 停滞 30s 如实失败（App verify-workflow-cli 0 败）。黑盒方法论：node spawnSync 阻塞事件循环＝同进程 mock 无法 accept（异步 spawn 才行）；SDK 连接前 HEAD / 探活，计数过滤非 POST。
3. 代码位置：src/services/api/withRetry.ts（RetryBudget 双类+retryBudgetClass/retryErrorClass）、src/services/api/claude.ts（apiErrorTransport）、src/components/messages/SystemAPIErrorMessage.tsx、src/tools/AgentTool/{agentApiResume.ts 新、agentToolUtils.ts、AgentTool.tsx、agentCompletion.ts}、src/utils/swarm/inProcessRunner.ts、src/cli/print.ts、src/utils/task/sdkProgress.ts、src/tools/WorkflowTool/engine.ts、src/utils/sdkEventQueue.ts（is_idle）；测试 src/services/api/withRetry.test.ts、test/{api-retry-blackbox.mjs,teams-live-events.mjs}。App 侧配套（agentsBusy/标题栏芯片/pureChat 拆类/verify-agent-busy E2E）见 App 仓 0.2.128 条目。

## 2026-10-05 三分支 API 容错全覆盖与步骤重试可见性（2.1.295，App 0.2.126）

1. 遇到问题：App 0.2.125 实测复报工作流 agent 空转（glm 进程内步骤 235s 零消息，活性行停在「等待模型响应 150s」）；用户同时指出 0.2.125 的 4xx 修复只覆盖 openai 一条路径——而 CLI 有 anthropic/openai/responses 三种格式、用户 GLM 与 Kimi 实际都是 anthropic 格式（「GLM 走 openai 分支」是早期调研的无实证假设）。取证：requestFetch 经 buildFetch 无条件注入 Anthropic SDK、openaiCompat/responsesCompat 直用——三分支 gap/超时覆盖都全，235s=180s gap 触发后重试第二轮再停滞（机制有效但不可见）；真缺口：responsesCompat 非 transient 4xx 抛普通 Error（isClientError 不识别、图片剥图重试不触发）、共享 PTL 判定无中文关键词（anthropic 分支中文长度 400 不归一）、runAgent 静默丢弃 system/api_error 重试事件（步骤重试期间零反馈=空转观感）。
2. 解决方法：responsesCompat 非瞬态 4xx 抛原生状态 APIError（openaiCompat 同款）；errors.ts 共享 PTL 判定补「长度超过/超出上限/超过上限」（三分支中文长度 400 统一归一）+ responsesCompat 自身列表同步；runAgent 对 system/api_error 仅 yield 不落 sidechain（重试事件透传）；引擎活性 ticker——firstMessageAt 排除 system 帧、文案追加「· 网络重试第 N 轮」（**保留「等待模型响应」前缀契约**，verify-workflow-cli 按 includes 匹配，整句替换假红）。验证：三分支×{reject/reject-unknown/corrupt} 九场景（bundled exe；reject-unknown 判别性场景旧 exe responses 分支判死、新 exe 剥图重试成功）+ anthropic-ptl 中文归一 + agent-resume/compact 回归 + verify-workflow-cli 0 失败（含 gap 停滞/活性/重试轮次）。
3. 代码位置：src/services/api/responsesCompat.ts（4xx APIError 化+中文 PTL）、src/services/api/errors.ts（共享 PTL 中文）、src/tools/AgentTool/runAgent.ts（api_error 透传）、src/tools/WorkflowTool/engine.ts（重试可见 ticker）；复现脚本 test/image-400-{anthropic,responses}-{repro.sh,mock.ts}、test/one-shot-driver.ts（API_PROVIDER 参数化）。编译基线为本轮 feature/usage-artifact-and-image-resilience 增量源码（2.1.295）。

## 2026-10-05 网关 usage 虚报守卫、图片容器校验与代理续跑（2.1.294，App 0.2.125）

1. 遇到问题：glm-5.3-flash[1m] 会话（App 实测取证 83734af8）几轮就假触发自动压缩「压缩前 1.31M tokens」——jsonl 逐帧证明 GLM 网关对主线 usage 偶发 2x/4x 虚报（611553≈2×305280、1306312≈4×319269），tokenCountWithEstimation 采信虚报值越阈值；工作流步骤 Read 经 PowerShell `>` 重定向破坏的截图 PNG，发布 exe 里 sharp/image-processor-napi 恒 external 不加载、resize 失败兜底裸透传原文 bytes，GLM 400 [1210] 中文报文又不匹配 isImageUnsupportedError 英文关键词、openaiCompat 非瞬态 400 抛普通 Error（非 APIError）令 claude.ts 剥图重试与一切分类失效，回合死、工作流首败即停 64 分钟全损。
2. 解决方法：tokenCountWithEstimation 增可选 contextWindowTokens——向后扫描跳过「输入侧>窗口」的虚报记录（与全零占位同型防御；单次调用输入侧物理上不可能超窗），autocompact/blocking-limit/两处 pre_tokens 调用点传窗；imageResizer 新增纯 TS 容器结构校验 validateImageContainer（PNG 签名+IHDR+chunk 长度/CRC32 走查+IEND 即 EOF、JPEG SOI/存在 SOS/尾部 EOI 三点式〔严格段走查对合法小 JPEG 误报，宽松三点已覆盖 UTF-16/CRLF/截断类〕、GIF 头尾、WebP RIFF 尺寸）+ isImageBufferDecodable 解码探针（getImageProcessor 加载失败返回 null＝无法判定放行，防 dev 无处理器误拒合法图），Read 解码门双层判定、损坏图返回带再生成指引的工具错误；openaiCompat 非瞬态 4xx 抛原生状态 APIError、PTL 关键词补「长度超过/超出上限/超过上限」中文措辞（compact 截头重试对中文端点生效）；isImageUnsupportedError 补 [1210]/图片输入/图片格式/图片解析模式；API 错误有界续跑双路——runAsyncAgentLifecycle（异步代理/工作流步骤）循环改造 + AgentTool 同步收尾点（App 对话模式 Task 默认同步）：query 正常返回但末条 assistant 是 isApiErrorMessage（或迭代器抛错且无 assistant）时剥错误尾巴与非会话记录（stream_event/attachment/progress）、以既有对话续跑同一代理——**前置原始 promptMessages**（query 只 yield 新消息，续跑列表不含初始 user；首败剥空则空数组回退原始 prompt 重启），上限 2 次、退避 1.5s/4s，同步路径 worktree 已清理/已后台化/已中断不续跑并补发 completed 纠正通知（App 任务行按 task_id upsert）；AgentTool/resumeAgent/engine 三 makeStream 提供方透传 resumeMessages。验证：mock 端点双场景（强制压缩：boundary+摘要 user 帧齐现 stream-json 直播输出；4x 虚报+真实 150k<167k 阈值：不假触发）＋图片双场景（corrupt：容器校验拒绝、图片不进 API、回合成功；reject：400[1210]→剥图重试→第三请求成功）＋代理续跑场景（首请求 400→1.5s 退避实证〔duration_ms 1676〕→续跑成功→主线收尾）＋check-image-container 11 断言＋既有单测回归。
3. 代码位置：src/utils/tokens.ts（窗口守卫）、src/utils/imageResizer.ts（validateImageContainer/isImageBufferDecodable）、src/tools/FileReadTool/FileReadTool.ts（readImageWithTokenBudget 解码门）、src/services/api/openaiCompat.ts（APIError 化+PTL 中文）、src/services/api/errors.ts（GLM 图片模式）、src/tools/AgentTool/agentToolUtils.ts（stripTrailingApiErrorMessages+续跑常量+异步续跑循环）、src/tools/AgentTool/AgentTool.tsx（同步收尾点续跑+纠正通知）、resumeAgent.ts / WorkflowTool/engine.ts（makeStream resumeMessages 前置透传）、src/query.ts 与 src/services/compact/{autoCompact,compact}.ts（传窗调用点）；复现脚本 test/{compact-repro,compact-repro-mock,compact-repro-driver,image-400-repro,image-400-mock,agent-resume-mock,one-shot-driver,check-image-container}.ts|sh。编译基线为本轮 feature/usage-artifact-and-image-resilience 源码（2.1.294）。

## 2026-10-05 SSE 心跳空转的请求边界与进程内步骤活性（2.1.293）

1. 遇到问题：App 对话模式跑跨 API 工作流，kimi 步骤完成后进入同 API 进程内步骤（glm-5.3-flash），agent 注册却零工具零 token 空转 350s+，无重试无用量无报错，用户中断才恢复（无痕静默）。排查证据：sidechain 只有初始 user 消息与中断记录、主会话无 network-retry-usage、同进程 1 分钟后请求机件健康——响应头/连接期已有 90s 超时兜底（若是连接挂死必留重试痕），唯一无痕路径是「响应已建立、注释帧（`: ping`）无限续命空闲钟、事件帧永不到达」的请求级无限等待。
2. 解决方法：requestLifecycle 增加事件间隔上限——text/event-stream 响应逐块扫描 SSE 帧（跨块携带残行；`event:`/`data:` 行为真进度重置时钟，注释/空行不算），keep-alive-only 流超过 `CLAUDE_STREAM_EVENT_GAP_MS`（默认 180s，10–600000 整数校验同款）即抛 APIConnectionTimeoutError 进入既有重试预算；判定只发生在刚收到字节后，消费侧读延迟不误伤；非 event-stream 响应不受影响。engine 进程内步骤加 10s 活性 ticker：首条消息到达前发 task_progress「等待模型响应 Ns」，到达后由常规逐消息进度接管（与子进程步骤 stepProgressSummary 对齐，长首响不再像冻结）。验证：requestLifecycle 9/9（ping-only 旧代码连测试进程都挂死＝失败态实证）；受影响面 107/107；全套按文件隔离见本轮 runner 输出。真实端点沙箱复现（glm/kimi 经本地代理、含 cloudcompare MCP、冷缓存、230s 慢步骤）六组全部正常——触发依赖外部停滞性流，修复以边界兜底而非复现为准。
3. 代码位置：src/services/api/requestLifecycle.ts（eventGapMs + createEventFrameScanner + pull 内 gap 判定）与 requestLifecycle.test.ts（ping-only 有界/事件帧重置/仅 event-stream 三测）；src/tools/WorkflowTool/engine.ts（runInProcessStep 活性 ticker，firstMessageAt 停表、finally 清理）。CLAUDE_STREAM_EVENT_GAP_MS 与既有 API_TIMEOUT_MS/CLAUDE_STREAM_IDLE_TIMEOUT_MS 同款校验（10–600000ms），文档口径同走 development_logs 不进 AGENTS.md 变量表。编译基线 `59a5f5a73398552bdbfaf5bbcb9b2f7acfe5d797`（2.1.292）加本轮 feature/stream-event-gap 源码。

## 2026-10-05 MCP 调用回收、实时进度边界与后台交接（2.1.292，App 0.2.123）

1. 遇到问题：MCP 工具默认超时 100,000,000ms，原竞争没有取消请求，挂起时工作流无法回收决策权。跨 API 同步子代理等待事件被父查询阻塞至工具结束；转发活动还可能误归祖先任务。自动后台化在途 next() 被遗弃，return() 一秒后重启 runAgent，重放风险与旧 finally 干扰并存；后台 hook allow 执行门和迟到摘要清理有漏洞。workflow slash 请求回显被壳当提示，失败校验前未落盘需求。
2. 解决方法：每请求生命周期独立 idle/total/AbortController，默认 120s/600s，30s 等待，SDK 无视取消仍本地及时结算；工具错误说明远端结果未知，不盲重试副作用。MCP 进度接真实 task 事件及同步 Agent 的 onProgress，父查询及时 yield 排空；共享直接/转发身份映射保留 parent_tool_use_id，仅实际工具所属任务记活动。后台接管同一迭代器、在途结果与 controller，动态权限/状态/工具池，hook allow 经稳定动态执行门，迟到摘要由后台 finally 回收。canonical workflow-request 在校验前保存并标记机器回显。全套按文件隔离 91/91、705/705；独立复审 18 测试/51 断言通过。安装 CLI MCP 20/20 含真实 120s 交接与 Bash 文件仅写一次，工作流 43/43；App 严格周期 UI 50/50与切换17/17，完整回归/数据恢复见 App 验收文档。
3. 代码位置：src/services/mcp/{client,toolCallLifecycle}.ts 与单测、src/tools/AgentTool/{AgentTool,agentHandover,mcpProgress,agentToolUtils,runAgent}、src/services/tools/toolHooks.ts 与后台门单测、src/Tool.ts、src/tasks/LocalAgentTask/LocalAgentTask.tsx、src/utils/{queryHelpers,processUserInput/processSlashCommand}、src/entrypoints/sdk/coreSchemas.ts、src/tools/WorkflowTool/{engine,createWorkflowCommand}.ts。App tools/verify-workflow-mcp.mjs 比较收件与服务 cancel 时刻（至少早 500ms）并拒绝父任务污染；35s UI 预算实测 30s 周期提示。编译基线 `f687d882e368b5a595c12f0e2c371e00c070ce9d` 加本轮 feature/workflow-session-reliability 源码，产物 SHA256=`71C4B2C31DA1E2591ACC131594A89312F6D238DDE054E3CFECCACEB0BED598E7`，安装副本一致。用户已批准提交、合并及删除已合并分支；本次提交对应已验收的 CLI 2.1.292 源码，实际 CLI commit 将记录于 App 提交说明。App 完整对话回归 262/262；原配置已恢复，受策略阻止的 test/ 清理由用户自行完成。验收见 App docs/workflow-session-reliability-validation-2026-10-05.md。

## 2026-10-05 工作流进度用量与主会话转录一致性（2.1.287，App 0.2.118）

1. 遇到问题：跨 API 进度取 result 的多轮累计输入，同 API 末跳 usage mutation 漏读且拆块输出重复计；旧 assistant 快照可覆盖新 SSE delta。工作流只有命令噪音，壳侧运行任务未索引；孤立请求/反馈断父链，固定工作流父 UUID 又绕过后台期间普通问答。QueryEngine setMessages 重新赋数组令 print.ts 继续持有旧历史。
2. 解决方法：AgentUsageTracker 共享最新可信输入（含缓存）＋响应 ID 去重输出的进度口径，最终 delta 优先，保存同进程消息引用读取 GLM 延迟用量；子进程开 partial messages 并实时发用量，独立永久账单不改。启动前保存原 /name args 意图并 flush；appendWorkflowTranscript 捕获同步 setter 最新完整历史，请求与反馈单点追加；QueryEngine 保留共享数组身份。独立审查闭环；86/86 文件、681 单测通过，App 安装版工作流 31/31、安装 CLI 43/43 含真实 120 秒后台交接，--version=2.1.287。测试 exe 清理 EACCES 补有限重试，最终全套绿。
3. 代码位置：src/utils/agentUsage.ts 与单测、src/tasks/LocalAgentTask/LocalAgentTask.tsx、src/tools/WorkflowTool/{headlessStep,engine,createWorkflowCommand,workflowTranscript}.ts 与转录/transport 单测、src/QueryEngine.ts。编译基线 `a114697138e4107a532a7650cfac07a48865d26e` 加本轮 feature/workflow-status-usage 源码；最终源码 commit 见本条 2.1.287 对应 git log 及 App 验收记录。构建 CLI SHA256=09F426C9B4B923A3EEFA4EBA286C883841DA739ED7AA92285B25DB7295DE20A4，安装副本一致。用户已授权两仓提交、合并 main、删除已合并分支；最终 CLI commit 记录在 App 本轮提交说明。验收及收尾状态见 App docs/workflow-status-usage-validation-2026-10-05.md。

## 一、API 兼容与上下文

### 65. 三协议网络恢复、十轮预算与工具安全续接（2.1.277，2026-10-02）
1. 问题：重试只覆盖响应头，流式断线或静默永久等待、兼容 reader 未释放；环境重试数无十轮上限，Bun 1.3.11 复用连接还会静默重发 POST；失败块留在界面、下一轮共享上下文与懒写磁盘，并发 tombstone 截断可损坏尾部及删除新 metadata；重放可能重复工具或丢已知失败用量。
2. 解决：共享生命周期保护响应头及原始响应体（默认各 90 秒，心跳续钟，停止取消 reader/计时/退避），Bun 模型 POST 同时 Connection:close 与 keepalive:false 避免预算外重发；初次请求后至多十轮，取得响应、半流、模型/图像/404 回退共用预算；安全重放撤销失败块，已完成工具保留结果续接，终态立即释放连接，HTTP/SSE 认证参数及非法端点保持终态，真实 OAuth/远程认证刷新保留。TUI 首轮 Wi-Fi 中文状态，SDK api_retry 附 discard_partial/discard_message_ids/parent_tool_use_id；QueryEngine 原位修改共享历史并只累计每次失败 snapshot 一次，network-retry-usage 独立永久 metadata 不进模型上下文；保留工具的迟到用量纠正沿原 API message.id 与 sourceUuid 关联，统计末非零替代旧快照防双计，普通成功流不变；存储 tombstone 先剔除队列并防迟到写回，磁盘删除、追加及同步 metadata 共用 mutation 队列。API_TIMEOUT_MS/CLAUDE_STREAM_IDLE_TIMEOUT_MS 为 10–600000ms 完整整数；DOGE_NETWORK_RETRY_BASE_MS 为 10–32000ms（默认500），CLAUDE_CODE_MAX_RETRIES 可调低但至多十轮。验证：focused 80/80（295断言）、逐文件干净进程全套 584/584（71文件，三项既有 bare 工具枚举测试提供本地假key，认证恢复测试清继承key）；版本入口2.1.277；三协议40场景94断言真实 localhost 故障、终态挂连接、SSE错误、十轮11POST、同进程双prompt历史、工具只追加一次、失败用量/result一致；另320ms迟到工具usage纠正实测永久账单44token与result一致。单进程全套仍存在既有全局配置/团队锁污染，隔离 runner 保留。
3. 位置：src/services/api/{requestLifecycle,streamRecovery,streamErrors,withRetry,claude,client,openaiCompat,responsesCompat}.ts 与对应 bun:test；src/query.ts、src/QueryEngine.ts、src/utils/sessionStorage.ts、src/types/logs.ts、src/utils/sessionStorage.networkRecovery.test.ts、src/entrypoints/sdk/coreSchemas.ts、src/components/messages/SystemAPIErrorMessage.tsx；tools/verify-network-recovery.ts（自清沙箱，NETWORK_E2E_FILTER 筛场景，DOGE_NETWORK_TEST_EXE 可验打包/安装 CLI）、tools/run-isolated-tests.ts。编译版与安装版三协议黑盒均为40场景94检查通过，随APP 0.2.104交付；实际用户数据已恢复。最终test/临时产物删除被自动审批策略拒绝（blocked by policy，缩小为明确脚本删除仍拒绝），未改用其他执行器绕过；本轮测试日志/临时脚本暂留test/，不纳入提交。

### 1. 自定义 API 认证绕过（2026-04）
1. 问题：自定义 OpenAI/Responses 提供商仍走官方密钥审批流程，无法直接用 env key。
2. 解决：检测到自定义 provider（openai/responses 或非官方 Anthropic URL）时跳过审批直接返回密钥（有意行为，改动须保持）。
3. 位置：`src/utils/auth.ts`、`src/services/api/client.ts`

### 2. OpenAI 兼容层基础修复（2026-04）
1. 问题：请求路径不标准；DeepSeek `max_tokens` 超出端点限制报错。
2. 解决：统一走 `/v1/chat/completions`；检测 DeepSeek 端点自动将 max_tokens 限到 32000。
3. 位置：`src/services/api/openaiCompat.ts`

### 3. Responses API 兼容层（2026-04）
1. 问题：仅支持 Responses 格式（`/v1/responses`）的网关无法接入。
2. 解决：新增 `responses` provider，实现 Anthropic↔Responses 双向转换与流式事件翻译。
3. 位置：`src/services/api/responsesCompat.ts`

### 4. 第三方模型上下文窗口识别（2026-04 ~ 05）
1. 问题：第三方模型（DeepSeek/GLM/Gemini/GPT 等）误用 200k 默认窗口，自动压缩阈值全错。
2. 解决：`CLAUDE_CODE_MODEL_CONTEXT_WINDOW` env 覆盖最高优先 + `[1m]` 后缀检测提前 + 常见模型硬编码（DeepSeek 现为 1M）。
3. 位置：`src/utils/context.ts`

### 5. 自动压缩 token 计数失效（2026-04）
1. 问题：只在流式首个 chunk 读 usage，DeepSeek 只在末 chunk 报 usage，promptTokens 恒 0，永不触发压缩。
2. 解决：每个 chunk 持续更新 usage，`message_delta` 事件携带 `input_tokens`。
3. 位置：`src/services/api/openaiCompat.ts`

### 6. DeepSeek reasoning_content 多轮透传（2026-04-24）
1. 问题：流式解析忽略 `reasoning_content`，多轮工具调用必报 400 "must be passed back"。
2. 解决：捕获为 Anthropic thinking 块，回传时从 thinking 块还原 `reasoning_content`（复用既有 thinking 管道）。
3. 位置：`src/services/api/openaiCompat.ts`

### 7. 1M 超长上下文（2026-05-06）
1. 问题：请求 betas 含 1M header 但未同步全局状态，autoCompact 仍按 200k 计算；`[1m]` 后缀优先级低于硬编码。
2. 解决：`paramsFromContext` 调 `setSdkBetas()` 同步；`getContextWindowForModel` 将 `[1m]` 检查提前。
3. 位置：`src/services/api/claude.ts`、`src/utils/context.ts`

### 8. 第三方 API 上下文溢出映射为 PTL（2026-05-08）
1. 问题：`[1m]` 后缀原样发给第三方 API；OpenAI 格式溢出错误（context_length_exceeded 等）不被识别为 PTL，压缩/截断链路全不触发。
2. 解决：openai/responses 两路径剥离 `[1m]` 后缀；溢出错误统一抛 "Prompt is too long" 格式；token gap 解析补 OpenAI 格式。
3. 位置：`src/services/api/openaiCompat.ts`、`src/services/api/responsesCompat.ts`、`src/services/api/errors.ts`

### 9. 转接层多模态图片（2026-09-05）
1. 问题：tool_result/user 消息里的 image 块被 `JSON.stringify` 成文本或静默丢弃，模型"看不到"图片。
2. 解决：新增 `imageBlockToImageURL`/`splitToolResultContent`，图片转 `image_url`/`input_image` 紧随 tool 消息放 user 消息；纯文本请求形状不变。
3. 位置：`src/services/api/openaiCompat.ts`、`src/services/api/responsesCompat.ts`

### 10. claude-to-IM 集成（2026-05-06）
1. 问题：Windows 上流不关闭（消息永不发出）、简化 handler 无工具、不支持多 provider 与 reasoning_content。
2. 解决：result 输出后关闭 stdin 并退出进程；新建带完整工具循环与 provider 路由的流式入口。
3. 位置：`src/cli/simpleStreamJson.ts`、`src/cli/simpleStreamJsonWithTools.ts`

### 11. effort 参数传递（2026-05-22/24）
1. 问题：openai/responses 兼容路径的请求转换不接收 `output_config`，effort 完全丢失。
2. 解决：两转换函数补 `output_config` 参数并透传 effort 到请求体顶层。
3. 位置：`src/services/api/claude.ts`、`openaiCompat.ts`、`responsesCompat.ts`

## 二、模型选择与凭证

### 67. /agents 模型选择器接 modelProfiles + task_started 透传模型（2.1.281，2026-10-04）
1. 问题：/agents 代理编辑器的模型下拉只读 legacy savedModels 扁平索引——provider 档位槽模型（defaultOpus/Sonnet/HaikuModel）在向导里看不见选不到；索引非空（或 openai provider）时 sonnet/opus/haiku 别名整组被挤掉；子代理实际跑什么模型 SDK 消费端完全不可见（LocalAgentTask/InProcessTeammate 任务态里的 model 只上 TUI 面板，不上 SDK 事件线）。
2. 解决：getAgentModelOptions 拆纯函数 buildAgentModelOptions——modelProfiles（主模型+三档位槽，带 providerName 标注，secure storage 权威、.claude.json 镜像兜底）∪ legacy savedModels ∪ 恒在四别名（sonnet/opus/haiku/inherit——别名由 getAgentModel 运行期按活动 provider 档位 env 解析，与完整 ID 并列即「跟档位 vs 钉模型」两种语义），精确字符串去重（[1m]/[2m] 变体是不同上下文窗口须保留）；registerTask 发 task_started 时按 `'model' in task` 泛读任务态 model 字段透传（LocalAgentTask/InProcessTeammate 两类自动覆盖，shell/dream 等无模型任务自然缺省），TaskStartedEvent schema 同步加可选 model（值可能仍是别名串，子代理每回合经 getAgentModel 再解析）。
3. 位置：`src/utils/model/agent.ts`（buildAgentModelOptions/getAgentModelOptions）、`src/utils/task/framework.ts`（registerTask 发射）、`src/utils/sdkEventQueue.ts`（事件类型）、`src/utils/model/agent.test.ts`（buildAgentModelOptions 四断言：档位槽露出/别名恒在/空态四选项/精确去重保 [1m]）；配套 APP 0.2.111 交付（行/侧栏模型徽章 + E2E T26e/T26f）。

### 12. Agent 层级模型 fallback（2026-04-08）
1. 问题：`getDefault{Opus,Sonnet,Haiku}Model` 硬编码官方模型名，单模型 API 下 Agent 显式指定档位必失败。
2. 解决：env 档位变量 → 用户主模型（直读 env+settings 避免循环依赖）→ 硬编码默认。
3. 位置：`src/utils/model/model.ts`

### 13. DeepSeek max effort 支持（2026-05-06）
1. 问题：自定义 API 端点下 `getAPIProvider()` 返回 firstParty，能力声明检查被跳过，max effort 不可用。
2. 解决：`ANTHROPIC_BASE_URL` 存在时视为 custom API，继续检查 `*_SUPPORTED_CAPABILITIES` 声明。
3. 位置：`src/utils/model/modelSupportOverrides.ts`

### 14. 持久化配置覆盖启动 env（2026-05-08）
1. 问题：启动时持久化的旧模型名无条件覆盖用户显式设置的 `ANTHROPIC_MODEL`（`[1m]` 后缀丢失）。
2. 解决：`applyPersistedCustomApiEndpointEnv` 加 env 守卫，仅 env 未设时才应用持久化值。
3. 位置：`src/utils/managedEnv.ts`

### 15. ModelProfile 体系与切换信任链（2026-05-08）
1. 问题：compat 适配器重读 `process.env.ANTHROPIC_MODEL` 覆盖上层已解析模型，`/model` 切换实际不生效；切换不清理旧凭证互相残留。
2. 解决：适配器信任 `input.model`；ModelProfile 持久化全套配置，`applyModelProfile` 以"有值则设、无值则删"应用全部 env。
3. 位置：`src/services/api/{openaiCompat,responsesCompat}.ts`、`src/utils/customApiStorage.ts`

### 16. Auth conflict 假警告（2026-05-08）
1. 问题：storage 残留 apiKey 与 `ANTHROPIC_AUTH_TOKEN` 并存时误报双密钥冲突。
2. 解决：仅当 `DOGE_API_KEY` 确实存在于进程 env 时才触发警告。
3. 位置：`src/utils/statusNoticeDefinitions.tsx`

### 17. 双存储一致性（2026-05-09）
1. 问题：`.credentials.json` 与全局 config 的 `customApiEndpoint` 更新不同步，顶层凭据/密钥类型交叉污染。
2. 解决：`authTokenType` 入存储并按类型分发 env；`normalizeModelName`（lowercase + 剥 `[1m]`）统一查找与去重。
3. 位置：`src/utils/customApiStorage.ts`、`src/utils/managedEnv.ts`

### 18. 切换写入顶层凭据 + provider 优先级（2026-05-14）
1. 问题：`/model` 切换把 profile 凭据写进 storage 顶层污染下一个模型；provider 解析四处 storage 优先于 env。
2. 解决：`applyModelProfile` 只更新 model 不写顶层凭据；auth/client/claude/agent 四处统一 env > storage；alias 与持久化模型的渲染走 `formatCustomModelLabel` 补 `(1M Context)` 指示器。
3. 位置：`src/utils/customApiStorage.ts`、`src/utils/auth.ts`、`src/services/api/{client,claude}.ts`、`src/utils/model/{agent,model}.ts`

### 19. 纯 doge 启动凭据错位（2026-05-17）
1. 问题：无启动脚本时按 storage 顶层标量恢复凭据，活跃模型拿不到自己的 profile 配置（A 模型跑在 B 端点）。
2. 解决：`applyPersistedCustomApiEndpointEnv` 优先按活跃模型匹配 profile 恢复完整凭据（带 env 守卫），顶层仅作 fallback。
3. 位置：`src/utils/managedEnv.ts`

### 20. ANTHROPIC_AUTH_TOKEN 认证链（2026-05-22）
1. 问题：`getAnthropicApiKeyWithSource` 只查 `DOGE_API_KEY`，Bearer 网关用户 403。
2. 解决：密钥获取同时认 `ANTHROPIC_AUTH_TOKEN`；启动恢复 profile 凭据优先于顶层；`configureApiKeyHeaders` 恢复 Bearer 处理。
3. 位置：`src/utils/auth.ts`、`src/utils/managedEnv.ts`、`src/services/api/client.ts`

### 21. effort/thinking 能力守卫与显示（2026-05-29）
1. 问题：custom API 端点被当 firstParty，effort/thinking/adaptive_thinking 对未知模型错误放行；thinking 衍生 temperature 误发；Responses 层 max_tokens 上限不一致（8192 vs 32000）。
2. 解决：effort/thinking 判定统一加 `isCustomApi` 守卫走 3P 保守路径；compat 路径改用显式 temperatureOverride；DeepSeek 上限统一 32000。
3. 位置：`src/utils/effort.ts`、`src/utils/thinking.ts`、`src/services/api/{claude,responsesCompat}.ts`、`src/components/ModelPicker.tsx`

### 22. effort 配置污染链根因（2026-05-29）
1. 问题：profile 采集/恢复/启动注入 effort，模型 A 的 effort 设置污染模型 B。
2. 解决：`captureModelProfile` 不采集、`applyModelProfile` 不恢复、`managedEnv` 不注入 `CLAUDE_CODE_EFFORT_LEVEL`；effort 来源唯一（env → AppState → 模型默认）。
3. 位置：`src/utils/customApiStorage.ts`、`src/utils/managedEnv.ts`

### 23. xhigh 思考档位（2026-07-14）
1. 问题：high 与 max 之间无中间档。
2. 解决：纯客户端枚举扩展 `xhigh`（发送层本就纯透传，无需协议改动），gate 复用 `modelSupportsMaxEffort`，仅会话级不持久化。
3. 位置：`src/utils/effort.ts`、`src/entrypoints/sdk/runtimeTypes.ts`、`src/components/{EffortIndicator,ModelPicker}.tsx` 等 7 文件

### 24. 原生模型 ID 升级（2026-07-14）
1. 问题：硬编码原生模型 ID 过时（Opus 4.6 / Sonnet 4.6）。
2. 解决：全量替换为 Opus 4.8 / Sonnet 5（Haiku 保持 4.5），含 configs/canonical/bedrock/vertex 变体/UI 文案；`modelSupports1M` 手动补 sonnet-5 分支。
3. 位置：`src/utils/model/` 起 55 文件

### 25. 模型切换统一入口（2026-09-17）
1. 问题：内联 ModelPicker 与 headless 多点直写模型槽不应用所选 provider 的 profile，会把模型名发到旧端点；同 model id 多 profile 匹配任意取第一个。
2. 解决：内联 picker 走完整 `decideAndSwitch`；headless 各点先经 `applyProfileForModelIfMatch`（会话级、失败回滚）；profile 匹配统一 `findProfileByModel`（env 激活端点优先）；`syncModelConfigToDisk` 提取为单一来源。
3. 位置：`src/components/PromptInput.tsx`、`src/utils/model/switchModelProfile.bindings.ts`、`src/cli/print.ts`、`src/utils/model/syncModelConfig.ts`

## 三、Computer Use（Windows）

### 26. Windows 平台支持基础（2026-04-24）
1. 问题：CU 原仅支持 macOS，Windows 上误弹 TCC 权限面板、应用发现不全、无 ESC 中止、UIPI 阻断 SendMessage、typeText 字符直插 PS 有注入风险。
2. 解决：Windows 权限检查直通（UIPI 逐操作检测）；多层应用扫描 + UTF-8 输出；WH_KEYBOARD_LL ESC hook（后台 PS + Named Pipe）；`elevation.ts` 检测完整性级别并回退 SendInput；字符按 charCode 传 VkKeyScan。
3. 位置：`src/utils/computerUse/hostAdapter.ts`、`win32/{escHook,elevation}.ts`、`platforms/win32.ts`、`packages/@ant/computer-use-mcp/src/{types,toolCalls}.ts`

### 27. Windows 稳定性（2026-04-24）
1. 问题：窗口被移屏幕外（-32000）用户失控；HWND 模式点击坐标丢失为 (0,0)；`Bun.spawnSync` 无 timeout 致事件循环冻结；zoom 每次重复全窗截图。
2. 解决：窗口保持原位；executor 记录 lastMouseX/Y 透传坐标；全部 PS 调用加 timeout；点击前置 WM_MOUSEMOVE；截图缓存 + .NET 裁剪；ESC 轮询 pipeBusy 守卫。
3. 位置：`src/utils/computerUse/platforms/win32.ts`、`executor.ts`、`win32/*`

### 28. mouse_move 与 cursor_position（2026-04-26）
1. 问题：HWND 绑定下 moveMouse 是空操作（无悬停效果）；cursor_position 读真实光标且坐标换算出 NaN 返回 null。
2. 解决：moveMouse 发送 WM_MOUSEMOVE；mouseLocation 返回逻辑坐标；截图结果补全 displayWidth/originX 等元数据。
3. 位置：`src/utils/computerUse/win32/windowMessage.ts`、`executor.ts`、`platforms/types.ts`

### 29. 应用发现与跨语言匹配（2026-04-26）
1. 问题：枚举截断丢失快捷方式条目（QQ 报打开成功实际未启动）；"WeChat" 匹配不到"微信"、空格差异匹配失败。
2. 解决：同名应用 .exe 路径条目优先去重、败者路径并入 `extraPaths`；归一化（去空格/连字符）匹配 + 路径段评分回退。（枚举层后由第 35 条重写）
3. 位置：`packages/@ant/computer-use-mcp/src/toolCalls.ts`

### 30. DPI 缩放与坐标精度（2026-04-26）
1. 问题：高 DPI 下截图逻辑像素与物理像素不一致；scaleFactor 双重计算；SendMessage 未修正标题栏偏移。
2. 解决：坐标类 PS 脚本 `SetProcessDPIAware`；`display.listAll` scaleFactor=1（返回值已是物理像素）；`GetClientOffset` 修正客户区坐标；captureScreen 按 targetW/H 预缩放并在响应中标注像素尺寸。
3. 位置：`src/utils/computerUse/win32/{windowCapture,windowMessage}.ts`、`platforms/win32.ts`、`executor.ts`

### 31. Electron/CEF 点击（2026-04-26）
1. 问题：Chromium 系应用忽略合成的 SendMessage 鼠标消息，点击无效且 UIPI 探测（WM_NULL）测不出。
2. 解决：绑定时枚举子窗口类名检测 Chromium，鼠标改 SetCursorPos + 真实输入（GetWindowRect 屏幕坐标换算）。（后扩展为第 36 条 windowClassify）
3. 位置：`src/utils/computerUse/platforms/win32.ts`

### 32. PowerShell 可变结构体陷阱（2026-05-01）
1. 问题：`$i.mi.dwFlags = x` 写的是结构体副本，SendInput 收到 dwFlags=0 等同空操作，点击/滚动无效。
2. 解决：弃用 INPUT 结构体，改用参数简单的 `mouse_event` API。
3. 位置：`src/utils/computerUse/platforms/win32.ts`

### 33. CU 永久开启与 zoom 修复（2026-09-05）
1. 问题：`computer-use` MCP server 被 `isDefaultDisabledBuiltin` 默认禁用；坏 shim（相对路径跳出仓库）致包 import 必挂；第三方端点无 CU 提示；zoom 非整数坐标致 PS 脚本挂掉静默返回空图。
2. 解决：`isDefaultDisabledBuiltin` 恒 false（仍可 /mcp 禁用）；file: 依赖直指 `packages/@ant/` 真包并删除坏 shim；注入本地 `COMPUTER_USE_MCP_PROMPT_HINT`；captureRegion 坐标取整 + 失败 throw。
3. 位置：`src/services/mcp/config.ts`、`package.json`、`src/utils/computerUse/setup.ts`、`platforms/win32.ts`

### 34. 输入前置卫兵（2026-09-09）
1. 问题：绑定窗口死亡/最小化后输入静默无效或打进当时前台窗口；`apps.open` 对已运行单实例应用盲启新进程 10s 后静默返回。
2. 解决：`ensureWindow`（IsWindow → 恢复 → AttachThreadInput 前台锁绕行 → ALT 微扰 → 重试校验，fail-closed）+ `guardBoundWindow` 编排（死窗按 PID/进程名重绑，失败抛面向模型的错误）；`apps.open` 已运行窗口优先绑定 + App Paths 注册表分支 + 失败抛错。
3. 位置：`src/utils/computerUse/win32/windowGuard.ts`、`platforms/win32.ts`

### 35. Windows 应用授权枚举（2026-09-09）
1. 问题：单个大 PS 脚本串行枚举必超 15s 守卫导致全部 not_installed；提示枚举 1s 超时恒空；运行中应用不参与解析。
2. 解决：五阶段并行枚举（注册表/App Paths/快捷方式 COM hoist/Get-StartApps/运行中窗口）+ 单飞缓存（658 应用约 1.3s）；枚举超时按平台（win32 8s）；`isUserFacingPath` 加 win32 排除制分支。
3. 位置：`src/utils/computerUse/win32/installedApps.ts`、`mcpServer.ts`、`appNames.ts`

### 36. 自绘窗口输入通道与拖拽（2026-09-09）
1. 问题：Qt/SDL/GLFW/Unity 等自绘框架窗口对 SendMessage 鼠标键盘无反应（模拟器点击 0 触摸事件）；drag 实为 3 次独立点击。
2. 解决：`windowClassify` 按窗口类名分类，自绘窗口鼠标键盘全走真实输入（前台卫兵保护）；拖拽改单条 PowerShell 完成 down→缓动帧→up 整手势。
3. 位置：`src/utils/computerUse/win32/{windowClassify,windowMessage}.ts`、`platforms/win32.ts`、`executor.ts`

## 四、TUI 与权限

### 66. Auto 自动规划来源、权限边界与 MCP 零咨询（2.1.280，2026-10-02；取代 38 的旧 Auto/Plan 语义）
1. 问题：Plan 沿用 bypass 启动旗标，自动规划和手动 Plan 混在一起；路径 allow/hook allow 可越过计划限制，hook ask 仍有询问通道，远程新消息会提前强切 Auto。计划历史按当前全局模式重渲染，退出后反而恢复手动采访模板；MCP 表单和 URL retry 绕过工具权限管道，另有咨询通道。新增自动答案又需保留 ElicitationResult 否决 hooks，并避免整数上界与格式字符串截断产生不合法输入。
2. 解决：仅模型从 bypassPermissions EnterPlanMode 设置 autoPlan，手动/旗标 Plan 保留交互；统一来源判定与模式转换清理，Ask 自动首选，ExitPlan 自动回 Auto，Plan 边界独立于 allow 规则与 hooks（只读和当前计划文件），异步权限检查重读模式，显式 deny/killswitch 保留。远程 Auto 保留自动计划；普通和压缩补发的计划 attachment 保存来源，历史提示不漂移。MCP 三条通道共享自动答案，默认值/首选项与受限基本类型经 SDK Ajv 校验，自动答案仍执行结果 hooks；不可生成有效答案则自动终结，不询问。独立审查五项实质问题均修复并加回归；全套按文件隔离 76 文件、631 测试通过（共享进程有既有配置/团队锁污染；认证环境清理后提醒单测使用本地假 key）。源码、编译与安装 CLI 六场景真实协议黑盒通过，Auto/自动 Plan 的 MCP form 与 -32042 URL retry 全程零咨询，计划/执行文件实写，标准/Accept/手动 Plan 保留审批。新增 MCP 模块对 SDK 类型独立检查通过；CLI version=2.1.280，随 App 0.2.107 打包，编译/安装 SHA256=8A778351395DBD35DCF9FB578977804BAA3CE540553D43F12617357AF1F18CED。编译源为 92b8974 基线加本轮源码；用户已于 2026-10-02 明确授权提交、合并 main 与删除功能分支，对应 CLI 源码 commit 由 App 提交说明记录。
3. 位置：src/utils/permissions/{autoBypass,autoPlan,permissions,permissionSetup,PermissionUpdate,currentPermissionMode}.ts；Tool.ts/types/permissions.ts、EnterPlanModeTool/ExitPlanModeV2Tool/AskUserQuestionTool、services/tools/toolHooks.ts、state/onChangeAppState.ts、constants/prompts.ts、utils/{attachments,messages}.ts、services/compact/compact.ts、services/mcp/{autoElicitation,elicitationHandler}.ts、utils/imRemote/autoMode.ts、screens/REPL.tsx、cli/print.ts；test/auto-plan.test.ts 与 auto-elicitation.test.ts 为保留的可复用测试源码。App 验证与测试现场清理记录见 docs/superpowers/plans/2026-10-02-agent-sidebar-auto.md（App 仓）。

### 37. /clear 与 /model 卡顿（2026-07-14）
1. 问题：skills 扫描不跳过 node_modules（claude-to-im 1 万+文件）；/clear 复用 resume 的全清把 fileIndex 清空，非 git 大目录触发 ripgrep 全量扫描 + Defender IO 饱和数秒。
2. 解决：markdown 扫描（ripgrep 与 native 兜底）剪枝 node_modules；`clearFileSuggestionCaches` 软清保留索引；非 git 兜底 `--max-depth`（`CLAUDE_CODE_FILE_INDEX_MAX_DEPTH`，默认 3）；同步 statSync 调用 setImmediate 让出主线程。
3. 位置：`src/utils/markdownConfigLoader.ts`、`src/hooks/fileSuggestions.ts`、`src/commands/clear/{caches,conversation}.ts`

### 38. auto 会话全放行（2026-09-09）
1. 问题：auto 会话 CU 仍弹授权框；模型进 plan 模式后工具又逐个问权限；plan 审批后静默降级 acceptEdits。
2. 解决：共享判定 `isAutoBypassActive`（bypass、或 plan 且 prePlanMode=bypass）接中央管道（deny/显式 ask/safetyCheck/requiresUserInteraction 仍先行）；CU 授权对话框 auto 短路走 `autoGrant`；plan 审批框罗列全部执行模式由用户选、auto 不代选不放行。
3. 位置：`src/utils/permissions/autoBypass.ts`、`permissions.ts`、`src/utils/computerUse/autoGrant.ts`、`src/components/permissions/ExitPlanModePermissionRequest/`

## 五、2026-09-17 安全与多智能体审计批次

### 39. 子进程密钥默认清除
1. 问题：Bash/MCP stdio/hooks/LSP 子进程继承明文 `DOGE_API_KEY`，auto 会话下可被注入外带。
2. 解决：`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 三态——未设=默认清除 doge 自身凭证；truthy=GHA 全量清单（兼容）；falsy=关闭（逃生门）。云凭证不进默认清单。
3. 位置：`src/utils/subprocessEnv.ts`

### 40. teams 信箱发送者认证
1. 问题：`shutdown_approved`/`plan_approval_request` 只查 JSON 形状，伪造信箱写入可杀任意 tmux pane、按名删成员、骗全放行审批。
2. 解决：一律先过 `findRegisteredMember`（对照团队文件 members，非内存注册表）——未注册名字直接忽略；killPane 仅当 paneId+backendType 与该成员注册值匹配才执行。
3. 位置：`src/utils/swarm/teamHelpers.ts`、`src/hooks/useInboxPoller.ts`

### 41. teammate spawn 会话盲区与 env 白名单
1. 问题：spawn handler 读旧全局模型，lead 会话内 /model 切换后新 teammate 拿错模型；tmux 白名单缺 provider/档位 env，teammate 协议回退 anthropic 打错端点。
2. 解决：三处 spawn 统一 `getLeaderModel`（mainLoopModelForSession 优先）；`TEAMMATE_ENV_VARS` 补 provider/档位/能力 env（密钥绝不进白名单），env-only 凭证 spawn 时记诊断 error。
3. 位置：`src/tools/shared/spawnMultiAgent.ts`、`src/utils/swarm/spawnUtils.ts`

### 42. 审计小修集合
1. 问题：`CLAUDE_CODE_SUBAGENT_MODEL='inherit'` 字面量直发 API 404；删 provider 只清部分档位 env；/fuck 漏删 AUTH_TOKEN；UI 清 key 不删 env；OAuth 覆盖式写抹掉 modelProfiles[]；备份落盘留明文 key。
2. 解决：'inherit' 按未指定处理；清 env 用 PROFILE_MANAGED_ENV_KEYS 全量清单；补删 `ANTHROPIC_AUTH_TOKEN`；清 key 同步删 env + 补跑互斥卫兵；`persistCustomEndpoint` 改合并式写入；备份经 `writeConfigBackup` 剥 key、`writeAtomicJson` 权限 0600。
3. 位置：`src/utils/model/agent.ts`、`src/commands/provider/provider-remove.tsx`、`src/commands/fuck/`、`src/components/Settings/Config.tsx`、`src/components/ConsoleOAuthFlow.tsx`、`src/utils/config.ts`

### 43. 死代码删除
1. 问题：swarm 的 executor 抽象（InProcessBackend/PaneBackendExecutor）全仓零调用者，spawnUtils 存在与 live 版本漂移的死副本。
2. 解决：删除 executor 抽象、孤儿类型与死副本函数（live 版本保留在 spawnMultiAgent 局部）。
3. 位置：已删 `src/utils/swarm/backends/*`，清理 `src/utils/swarm/{registry,types,spawnUtils}.ts`

## 六、2026-09-20 记忆加载批次

### 44. AGENTS.md 回退加载与 .doge/rules 检测残留
1. 问题：记忆加载器只认 CLAUDE.md 家族，业界通行的 AGENTS.md 完全不被加载（仅 /init 当参考素材读）；`isMemoryFilePath` 仍检测 `.claude/rules`（fork 改名残留），与加载器实际读的 `.doge/rules` 不一致。
2. 解决：目录级 CLAUDE.md 无可加载内容（缺失/空/被排除）时回退加载同目录 AGENTS.md，二者永不叠加，回退覆盖主遍历、--add-dir、子目录嵌套三处入口；`isMemoryFilePath` 改判 `.doge/rules` 并识别 AGENTS.md；onboarding 检查认可 AGENTS.md（不再误提示 /init）。
3. 位置：`src/utils/claudemd.ts`（新增 `processProjectMemoryFileWithFallback`）、`src/projectOnboardingState.ts`；测试 `src/utils/claudemd.test.ts` + `test/e2e-agents-md-fallback.ts`

## 七、2026-09-21 headless 图片路径批次

### 45. headless stdin 图片块无盘上路径（模型只能看不能改）
1. 问题：`-p --input-format stream-json` 的用户消息里 base64 图片块原样透传 API——交互 TUI 有 storeImages 落盘 + `[Image: source: <path>]` 元数据，headless 路径（QueryEngine 直接 processUserInput 且不传 pastedContents）全跳过，模型拿到 token 化像素却没有文件可指，无法 Read/Bash 修改图片。
2. 解决：print.ts 入队时 `materializeStdinImageBlocks` 把数组内容的 base64 图片块移入 QueuedCommand.pastedContents（复用交互管线：落 session image-cache + isMeta source 元数据 + resize），ask()/QueryEngine.submitMessage()/processUserInput 透传 pastedContents，批处理合并 `mergeQueuedPastedContents` 顺序重编号防 id 撞；stdin 行可选 `image_paths`（与图片块按序对齐，绝对路径 + existsSync 校验后作 sourcePath）让嵌入壳（桌面 app）指向拖入的原文件而非 cache 副本，url/file 源与空数据块原样保留并对齐计数。
3. 位置：`src/bridge/inboundAttachments.ts`（materializeStdinImageBlocks/extractStdinImagePaths）、`src/cli/print.ts`（enqueue/批合并/ask 调用）、`src/QueryEngine.ts`（ask/submitMessage）、`src/types/textInputTypes.ts`（mergeQueuedPastedContents）；测试 `src/bridge/inboundAttachments.test.ts`（10 项），黑盒 doge-code-app tools/verify-image-protocol.mjs（13 项）

## 八、2026-09-25 teammate 进度事件批次

### 46. in-process teammate 工作中 headless stdout 零排放（桌面壳看不到子 agent 进度）
1. 问题：agent-teams 队友（in-process teammate）派生后到终态 bookend 之间，`-p stream-json --verbose` 输出完全静默数分钟——队友循环每跳都算了 progress（updateProgressFromMessage/getProgressUpdate）却只写 AppState（TUI 面板用），从不调 emitTaskProgress；桌面壳/SDK 消费者只能干等。
2. 解决：队友消息循环补发 `system/task_progress`（镜像 AgentTool 同步子代理的按 tool_use 触发语义：lastToolName 存在才发，taskId 现成、description=队友任务描述、startTime=runner 启动时刻、summary=活动描述 activityDescription）；`lastToolUseName` 用本地 helper（import agentToolUtils 会成环：AgentTool→spawnMultiAgent→inProcessRunner）。enqueueSdkEvent 非交互会话专属（TUI 无操作），task_started/task_notification 首尾 bookend 原有不变。配套坑（壳侧实锤）：AgentTool 与本处两个发射点的 task_progress `description` 字段语义不同（前者放活动描述、后者放任务描述）——消费者刷新行进度的活动文案应取 `summary ?? description`，不得覆盖 task_started 落定的任务描述。
3. 位置：`src/utils/swarm/inProcessRunner.ts`（lastToolUseName helper + 循环内 emitTaskProgress）；黑盒 doge-code-app tools/verify-chat-pane.mjs T26a/b（teamprog-child 相位链驱动真实队友 Read 工具跳）

## 九、2026-09-27 fileHistory 快照竞速

### 47. 逐轮文件快照 fire-and-forget 与本轮首次写盘竞速（rewind 停在本轮中途而非本轮开始前）
1. 问题：fileHistory 按用户消息 uuid 的逐轮快照在三个调用点全部 `void` 派发——本轮第一次 Edit/Write 可抢在 makeSnapshot 异步 Phase 2（stat+内容对比+copyFile）落盘前写盘；同一文件跨多轮被改时，本轮快照里存的是本轮中途内容，/rewind（及 headless rewind_files）回到本轮无法完整撤销本轮改动。
2. 解决：三处调用点改为等待完成（`await Promise.all(...map)` 或直接 `await`），快照落盘后 query 循环/初始消息派发才开始；makeSnapshot 签名不动。mtime 捷径核查：`compareStatsAndContent` 的 size 短路（`size` 不等即判已变、进入新建备份）自初始提交起就排在 mtime 捷径之前，无需新增，仅以单测钉住。补聚焦单测钉「await 返回即备份已落盘」契约 + size 短路回归。
3. 位置：`src/QueryEngine.ts`（headless/SDK）、`src/utils/handlePromptSubmit.ts`（TUI）、`src/screens/REPL.tsx`（初始消息 processInitialMessage）三处调用点；测试 `src/utils/fileHistory.test.ts`（2 项）

### 52. IM 远程控制审查修复批（随 app 0.2.88/0.2.89，CLI 2.1.263→2.1.264）
1. 问题：子代理审查揪出 9 项 P1——适配器 stop() 置空 abort 令 `!abort?.signal.aborted` 恒真轮询复活（macOS 退出泄漏进程）；Telegram observeChatId 在 allow 校验前，陌生人首条消息即可锁定出站 chat 劫持全部回复；daemon 内存副本整份回写覆盖设置页刚改的凭据；会话断开 pending 不清致 IM 假确认；十余处 `void adapter.sendText` 无 catch 成 unhandled rejection；空 token 过 `?token=` 等值校验；Telegram 启动积压 update 重放进路由；client attach 的 attaching 清空 finally 挂内层 try，「配置不存在」早退不清空——重试与后续 attach 全拿旧已决 false promise（会话永不接入的真根因）。
2. 解决：适配器加 stopped 布尔（stop 不再置空 abort）＋启动 getMe 后丢弃积压批；observeChatId 移入 allow 校验之后；persistDaemonKeys 只写 pair/allowedUsers 两键（'pair' in patch 判定，undefined=清除）；handleSocketClose 清该会话 pending 并提示；safeSend/safeOptions 统一吞错；token<16 拒绝启动；attach finally 提到全 body；重试定时器 unref（防钉死一次性 `doge -p`）＋未配置机器探测上限 20 次；IM fetch 全部 10s 硬超时（AbortSignal.any/??）；runImRemoteDaemon 失败路径 process.exit 硬退（exitCode 穿不透引导期驻留任务，形成「spawn 成功全静默」假挂起）；daemon 生命周期日志落 im-remote-daemon.log（stdio ignore 下管道日志不可靠）。
3. 位置：`src/utils/imRemote/adapters/{telegram,feishu}.ts`、`src/utils/imRemote/{client,daemon,types}.ts`；测试 test/e2e-im-remote.ts 18 项 + src/utils/imRemote/*.test.ts 24 项全绿。

## 十一、2026-09-30 IM 远程控制批次（doge im）

### 49. 壳/独立双环境 spawn 守护进程缺 git-bash env 秒退（stdio ignore 全静默）
1. 问题：`doge im` 守护进程由 Electron 壳 spawn 时直接退 1——CLI bootstrap 在 Windows 要求 git-bash（PTY/headless 两条路靠壳注入 `CLAUDE_CODE_GIT_BASH_PATH`），新 spawn 路径只传了 `...process.env`；且 stdio ignore 时错误文案全被吞，表现为「spawn 成功但无状态文件、无退出日志」的假挂起。
2. 解决：守护进程 spawn env 必须并 `cliBaseEnv()`（壳侧 src/main/imRemoteManager.ts，与 PTY/headless 同源）；子进程 stdio 用管道并把 stdout/stderr 逐行转日志（`[im-remote] daemon:`），排障不再靠猜。
3. 位置：doge-code-app `src/main/imRemoteManager.ts`（startImRemoteDaemon）。

### 50. 会话客户端 attaching 承诺不清空——重试与后续 attach 全拿旧已决 promise
1. 问题：`attach()` 的 `finally { this.attaching = null }` 挂在 connect 段的内层 try 上，「配置不存在/未启用」早退路径不经过它；首启时远程未配置的会话（绝大多数）attach 一次后 attaching 永远非空，8s 重试与一切后续 attach 都 `return this.attaching` 拿回旧 false——会话永不接入，且无任何报错。
2. 解决：try/finally 提到整个异步体外层（所有出口都清 attaching）；重试定时器 `unref()`（否则一次性 `doge -p` 进程被探活定时器钉住不退出）；配置缺失也排程低频重试（用户后开远程时已开会话能接上）。回归钉在 test/im-retry-probe.ts（无配置→补配置+起 daemon→应最终 isConnected）。
3. 位置：`src/utils/imRemote/client.ts`（attach/scheduleRetry/destroy）。

### 51. TUI 会话挂载点在 REPL——首启三连弹（信任/API key/登录）会令远程接入静默失效
1. 问题：黑盒里 boot TUI 永不接入；排查发现 attach effect 在 REPL.tsx，而 TUI 首启可能停在项目信任对话、custom API key 批准（`customApiKeyResponses.approved`，存 key 末 20 字符）、未登录引导——REPL 未挂载 effect 不运行，且进程被「No, exit」杀掉后 xterm 只剩分隔线，极易误判为客户端 bug。
2. 解决：种子侧修（黑盒沙箱需 onboarding+信任+approved 三件套，且 boot cwd 取自会话列表首个项目——须种会话 jsonl 而非只钉 lastCwd）；产品侧无改（模态属预期引导）。诊断通道=env `DOGE_IM_REMOTE_DEBUG=1` 打开 client 的 ws/attach 诊断行。
3. 位置：doge-code-app `tools/verify-im-remote.mjs`（setupSandbox）；`src/utils/imRemote/client.ts`（env 门控诊断）。

## 十、2026-09-29 git worktree 功能修复批次

### 48. 退出对话框 fail-open 静默强删用户工作（数据丢失风险）
1. 问题：WorktreeExitDialog 退出时 `git status`/`rev-list` 失败（或 hook 型 worktree 无 originalHeadCommit）都误判 0 变更 0 提交 → 静默 `cleanupWorktree()`（`worktree remove --force` + `branch -D`）丢弃真实工作；且 git 命令依赖隐式 cwd（模型 cd 过即数错目录），与 ExitWorktreeTool 的 fail-closed 哲学相反。
2. 解决：countWorktreeChanges 提升为 worktree.ts 共享导出（显式 `git -C worktreePath`，git 失败/无基线返回 null）；Dialog 与 ExitWorktreeTool 共用；Dialog 收到 null 时不再静默删，显示对话框+「无法验证」警告文案；resumed worktree（fast-resume 基线漂移，上一会话提交不可见）永不静默删。
3. 位置：`src/utils/worktree.ts`（countWorktreeChanges/finalizeHeadlessWorktree）、`src/components/WorktreeExitDialog.tsx`、`src/tools/ExitWorktreeTool/ExitWorktreeTool.ts`；测试 `src/utils/worktree.test.ts`

### 49. headless `-p -w` 退出无收尾（worktree 与分支永久孤儿）
1. 问题：cleanupWorktree/keepWorktree 只有 TUI 的 WorktreeExitDialog 调用；headless `-p -w` 结束后 worktree+分支永久残留，30 天陈旧清理的 pattern（agent-/wf_/bridge-/job-）不覆盖会话级 slug。
2. 解决：print.ts runHeadless 经 registerCleanup 挂 finalizeHeadlessWorktree：可验证干净（创建起 0 文件 0 提交）→ 删 worktree+分支；dirty/resumed/不可验证 → 保留并向 stderr 报告路径与原因（注释写明 gracefulShutdown 2s 清理预算的截断语义）。
3. 位置：`src/cli/print.ts`、`src/utils/worktree.ts`；e2e `test/e2e-worktree-headless.ts`（本地 mock SSE server 三场景）

### 50. filePersistence types 丢失运行时常量 → print.ts 动态 import 全灭（headless -p 在 Windows 挂死根因）
1. 问题：逆向还原快照的 `filePersistence/types.ts` 只剩类型，filePersistence.ts 具名 import 的 DEFAULT_UPLOAD_CONCURRENCY 等 3 常量在 ESM 链接期报 "Export not found"——所有 `import('./cli/print.js')`（main.tsx 里被 void 吞掉 rejection）静默失败，headless `-p`（含 `-p -w`）进程悬空挂死；main.tsx:2907 注释误诊为「Bun on Windows 模块解析挂起」。
2. 解决：types.ts 补回 3 常量（保守值，BYOC 远程模式专用、非 byoc 环境恒 no-op）与 3 类型；链接契约以单测钉住防再次静默回归。
3. 位置：`src/utils/filePersistence/types.ts`；测试 `src/utils/filePersistence/types.test.ts`

### 51. `.doge` 目录绕过危险目录保护 + skills 编辑建议死循环
1. 问题：DANGEROUS_DIRECTORIES 有 `.claude` 无 `.doge`——本项目 fork 的 settings/hooks/skills 全在 `.doge/` 下可被自动编辑（hooks 是可执行脚本）；`.claude/worktrees/` 特判指向本 fork 不存在的死路径。补 `.doge` 后又暴露既有断裂：getClaudeSkillScope 建议的 `/.doge/skills/<name>/**` session 规则被 step 1.6 只认 `.claude` 前缀的检查拒绝 → 建议死循环。
2. 解决：DANGEROUS_DIRECTORIES 加 `.doge`；worktrees 特判迁至 `.doge`（`.doge/worktrees/<slug>` 内可编辑、嵌套 `.doge` 仍拦）；step 1.6 前缀判定抽成 isConfigFolderSessionEditRule 纯函数并接受 `.claude`/`.doge` 双前缀（拒绝 `..` 逃逸）。
3. 位置：`src/utils/permissions/filesystem.ts`、`src/tools/FileEditTool/constants.ts`；测试 `src/utils/permissions/filesystem.test.ts`

### 52. worktree.ts 悬空 import 死代码（postCommitAttribution）
1. 问题：`import('./postCommitAttribution.js')` 引用的模块在本 fork 不存在（COMMIT_ATTRIBUTION flag 运行时恒关，该分支从未执行也无从成功）。
2. 解决：删除该块，留注释说明上游遗留与删除理由；`feature` import 一并清理。
3. 位置：`src/utils/worktree.ts`（performPostCreationSetup 尾部）

## 十一、2026-09-30 App 工作树通知配套

### 53. App 运行目录与会话身份同步、干净树替换保留
1. 问题：App 不能从 TUI 可靠识别 Enter/ExitWorktree 与 /clear 后的 cwd/session ID，hooks 被关闭时钩子通知无效；headless 替换会话的旧进程原生清理会删除新进程继续使用的干净工作树。
2. 解决：纯叶模块 shellWorkspaceMarker 在 DOGE_APP_WORKSPACE_MARKER=1 时向 stderr 写私有 OSC 帧，含 PID、cwd、session ID（UTF-8 JSON/base64），闭管道不阻塞状态更新；用 node:fs writeSync 直写 fd 绕过 Ink 对 stream.write 的接管（真实 /clear 黑盒发现旧写法被吞）。setCwdState/regenerateSessionId/switchSession 三入口通知，普通 CLI 不输出。headless end_session 的 app_replace 原因只保留树，其余退出仍沿用 finalizeHeadlessWorktree；壳解析过滤子进程、避免跨管道 init 乱序，并在恢复确认前保留请求 ID。配套 App 0.2.84 重编内置 CLI，0.2.86 沿用该二进制；用户已于 2026-09-30 确认提交、合并 main 并删除已合并功能分支。
3. 位置：src/utils/shellWorkspaceMarker.ts（纯叶）、src/bootstrap/state.ts、src/cli/print.ts；worktree + shellWorkspaceMarker.test.ts 19/19（47 断言）、bun run version 通过；App tools/check-worktree.mjs 与安装版 verify-worktree.mjs 32/32 真实 Git+CLI 集成，含 hooks 禁用、TUI Enter/Exit 与 /clear、headless 恢复/替换；会话恢复 29/29。所有临时测试数据清理，CLI 原有 .zcode/ 两份计划未修改、不纳入本轮。

## 十二、2026-10-01 飞书长连接修复批次（随 app 0.2.90–0.2.91，CLI 2.1.265→2.1.266）

### 54. 飞书实机三连环静默：配对码不可见 + 异常击杀进程 + 长连接缺失
1. 问题：飞书实机（0.2.89 现场）三条叠加——① App 在 daemon 启动后生成配对码写盘，daemon 只认启动时的内存配置，`/pair` 恒判无效（日志铁证：23:55:54 启动「配对码=未生成」，c8vuza 直到 00:06:30 重启才被读到）；② `onMessage: msg => void this.onImMessage(msg)` 无 catch，任何一次 IM 发送失败（限流/网络抖动）的 rejection 直接击杀 Bun 进程且零日志——手机端「首条未配对警告后再无任何回应」的根因；③ 适配器走历史消息轮询、从未建立飞书官方长连接，开发者平台选「长连接模式」后控制台恒显「连接失败」。
2. 解决：① daemon 每条入站消息前 refreshAuthState 重读磁盘 pair/allowedUsers/summaryEvery/autoMode；② onMessage 链路 catch 落日志 + 全局 unhandledRejection 落日志不退出、uncaughtException 落日志后再硬退出，未配对警告按用户 10 分钟节流防群聊刷屏；③ 飞书适配器接入官方长连接协议（POST /callback/ws/endpoint {AppID,AppSecret} 换连接 URL → pbbp2 protobuf 帧 WS：按 ClientConfig.PingInterval 发 ping 控制帧、pong 载荷刷新重连参数、事件帧按 message_id/sum/seq 重组后回 ACK 帧），历史轮询降级为保底、双路共享 message_id 去重、发送目标回退最近入站会话；协商 514/403/连接数超限判不可重试并注明「回退轮询」，appId 格式守卫对齐官方 cli_+16hex。**手写 pbbp2 编解码器的 `skip()` 存在 `this.pos += this.length()` 求值顺序 bug（+= 先读左值，长度前缀自己消费的字节被吞，每个未知字段恒差 1 字节）**——官方 d.ts 只声明到 field 9 而真实服务器发 10/11/12/14/20/21/22 扩展字段，mock 帧无未知字段所以探针全绿、实机必炸；靠实连抓包帧逐字段步进定位，修复后以真实帧固化回归夹具。
2b. 补修（同轮，2.1.266）：`fail` 助手原定义在 runImRemoteDaemon 函数体内而 ImRemoteDaemon.run() 的 catch 也引用——适配器连接失败的退出路径二次抛 ReferenceError（旧版变僵尸进程，unhandledRejection 硬化令其显形），已提为模块级；App 侧守护进程拉起改经 wscript 隐藏启动器（GUI 子系统零控制台握手，vbs 随包分发），cmd start /b 仅兜底。
3. 位置：src/utils/imRemote/adapters/feishuProto.ts（手写编解码，官方 golden 向量 + 真实抓包夹具双钉）、feishuLongconn.ts（长连接通道）、feishu.ts（双路接收/去重/发送兜底）、daemon.ts（refreshAuthState/崩溃硬化/节流/模块级 fail）；测试 test/feishu-ws-probe.ts（23 检查：golden 对拍、协商→ping/pong→事件→ACK→分片→双路去重→@占位符剥离→断线重连→不可重试降级→停机 + 真实帧夹具）、test/feishu-real-dump.ts（实连诊断工具）；回归 e2e-im-remote 18/18、im-retry-probe 通过；实机验证：真实凭据长连接 200-250ms 建立、25s 零帧错误（2.1.265 与 2.1.266 两轮）、配对/回复链路 mock 全绿。

## 十三、2026-10-01 远程控制二轮（随 app 0.2.92，CLI 2.1.266→2.1.267）

### 55. Auto 死开关 + 远程消息桌面不可见 + 多频道架构（扫码网页/企业微信/远程唤起）
1. 问题：app 0.2.91 实测五类——① 接入即 Auto 的切换被 `toolPermissionContext.isBypassPermissionsModeAvailable` 门拦死：该旗标只有以 bypass/危险旗标启动的会话才为 true（permissionSetup L939 按 launch 形态计算），普通会话恒 false → 切换死代码，桌面照弹权限且早期请求不推远程；② headless 远程 prompt 走内部 enqueue，QueryEngine 只对本地命令 stdout 发 user 帧——壳的 ChatPane 无从渲染远程消息气泡；③ 无会话时远程消息只得到一句拒绝，无唤起；④ daemon 单适配器（this.adapter 唯一）无法承载新频道；⑤ 微信/二维码完全缺失。
2. 解决：① attach 切换与每条远程 prompt 到达时都按 `!isBypassPermissionsModeDisabled()` 断言 bypass（对齐 print.ts handleSetPermissionMode 的 fork 语义——控制请求路径早已弃用该可用性门，两处语义本来矛盾）；② print.ts onPrompt 补发同 uuid 的 user 帧并带 `dogeRemote: true` 标记（壳的直播路径对无标记字符串 user 帧刻意不回显——本地输入由壳自 append；带标记帧按真实用户气泡渲染，与历史恢复 foldAgentConversation 同形）；③ daemon 重构多频道：channels[]（custom bot + web）各自启停、单频道失败仅跳过、广播出站 + 来源路由应答、新会话接入即广播通知（含 Auto 说明）；④ 新增扫码网页频道（im-remote-web.json 独立文件：enabled/port/token；0.0.0.0 HTTP+WS 下发内嵌聊天页 webPage.ts——纯字符串无外部资源、页面 30s 心跳对冲 idleTimeout、按钮点击映射回 /allow 等价指令；QR=`http://<LAN-IP>:<port>/#t=<token>`，多网卡给备选列表；令牌即门禁无配对流程）；⑤ 新增企业微信智能机器人频道（官方长连接 JSON over WSS wss://openws.work.weixin.qq.com，帧对照 @wecom/aibot-node-sdk 源码：aibot_subscribe{bot_id,secret}→errcode=0、cmd:'ping' 30s 心跳连续 2 次无应答判死、aibot_msg_callback 收信（msgid 去重/chattype single 时 chatid=userid）、aibot_respond_msg 透传回调 req_id（24h 窗口）否则 aibot_send_msg 主动推送、disconnected_event=被顶替不重连、req_id=`<cmd>_<ts>_<rand>`；30 条/分钟限频做 120ms 轻节流）；⑥ 无会话时 daemon 暂存 prompt（HELD_PROMPT_TTL 90s）并广播 no_session 监控帧（壳据此自动新建对话标签），新会话 hello 即 flush 投递；⑦ 会话客户端 attach 门改双配置：任一频道 enabled 且有 token 即探测（web-only 机器无 im-remote.json 时 localhost WS 用 web token + 默认口，getConfig 合成 autoMode 默认开的空配置）。
3. 位置：src/utils/imRemote/daemon.ts（多频道重构/heldPrompt/接入通知）、adapters/webChat.ts + webPage.ts（新）、adapters/wecom.ts（新）、types.ts（wecom 平台/web 配置/webUrl·no_session 帧）、config.ts（imRemoteWebConfig 全家 + wecom 归一，端口清洗带各自 fallback 4763/4764）、client.ts（双配置门/endpoint 参数化）、print.ts、REPL.tsx、main.tsx（im 描述）；测试 config.test.ts（web 配置读写分离/wecom 就绪门 +9 检查）、test/e2e-im-remote.ts（双频道并存：网页令牌门/免配对直驱/双频道广播/按钮应答/no_session 唤醒 flush/状态帧 webUrl，28 断言全绿）。已知边界：wecom 适配器协议对照官方 SDK 实现但未经真实企业微信凭据实测（个人微信无合规本地方案——设置页引导用扫码频道覆盖）。

### 56. 扫码打不开双根因：QR 主地址被虚拟网卡抢占（0.2.93）
1. 问题：用户实测「微信/飞书扫码都打不开页面」，而 app 侧 E2E 全绿（netstat 证明 daemon 正常监听 0.0.0.0:4764）。根因在 webUrlCandidates：os.networkInterfaces() 原序无过滤无排序，多网卡机器上 VMware×2/vgate0/六块 169.254 链路本地地址把物理网卡挤出 QR 主位，二维码常是打不开的虚拟地址（另一根因=Windows 防火墙对 wscript 隐藏拉起的 daemon 自动生成入站 Block 规则，loopback 流量不过防火墙故工装恒绿——该侧修复在 app 仓 imRemoteManager）。本机真值：VMware 192.168.219.1/198.1、vgate0 172.30.250.122、169.254×6 抢位，真实「以太网 192.168.1.169」排不上第一。
2. 解决：webChat.ts 导出纯函数 `nicPriority(name, address)`——虚拟网卡名（vEthernet/VMware/VirtualBox/Loopback/ZeroTier/Tailscale/Docker/WSL/vgate/蓝牙/本地连接*）与 127/8、169.254/16 一律返回 null 排除；其余按 192.168=0 → 10.=1 → 172.16-31=2 → 100.64-127（CGNAT）=3 → 其它=4 排序，webUrlCandidates 稳定排序后主地址即物理网卡、其余进备选列表（daemon 状态帧 webUrls 数组不变）。
3. 位置：src/utils/imRemote/adapters/webChat.ts（nicPriority + webUrlCandidates 重写）、src/utils/imRemote/webChat.test.ts（新：物理网卡排序/虚拟网卡排除/链路本地排除/CGNAT 垫底 4 组断言）。e2e-im-remote 的 webUrl 断言宽松（http:// + #t=）不受排序影响。中文网卡名（蓝牙网络连接、本地连接* n）进正则——Wi-Fi Direct 与蓝牙 PAN 不是手机回传路径。

### 57. 三路审查修复轮：daemon 双拉/僵尸/wecom 健壮性/heldPrompt 回音（0.2.94）
1. 问题：app 侧发起三路子代理审查（主进程/渲染层/CLI 仓），CLI 侧实锤：① `lastPathSegment` 只按 `/` 切分——Windows 反斜杠 cwd 下 TUI 会话标签是全路径，print.ts:2928 另有一份正确的双分隔符实现（共享份坏、私有份对，纪律 7 反例）；② daemon 的 localhost `Bun.serve`(4763) 无 try/catch——本机实测 Bun 1.3.11 端口冲突**同步抛**，`run()` 抛出后落进 unhandledRejection 处理器被「已忽略」，适配器轮询钉住事件循环、状态文件停更（0.2.87「spawn 成功全静默」僵尸形态复活）；③ wecom 适配器四洞：subscribe 无 ack 超时（服务器收下 WSS 后挂起则永久吊着——心跳只在认证成功后启动）、`disconnected_event` 终态不回传 daemon（ChannelRuntime.running 谎报、/status 与状态文件照显在跑、出站静默黑洞）、并发 deliver 读同一 lastSendAt 突破 120ms 限频、网络级 onclose 退避恒 2s（attempt 只认 authFailures）；④ heldPrompt 单槽静默覆盖（第二条 prompt 顶掉第一条且第一条用户已被告知「接入后自动处理」）、TTL 过期/投递失败零回音；⑤ reply/broadcast 出站失败走 logForDebugging（非 --debug 即 no-op），且 TelegramAdapter 是唯一无 log 回调的适配器；⑥ daemon 日志与状态文件落完整 `#t=<token>` URL（报障分享泄漏钥匙）；⑦ Auto 强切判定在 REPL/print 三处两形态复制；⑧ 远程 user 帧 `as SDKUserMessageReplay` 掩盖缺 isReplay、dogeRemote 未在 schema 声明；⑨ 虚拟网卡正则漏英文 Windows 名（Bluetooth Network Connection / Local Area Connection* / Wi-Fi Direct——蓝牙 PAN 拿到可路由地址会以 192.168 优先级抢 QR 主位）。
2. 解决：⑴ format.ts 正则改 `[\\/]` + print.ts 改用共享份；⑵ Bun.serve 包 try/catch → `fail(1, 'localhost 端口被占…退出')`（先 stopChannels 收尾适配器）；⑶ ImAdapterHandlers 加可选 `onStopped?(reason)`，daemon 侧 markChannelStopped（置停+IM 广播+状态文件），wecom 的 disconnected_event 调用之；⑷ wecom：`armHandshakeTimeout`（15s，收到 subscribe ack 清除，超时 close 走统一重连）+ 独立 networkFailures 计数（认证成功清零）参与退避 + `sendText` 串行 promise 链（节流不再被并发穿透）+ 出站 ack errcode≠0 落日志——**透传 req_id 无 aibot_ 前缀，不能按前缀识别**（wecom 探针抓出的真 bug：识别条件改为「无 cmd 且非 subscribe/ping 前缀即记」）；⑸ heldPrompt 覆盖/过期/投递失败三路径 reply 回音；⑹ 出站 catch 改 logLine + TelegramAdapter 构造器加 log 回调；⑺ daemon 日志 URL 经 `redactWebUrl`（#t=<redacted>；状态文件与 monitor 帧保留完整——App QR 数据源）；⑻ Auto 判定收敛 `utils/imRemote/autoMode.ts` 纯函数 `remoteAutoTargetMode(autoMode, currentMode, bypassDisabled)` + 单测（注意调用方传 `getConfig()?.autoMode === true`——null 无配置时不动，与旧语义一致）；⑼ 远程帧改 `satisfies SDKUserMessageReplay & { dogeRemote: boolean }` + 补 isReplay:true（壳不消费该键，已核实）；⑽ 正则补英文网卡名；⑪ webPage 删 esc() 死代码 + #log 300 条裁剪；⑫ types platform 收窄、configDirOf 用 dirname、writeStatus 链式串行化、logLine stdout 包 try。**测试**：test/wecom-probe.ts（mock-WSS 9 检查，Bun.serve 的 fetch 必须 `server.upgrade(req)` 否则 WS 握手根本不成立——首版探针 8/9 假红即此）+ webChat.test 补英文网卡与 webUrlCandidates 出货断言（注入网卡表参数）。
3. 位置：src/utils/imRemote/{format,daemon,types,config,autoMode}.ts、adapters/{wecom,webChat,telegram}.ts、webPage.ts、print.ts、REPL.tsx；autoMode.test.ts（新）、webChat.test.ts、test/wecom-probe.ts（新）。单测 36 全绿 + wecom 探针 9/9 + e2e-im-remote 28 断言全绿 + tsc 干净。与 app 0.2.94（development_log 0.2.94 条）同轮联调。

## 十四、2026-10-01 会话关闭锁 + 跨网络扫码深链（随 app 0.2.95，CLI 2.1.269→2.1.270）

### 58. OSC 7770 turn:start 补回合起点；daemon 远程占用绑定 + Bot 深链
1. 问题：① app 壳要「运行中的会话不能被 ✕ 关闭打断」，但 TUI 只有回合结束标记（turn:done/aborted），无起点信号，壳侧 busy 状态机无从建立；② 远程 prompt 送达的会话被用户关标签即断链（daemon 只知 active=最近接入者，无「占用」概念，App 无从锁）；③ app 扫码网页频道硬绑局域网（0.0.0.0 裸 HTTP + 网卡地址），出差/手机流量完全不可用，而 daemon 三频道（TG 长轮询/飞书长连接/企微 WSS）全是出站连接——跨网络能力其实就在 bot 通道里。
2. 解决：① shellTurnMarker 新增 `emitShellTurnStart()`（同 env 门控 DOGE_APP_TURN_MARKER），REPL 在 query try 首行发射（onBeforeQueryCallback 早退 return 也经 finally 配对 done——勿挪到 try 外，排队路径在 try 前 return 不该发）；② daemon 新增 boundSessionId：routePrompt 成功送达即绑定（flushHeldPrompt 同）、set_active 空串=仅解除占用不动路由 / 非空=钉路由+占用、会话消失的顺延清空收敛 `demoteGoneSessions()`（socket close/bye/探活收割三处共用——勿复制顺延逻辑）；status 帧/状态文件新增 bound + bot 块，broadcastSessions 连带刷 status（会话集变化必牵动快照）；③ 跨网络深链纯函数 `buildBotDeepLink(platform, {botUsername, appId, botLink, pairCode})`：Telegram=`https://t.me/<getMe用户名>?start=<配对码>`（适配器 start 时缓存 getMe 的 username/first_name；parseImCommand 把 `/start <6位码>` 归一成 pair、裸 /start 回 help——Telegram 扫码点 START 的真实形态）、飞书=官方 applink `applink.feishu.cn/client/chat/open?appId=`（扫码直开机器人会话，手发 /pair）、企微=配置项 wecom.botLink（用户从企微客户端「智能机器人→分享」复制的永久链接；config.ts 归一只收可 `new URL()` 解析的 http(s)——官方不提供由 botId 推导深链，勿尝试）；wecom botLink 归一化注意整对象替换语义（留空即清除）。
3. 位置：src/utils/shellTurnMarker.ts、src/screens/REPL.tsx（try 首行）、src/utils/imRemote/{daemon,format,config,types}.ts、adapters/telegram.ts（getMe 缓存）；format.test.ts（/start 归一 + buildBotDeepLink 三平台 8 断言）、config.test.ts（botLink URL 门）。与 app 0.2.95（development_log 0.2.95 条）同轮联调，app 侧 E2E verify-im-remote R6c/R7b/R13e–g 全绿。

### 59. daemon 启动自动铸配对码（随 app 0.2.96，CLI 2.1.271）
1. 问题：app 扫码卡的跨网络二维码（Telegram start=<配对码>）依赖配对码，而码只在用户手动点「生成配对码」后才存在——刚开频道时深链退化成裸 t.me/<bot>（扫码点 START 只能得到 help），「扫一下即连」体验断裂。
2. 解决：run() 频道起来后、心跳前，custom 频道在跑且 currentPairCode() 为空/过期时自动 regeneratePairCode()（走既有持久化+广播路径）。配套（app 侧）：regenImRemotePair 必须「等码变化」再返回——盘上常态有码后，见码就返会把旧码当新码秒回（daemon 尚未重铸），调用方拿即将作废的码去配对必败。
3. 位置：src/utils/imRemote/daemon.ts（run() 自动铸码）；验证随 app 0.2.96 verify-im-remote R5b/R6/R7b。

### 60. 多平台并发：凭据齐备即启动，platform 降级为 UI 提示（随 app 0.2.97，CLI 2.1.272）
1. 问题：daemon 的自定义 bot 频道是 platform 单选——config.platform 决定唯一 adapter，配了飞书就只有飞书码，Telegram/企微凭据即便在盘也不启动；app 扫码卡「跨网络」因此只呈现单一平台，与「三个 IM 都能扫」的产品预期不符。
2. 解决：config.ts 新增 `selectBotPlatforms(c)`（telegramReady/feishuReady/wecomReady 逐平台判定，TG→飞书→企微稳定序；飞书就绪去掉 chatId 强制——适配器对空 chatId 走首条入站自动绑定），`imRemoteConfigReady` = 任一平台就绪；daemon buildChannels 逐平台建频道（channel id=平台名），原 `customChannel` 单取改为 `botChannels()/runningAdapter(id)`；onImMessage 的 Telegram 专调（answerCallback/observeChatId）改按 id='telegram' 取 adapter；status 帧与状态文件 `bot` 单块 → `bots` 数组（botsChannelInfo：每在跑平台一条 {platform,botName,deepLink,pairCode,pairExpires,paired}，企微缺 botLink 仍出现供 UI 补填）；启动自动铸码条件改「任一 bot 频道在跑」。
3. 位置：src/utils/imRemote/{config,daemon,types}.ts；config.test.ts（selectBotPlatforms 多选/顺序/飞书免 chatId，+2 测）。验证随 app 0.2.97 verify-im-remote R6d（TG+飞书双码并列）。

### 61. web 频道 IPv6 双栈 + 公网直连候选（随 app 0.2.98，CLI 2.1.273）
1. 问题：跨网络接入此前只靠 IM 机器人中转（一次性配置）；用户预期「和同网一致零配置」。国内手机流量网普遍 IPv6-native、家用宽带可开 v6——电脑有全局 v6 时手机其实可以直连，不必中转。
2. 解决：webChat 监听 0.0.0.0→::（绑定失败回退，v4-mapped 兼容回环/局域网）；新增 publicV6UrlCandidates(port, token, nics) 纯函数——只收全局单播（首 hextet & 0xe000 === 0x2000，天然排除 fe80 链路本地与 fd/fc ULA），虚拟网卡名沿用 VIRTUAL_NIC_RE；URL 用方括号字面量 http://[v6]:port/#t=。daemon status 帧/状态文件新增 webUrl6（web 频道在跑且有全局 v6 才有值）。
3. 位置：src/utils/imRemote/adapters/webChat.ts、daemon.ts、types.ts；webChat.test.ts（全局入选/本地排除/无 v6 空数组 +2 测）。验证随 app 0.2.98 verify-im-remote R11v6（条件断言）。

### 62. 配对按平台隔离：每平台一份码 + 授权表分键 + 广播只发已配对平台 + 出站绑定持久化（随 app 0.2.99，CLI 2.1.274）
1. 问题：配对态全局单份——`pair` 一份码、`allowedUsers` 一份授权表；配了企微+飞书时扫码卡两平台显示同一个码、任一平台配对后全局放行（用户实测「微信和飞书都收到消息」）；且 broadcastIm 对所有在跑频道无条件群发，与是否配对无关。附带缺陷：飞书 takeInbound / 企微 handleCallback 在配对门之前就把首个入站者绑为出站会话（陌生人一条消息即抢占通知通道，Telegram 则一直是门后 observeChatId）；适配器绑定纯内存态，daemon 每次重启（改任一频道键的设置保存都会重启）即丢，重启后广播静默黑洞到该平台来下一条入站。
2. 解决：① config 改 `pairs?: Partial<Record<ImPlatform, ImRemotePairState>>` + `allowedUsersByPlatform` + `outboundChats`（daemon 属主）；normalize 迁移 legacy 键——单平台凭据时 allowedUsers 无损归到该平台、多平台作废（属主不可判）、legacy 全局 pair 恒作废（启动即按平台重铸）；新键优先。② 自动铸码/regen（monitor 帧带 platform，缺省重铸全部在跑平台）/消耗均按平台各管各的；/pair 按来源平台验码（跨平台码互斥）。③ broadcastIm 过滤：零配对用户的 bot 平台不发（web 令牌门恒放行）。④ ImAdapter 新增 `bindChat(chatId,{force}): boolean`（配置 chatId 恒最高优先、常规 first-wins、配对 force 接管、返回是否变更）；daemon `applyChatBinding` 统一门后绑定，变更持久化 outboundChats、启动 restoreChatBindings 恢复——重启不再黑洞。⑤ persistDaemonKeys 三键 patch + 串行队列（每调用独立兑现、队列尾巴自愈），配对路径 force 绑定与码消耗/授权增员合并一次持久化。⑥ status 帧顶层 pairCode/allowedUsers 降级占位（null/并集，无消费方），真实数据在 bots[] 每平台条目。平台前置查证：企微官方要求 aibot_send_msg 前用户须先发过消息、Telegram bot 不能主动发起会话——配对消息本身即满足，force 绑定合规。
3. 位置：src/utils/imRemote/{types,config,format,daemon}.ts、adapters/{telegram,feishu,wecom}.ts；config.test.ts（迁移三分支/pairs 归一/outboundChats，+3 测）、format.test.ts（isPairCodeValid 改收平台配对态）。验证随 app 0.2.99 verify-im-remote R6d2–R6d4/R7c 系/R11b2（码不同/未配对零推送/按平台消耗/跨平台互斥/配对后恢复接收）。

### 63. 远程团队意图绕开本地入口（随 app 0.2.100，CLI 2.1.275）
1. 问题：TUI 的远程 onPrompt 直接 enqueue，未执行本地自然语言团队转投；headless 又在命令展开前已组装工具池，因此远程请求即使展开 /agent-teams，也可能没有 TeamCreate 等工具。已有团队会话再次请求协作也应逐次展开。带前导空格的显式命令无法通过 startsWith('/') 分派。
2. 解决：两入口共用 prepareRemotePrompt，在 enqueue 前识别意图、启用会话团队工具并转为 /agent-teams；显式命令返回 trimmed，普通输入与排除项保留原文。headless user 帧继续使用原始文本与原 UUID，避免桌面气泡显示展开后的内部提示。单测先红后绿 9 项，全量 src 测试 537/537（独立配置目录、测试密钥 sk-user）；App 远程黑盒验证普通/首次/重复/TUI/headless/显式空格命令与原文气泡。
3. 位置：src/utils/imRemote/prompt.ts、prompt.test.ts、src/cli/print.ts、src/screens/REPL.tsx；App tools/verify-im-remote.mjs R16/R17。两仓 feature/remote-teams-guides；重编内置 CLI 时基线为 3174a6a，本轮已获用户授权提交、合并 main 并删除已合并分支；App 提交说明记录最终 CLI commit。安装版远程 85/85、对话 246/246、设置 60/60、启动冒烟 5/5；test/{feishu-ws-probe,wecom-probe}.ts 补旧探针遗漏的授权后 bindChat，增加未授权零出站检查，飞书 25/25、企微 11/11（适配器生产代码未改）。

## 十五、2026-10-02 命令解释器选择（/shell，CLI 2.1.276）

### 64. 可选 Pwsh 作为模型 shell 工具 + 无 git-bash 机器可启动
1. 问题：Windows 上模型只有 BashTool，必须有 git-bash——`findGitBashPath()` 找不到就 `process.exit(1)`，只装 pwsh 的机器根本无法启动；已有 PowerShellTool 半成品只被 env 门控且与 Bash 同时进池；系统提示词恒写「use Unix shell syntax」，pwsh 生效时文案错误。
2. 解决：① `windowsPaths.probeGitBashPath()` 非退出式探测（env → HKLM/HKCU 注册表 InstallPath → where.exe git 推导 → Program Files/LocalAppData/scoop 常见目录，memoize 按 env 值分键），`setShellIfWindows()` 找到照旧、找不到且 `defaultShell: 'powershell'` 时正常返回不退出（bash 默认保持原报错退出，findGitBashPath 语义不动）；bash hook 在无 git-bash 时改抛普通 hook 错误（对称于 powershell 分支既有 throw）。② `shellToolUtils` 门控放开：`defaultShell==='powershell'` 即启用（缺 pwsh 由工具内既有哨兵优雅兜底），env 门原样保留；新增 `resolveActiveShellTool()`（+纯函数 `resolveActiveShellToolFor`/`isPowerShellToolEnabledFor`）作为 tools.ts 工具池排他、prompts.ts `getShellInfoLine`、`processBashCommand` `!` 路由的单一解析点——同一时刻模型只拿 Bash 或 PowerShell 之一，env=1 未选 pwsh 不再双给；`toolExecution` 对移除后的旧 `Bash` tool_use 走既有「No such tool available」优雅路径。③ 新增 `/shell` 命令（无参弹 Select 选择器带可用性描述、`/shell bash|pwsh|status` 直参），写 `userSettings.defaultShell`，下一回合生效（settings 缓存随 updateSettingsForSource 失效、工具池每回合重组装）。④ pwsh 执行加固：`buildPowerShellArgs` 加 `-ExecutionPolicy Bypass`（`CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY` 退出），`buildExecCommand` 同行前置 UTF-8 双通道前导（修 CP936/GBK 控制台乱码，错误行号不变，沙箱 EncodedCommand 天然覆盖）。⑤ PowerShellTool `userFacingName` 改 'Pwsh'（线名 POWERSHELL_TOOL_NAME 不动）。**审查修复**：切换后清系统提示词 section 缓存（`clearSystemPromptSections()`——env_info_simple 原来只在 /clear、/compact、worktree 进出时清，否则 Shell: 行陈旧到会话结束）；非 Windows 直参 `/shell pwsh` 拒绝写盘；写盘后回读生效值，被更高优先级源（project/local/--settings）覆盖时提示；UTF-8 前导抽成导出常量 `POWERSHELL_UTF8_PREAMBLE` 复用到 hooks 的 pwsh spawn（原只覆盖 buildExecCommand，hook 输出在 PS 5.1+GBK 下会乱码）。
3. 位置：src/utils/windowsPaths.ts(+windowsPaths.test.ts)、src/utils/shell/{shellToolUtils,shellToolUtils.test,powershellProvider,powershellProvider.test,powershellDetection,resolveDefaultShell}.ts、src/tools.ts、src/utils/hooks.ts、src/constants/prompts.ts、src/commands/shell/{index.ts,shell.tsx,args.ts,args.test.ts}、src/commands.ts、src/utils/processUserInput/processBashCommand.tsx、src/tools/PowerShellTool/PowerShellTool.tsx、src/utils/settings/types.ts；test/shell-select-smoke.ts（CLAUDE_CONFIG_DIR 沙箱全链冒烟：status/set/池互换/env=1 不双给，14 断言）。bun test 新增 21/21 绿。

## 十六、2026-10-02 shell 会话级隔离 + Auto 模式零提问（CLI 2.1.278）

### 65. shell 会话级隔离：磁盘 defaultShell 变更不再窜改在跑会话（随 app 0.2.105）
1. 问题：defaultShell 经 settings 缓存（changeDetector 失效）全局生效——磁盘 settings.json 一变，所有并发会话下一回合的 shell 工具一起被换；需求是「已有 bash/pwsh 会话保持各自解释器，切换只影响发起切换的会话与新会话」，且 `/shell` 对本会话要立即生效。
2. 解决：新增 `src/utils/shell/sessionShell.ts` 进程内存覆盖层——`initSessionShellSnapshot()`（幂等，首调胜出）在 `entrypoints/init.ts` 的 `init()` 内（commander preAction，TUI 与 headless `-p` 同一入口）把磁盘有效值冻结为会话值；`resolveDefaultShell()` 改三级：会话覆盖 → settings.defaultShell → 'bash'（SDK 入口不走 init 时 getSessionShell 为 null 回落旧行为）；`/shell` 的 `applyShellSelection` 写盘成功后 `setSessionShell(shell)` 立即生效（clearSystemPromptSections 保留），`/shell status` 同显会话值与磁盘值并说明「新会话将以磁盘值启动」。测试 sessionShell.test.ts（8 例：三级解析/快照冻结幂等/磁盘变更不窜会话/新进程拾取新值/门组合）+ powershellDetection.test.ts（3 例：pwsh→powershell 回退链）。
3. 位置：src/utils/shell/{sessionShell.ts,sessionShell.test.ts,resolveDefaultShell.ts,powershellDetection.test.ts}、src/entrypoints/init.ts、src/commands/shell/shell.tsx。bun test src/utils/shell/ 23 pass、src/commands/shell/ 6 pass。

### 66. Auto（bypassPermissions）会话不再向用户提任何问题 + plan 插曲全自动
1. 问题：/auto（bypassPermissions）会话仍会弹提问——整工具 ask 规则（1b）、requiresUserInteraction 工具（1e：AskUserQuestion 提问卡、ExitPlanMode 批准卡）、内容级 ask 规则（1f）、危险路径 safetyCheck（1g）都在 bypass 判定（2a）之前拦截；且 isAutoBypassActive 把「从 Auto 进 plan」当作全放行，模型在 plan 插曲里直接写文件而不是做计划。需求：Auto 下一切请求自动允许；需要计划时模型进 plan 真正做计划，ExitPlanMode 自动批准回 Auto，全程零提问。
2. 解决：① `autoBypass.ts` 新增两个单点判定：`isZeroAskAutoActive`（mode==='bypassPermissions' 且 killswitch 未禁）与 `isZeroAskPlanInterlude`（mode==='plan' 且 prePlanMode==='bypassPermissions' 且非旗标启动会话且 killswitch 未禁）；`isAutoBypassActive` 移除 plan+prePlanMode==='bypassPermissions' 分支（isBypassPermissionsModeAvailable 旗标启动语义不动）。② `hasPermissionsToUseToolInner`：1a/1d 显式 deny 保持拒绝；零提问下 1b/1e/1f/1g 的 ask 不再拦截、落入 2a 既有 bypass allow（updatedInput 随 allow 透传到工具入参）；plan 插曲下 ExitPlanMode 在 1d 之后直接 allow（call() 恢复 prePlanMode='bypassPermissions' 回 Auto），其余 ask/passthrough 一律 deny 并附「先写完计划再 ExitPlanMode」引导文案（planInterludeDeny）。③ AskUserQuestionTool.checkPermissions 在零提问下返回 allow 且 updatedInput 补 `buildAutoAnswers`（每题取第一个选项，多选取第一项，无选项给「由 AI 全权决定」，模型预填 answers 优先）。④ 新增 `currentPermissionMode.ts` 会话级模式镜像：initializeToolPermissionContext 初始化 + onChangeAppState 模式差分同步（单点覆盖全部切换路径）；prompts.ts 注册 uncached 段 `zero_ask_auto`（DANGEROUS_uncachedSystemPromptSection——模式切换即翻转），bypass 下引导模型「需要规划就 EnterPlanMode、完成后 ExitPlanMode 自动继续」。⑤ 边界不动：Shift+Tab 轮转、/auto、/plan、headless set_permission_mode、dontAsk、手动进 plan（prePlanMode≠bypass 照常提问）、IM 远程 remoteAutoTargetMode 强切 bypass 后自然继承零提问。
3. 位置：src/utils/permissions/{autoBypass,permissions,currentPermissionMode}.ts、src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx、src/state/onChangeAppState.ts、src/utils/permissions/permissionSetup.ts、src/constants/prompts.ts；测试 src/utils/permissions/{autoBypass.test,permissions.autoBypass.test}.ts、src/tools/AskUserQuestionTool/AskUserQuestionTool.test.ts（CLAUDE_CONFIG_DIR 沙箱覆盖 killswitch），bun test 三目录全绿（49 断言级用例）。

## 十七、2026-10-04 声明式工作流首发（CLI 2.1.282，随 app 0.2.112）

### 68. /workflows 声明式工作流：文件即命令、后台伞任务、跨 API 子进程步骤
1. 问题：上游 WORKFLOW_SCRIPTS 特性在本 fork 只剩空壳（WorkflowTool/createWorkflowCommand/LocalWorkflowTask 全 stub、feature 宏恒关、commands/workflows 目录已删），用户无法用文件定义多步骤任务编排；agent-teams 只能模型自主转投、进度非确定性；跨 provider 的模型编排完全没有通道。需求：MD 文件定义步骤（提示词/子代理/模型/跨 API profile），斜杠命令确定性直跑，TUI 与 headless 双端可用，App 侧可视化进度与管理。
2. 解决：① 格式与解析 `tools/WorkflowTool/spec.ts`（纯函数）：MD frontmatter 定义 name/description/argument-hint/inputs[]（string/number/boolean/select + 默认/必填/options）/steps[]（id/title/agent/model/profile/continue-on-error/timeout/prompt），上限 20 步；`parseWorkflowArgs` 位置参数 + key=value 覆盖 + 类型校验；`interpolate` 纯代换 `{{args.x}}`/`{{steps.id.output|status}}`（未知引用保留原文便于排查）。② 引擎 `engine.ts`：`startWorkflowTask` 注册 `local_workflow` 伞任务立即返回（print.ts:2270 既有后台扣留检查令 headless 按消息冲刷 task_* 事件、扣住 result 等工作流收尾）；进程内步骤 = registerAsyncAgent + runAsyncAgentLifecycle 包 runAgent（isAsync、transcriptSubdir=workflows/<name> 归组转录）——task_started/progress/notification、P2 模型徽章、TUI 后台任务面板全部白拿；跨 API 步骤（profile:）= `findWorkflowProfile`（providerName 优先、model 兜底，双源聚合同 P6）→ 子进程 `doge -p --output-format stream-json --model --permission-mode`，env 用新抽的 `modelProfileEnvPatch`（customApiStorage 导出纯函数，applyModelProfile 同源改用它——单一映射源）打补丁、父进程 env 不动；子进程步骤补发 raw headless task_started/progress/task_notification（wfsub_ 前缀合成 id；TUI 内不可见为 MVP 已知限制）。失败策略：首败即停 + 余步 skipped（continue-on-error 例外）；伞 kill（LocalWorkflowTask:kill / 任务面板）经 parentAbortController 级联中止在跑步骤。收尾：摘要 appendTaskOutput + framework.enqueueTaskNotification（改为导出）发标准 <task-notification> XML 回流对话，主模型续turn汇报。③ 命令层 `createWorkflowCommand.ts`：loadWorkflowSpecs 复用 markdownConfigLoader（'workflows' 目录枚举本就在位；user 胜 project 同名）；每文件生成 local 型命令（supportsNonInteractive、kind:'workflow'），call 内参数/agent/profile 快速校验后启动；commands.ts 去 feature 门直连 + 内置命令名冲突过滤（工作流不得遮蔽 /compact 等）；print.ts initialize 对 kind:'workflow' 的 local 命令补 source:'workflow'（App 面板徽标/清单数据源）。④ `/workflows` 命令（commands/workflows/）：清单（步骤链+scope+路径）+ `/workflows:new <name>` 模板落 ~/.doge/workflows/；删除走文件/App。⑤ processSlashCommand 'local' 分支补 canUseTool 合并（对齐 local-jsx 分支——工作流进程内步骤的权限审批经会话管线，App 审批卡照常弹）。
3. 位置：src/tools/WorkflowTool/{spec.ts,spec.test.ts,engine.ts,createWorkflowCommand.ts}、src/commands/workflows/index.ts、src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts、src/tasks.ts、src/commands.ts、src/cli/print.ts、src/utils/task/framework.ts（enqueueTaskNotification 导出）、src/utils/customApiStorage.ts（modelProfileEnvPatch + applyModelProfile 重构）、src/utils/customApiStorage.env.test.ts、src/utils/processUserInput/processSlashCommand.tsx。bun test 新增 17 例全绿（spec 13 + envPatch 4），provider-storage 27/27、apiKeyExclusivity 12/12、agent 9/9 回归绿。App 侧配套（设置页两栏位/徽标/E2E）见 app 仓 development_log 0.2.112。

## 十八、2026-10-04 Workflows / Agents 执行边界（CLI 2.1.286，随 App 0.2.117）

### 69. 工作流真实代理身份、同会话转录、逐步反馈与完整取消
1. 问题：进程内步骤注册 ID 与 runAgent ID / controller 不同；跨 API 原始 alias 与实际请求不一致、未应用 agent 定义且落成独立主会话。步骤完成通知提前唤醒主模型、长换行参数丢失、停止未覆盖空闲工作流。审查确认 API 错误可以正常 yield 后 return，三条代理路径不能只靠异常判定成功；重试转存需回退父链，转后台需明确改变消息来源，嵌套类型限制不能丢掉。
2. 解决：引擎确定模型与身份后统一注册执行；拆分 headlessStep 传输与 stepTranscript 转存，provider 模型映射、agent 参数、stdin 大文本、--no-session-persistence、隔离子任务 ID / 工具 ID / 转录 ID；重试消息撤回保留 UUID / API ID 兼容并修复父链、失败用量回流父记录。工作流步骤及其嵌套代理仅发 SDK 通知，逐步反馈单独显示和持久化，最终伞通知携带实际输出；同 API 等待所属后台代理。中断 / end_session / 空闲 Esc 共享停止工作流，Windows taskkill 整树、POSIX ps 后代快照先杀子进程再杀组。单字符串参数完整保留，多字段支持引号和 named 输入；API 终态、Agent(type) 范围与后台切换分别抽共享 helper。实际 mock provider 全链 43 项通过，包括断流重试、失败 / 超时 / 继续、同步 API 失败、受限嵌套和 120 秒自动转后台；全套按文件隔离验证，鉴权依赖测试用虚拟 key（单进程全量有既有共享状态污染）。Windows 进程回收实测；POSIX 仅辅助解析测试。
3. 位置：src/tools/WorkflowTool/{engine,headlessStep,stepTranscript,spec}.ts 与相邻测试；src/tools/AgentTool/{runAgent,agentToolUtils,agentCompletion,agentScope,AgentTool}；src/tasks/Local{Agent,Workflow}Task、src/utils/{sessionStorage,processTree,slashCommandParsing,sdkEventQueue}、src/utils/task/framework、src/cli/print、src/hooks/useCancelRequest。App 仓 tools/verify-workflow-cli.mjs / verify-workflow-app.mjs 共用隔离 fixture，安装验收见 App docs/workflow-agent-validation-2026-10-04.md。

## 演进注记（已剔除的失效记录去向）

- `/add-model`、`/remove-model` 命令及其表单类修复：命令已由 `/provider` 取代（provider 为中心重构，见 git 历史），`captureModelProfile` 已删除。
- 2026-06-30「tier 切换持久化修复」：档位持久化整体废弃，现行档位切换一律会话级、永不持久化（`src/utils/model/` 相关模块）。
- 「applyModelProfile 恢复/条件恢复 effort」两轮修复：最终定型为完全不采集不恢复（见第 22 条）。
- 「/model 切换时同步顶层凭据到磁盘」：现行 /model 默认会话级不写盘，固化走 `--save`。
- 旧 `listInstalled` 单脚本枚举（含 500 条目截断修复）：已被 installedApps.ts 五阶段并行枚举取代（见第 35 条）。
- `start_*.ps1` 启动脚本相关记录：脚本已删除（commit 67be696），配置改走 `/provider` 或 env。

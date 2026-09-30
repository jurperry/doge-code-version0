# development_logs.md — Doge Code 开发日志

> 2026-09-17 由 `debug_updates_1.md` ~ `debug_updates_7.md` 合并精简而成。每条固定三行：问题 / 解决 / 位置。已被后续架构演进取代的记录已剔除，去向见文末「演进注记」。

## 一、API 兼容与上下文

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

## 演进注记（已剔除的失效记录去向）

- `/add-model`、`/remove-model` 命令及其表单类修复：命令已由 `/provider` 取代（provider 为中心重构，见 git 历史），`captureModelProfile` 已删除。
- 2026-06-30「tier 切换持久化修复」：档位持久化整体废弃，现行档位切换一律会话级、永不持久化（`src/utils/model/` 相关模块）。
- 「applyModelProfile 恢复/条件恢复 effort」两轮修复：最终定型为完全不采集不恢复（见第 22 条）。
- 「/model 切换时同步顶层凭据到磁盘」：现行 /model 默认会话级不写盘，固化走 `--save`。
- 旧 `listInstalled` 单脚本枚举（含 500 条目截断修复）：已被 installedApps.ts 五阶段并行枚举取代（见第 35 条）。
- `start_*.ps1` 启动脚本相关记录：脚本已删除（commit 67be696），配置改走 `/provider` 或 env。

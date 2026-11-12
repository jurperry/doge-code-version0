# development_logs.md — Doge Code 开发日志

仅保留最近 10 条，每条三行：问题 / 解决 / 位置与验证。历史实现以 git 记录为准，测试统一遵守 [test_specification.md](test_specification.md)。

## 2026-11-12 全量测试跨文件状态污染与回归修复

1. 问题：全量测试出现 17 项失败，涉及重试、模型/OAuth、启动配置、任务通知、记忆路径和滚轮，单文件与组合结果不同。
2. 解决：逐项确认模块 mock、宿主 env、ALS/OAuthSession、global config/登录 Key/startup 缓存和记忆路径 memoize 污染；改用真实事件 tap、完整测试前后 reset、FD fixture 与 native/xterm.js 分支断言，未修改正常产品语义。
3. 位置：`tools/{modelTestIsolation,teammate-transcript-progress,model-oauth-source,model-runtime-context,model-startup-context,run-isolated-tests}.ts`、相关测试文件。连续两次裸 `bun test` 均 1070/0，隔离器 140 文件 1029/0，多轮 review 通过，产物全部清理。

## 2026-11-12 Windows Computer Use 可靠性、异常反馈与输入正确性修复

1. 问题：CU 直调丢失 `isError`/超时/取消，批次丢失部分进度与图像，Windows 误报输入成功；双/三击、组合键、Unicode、滚动、多屏、授权身份与剪贴板恢复存在缺口。
2. 解决：接入统一 MCP 生命周期与调用代际，保留结构化失败和顶层 sibling 图像；Windows 检查 PowerShell/Win32 错误及 PID/前台，修复输入原语、坐标几何、授权提示、剪贴板 stash/恢复和释放通道。
3. 位置：`packages/@ant/computer-use-mcp/src/`、`src/services/{mcp,tools}/`、`src/utils/computerUse/`、`tools/computer-use{,-input-fixture}-e2e.ts`。定向测试、只读截图与隔离 WinForms 实机均通过；不宣称混合 DPI 或所有应用兼容。

## 2026-11-12 Windows Computer Use Esc 生命周期修复（2.1.317）

1. 问题：Windows Esc hook 消息循环未执行、named pipe 调用错误，注册提前返回且 helper 退出泄漏；模型合成 Escape 和子代理锁所有权也会干扰中止。
2. 解决：安装可等待握手的原生 hook，以 generation/PID 隔离注册与连接，按 injected flag 忽略模型合成 Escape，后台子代理在加载原生模块前明确拒绝。
3. 位置：`src/utils/computerUse/{escHotkey,executor,wrapper}.tsx/ts`、`src/utils/computerUse/win32/escHook.ts`。helper 13/13、真实 CLI 3/3、AgentTool 2/2 通过；物理安全桌面未实测，named pipe 信号链已实测。

## 2026-10-31 App 长驻会话跨会话记忆链路与退出回收（2.1.315）

1. 问题：外部 Bun 构建移除记忆提取模块，App 回合结束无法提取；主回合 abort 与进程退出可能丢失在途记忆。
2. 解决：统一运行时门禁，App 以 `DOGE_HEADLESS_AUTO_MEMORY=1` 显式启用；禁用仍初始化 `MEMORY.md`，提取使用独立 AbortController 并在退出前 drain。
3. 位置：`src/cli/print.ts`、`src/query/stopHooks.ts`、`src/utils/backgroundHousekeeping.ts`、`src/memdir/`、`src/services/extractMemories/`。聚焦测试 4/4、逐文件 989 pass、独立复审通过。

## 2026-10-29 Windows 终端右键复制 TUI 选择文本乱码

1. 问题：中文 Windows 控制台代码页 936 下，TUI 选择文本经 `clip.exe` 复制出现中文和表情乱码，toast 还误称仅 OSC 52。
2. 解决：Windows 原生剪贴板改用 PowerShell UTF-8 stdin/stdout，串行化并跳过过期排队写入，失败暴露日志和超时；本地 Windows 归为 native。
3. 位置：`src/ink/termio/osc.ts`、`src/ink/termio/osc.test.ts`、`tools/verify-windows-clipboard.ts`。CP936 下 Unicode、多行、5.6 万字符及连续写入通过，逐文件 131 文件全绿。

## 2026-10-29 TUI 三区固定布局与可拖动历史滚动

1. 问题：欢迎导航、消息与底部输入共用渲染流，多步调用后布局错位；外部用户没有独立消息视口和可见滚动条。
2. 解决：默认 alternate-screen 三区布局，头部固定、短终端 compact、极短隐藏；消息区独立 ScrollBox/VirtualMessageList 和可拖拽滚动条，Ink 增加鼠标捕获分发。
3. 位置：`src/components/{FullscreenLayout,Messages,LogoHeader,ScrollBar}.tsx`、`src/screens/REPL.tsx`、`src/utils/fullscreen.ts`、`src/ink/`。专项 34 项、逐文件 130 文件 988 测试、CLI 与 worktree e2e 通过，已授权合并。

## 2026-10-27 Auto 仅在 Plan 中提问（2.1.314 / App 0.2.172）

1. 问题：Auto 执行和收尾允许五分钟人工询问，自动 Plan 却禁止讨论；队友问题沿用强制选择且切回 Auto 后未撤销。
2. 解决：Auto 执行禁止提问，自动 Plan 保留有界讨论；共享自动推荐、展示起钟、首赢清理和迟到回复隔离，ExitPlan 自动回 Auto，不伪造提交/合并同意。
3. 位置：`src/utils/permissions/`、`src/tools/{AskUserQuestionTool,EnterPlanModeTool}/`、`src/hooks/toolPermission/`、`src/cli/`、Auto 测试脚本。隔离 125 文件 954 测试、三协议与 IM/elicitation 验证通过。

## 2026-10-24 已停止用户提示的原位替换（2.1.313 / App 消息编辑配套）

1. 问题：headless 无法可靠区分纯人工停止与已有正文/工具的轮次，编辑后内存、磁盘和后续上下文可能分裂，重连还会加入合成哨兵。
2. 解决：新增 `get_user_message_edit_state` 与 `replace_user_message`，按真实 UUID、人工停止和 sticky activity 授权；编辑前原子提交转录，失败不追加执行，支持 checkpoint、工作流恢复和配置安全边界。
3. 位置：`src/utils/userMessageEdit*`、`src/sessionStorage*`、`src/messages.ts`、`src/tools/WorkflowTool/`、`src/QueryEngine.ts`、`src/entrypoints/sdk/`。聚焦 11 文件 71 测试、真实 stream-json 黑盒 28 项、全量 125 文件 948 pass。

## 2026-10-21 /clear 配置语义与模型显示一致性（2.1.312 / App 0.2.166）

1. 问题：切换 DeepSeek 后 `/model` 取消提示读取 GLM 基线；屏幕外欢迎区可能保留旧模型，clear 被误当全新会话。
2. 解决：取消提示使用有效会话模型，欢迎布局按模型/强度冻结，LogoHeader 按 conversationId 重建，clear 仅重置终端 UI；fresh/clear/reconnect 使用各自配置重放时机。
3. 位置：`src/commands/model/`、`src/components/{LogoV2,CondensedLogo,modelDisplay}.tsx`、`src/components/Messages.tsx`。真实组件用例通过，完整验证见邻仓对应 validation。

## 2026-10-21 Teams 续轮转录身份上报（2.1.311 / App 0.2.165）

1. 问题：队友每次接收新任务都创建 roundAgentId，SDK 却只报告固定任务 ID，App 侧栏继续读取首轮 sidechain，显示停滞。
2. 解决：`task_progress` 可携带实际 agent_id，保持任务 ID、独立转录和重试语义，宿主按任务汇集历轮转录。
3. 位置：`src/utils/swarm/inProcessRunner.ts`、`src/utils/task/sdkProgress.ts`、`src/utils/sdkEventQueue.ts`、`src/entrypoints/sdk/coreSchemas.ts`、`tools/teammate-transcript-progress.test.ts`。新增 SDK 进度测试及真实 App 两轮验证通过。

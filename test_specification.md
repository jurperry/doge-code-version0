# 测试规范：全量回归、环境隔离与常见陷阱

本文档规定 Doge Code 的测试执行方式。目标是：**每个失败都有归因和处置，不用“基线问题”“非本模块”跳过失败，不以修改正确断言或只跑隔离器来制造全绿。**

Computer Use 专项设计见 [computer_use.md](computer_use.md)。

## 一、提交前必须完成的验证

### 标准门禁

1. 相关定向单测通过。
2. 裸 `bun test` 全量通过。
3. `bun tools/run-isolated-tests.ts` 逐文件独立进程通过。
4. 相关 e2e / 实机验证通过（适用时；Computer Use 按第八节执行）。
5. `bun run version` 冒烟通过。
6. `git -c core.whitespace=cr-at-eol diff --check` 通过。
7. 本轮改动经过独立 code-review，Critical/Important 已闭环。
8. `test/`、临时沙箱、后台任务、fixture、日志和测试服务器全部清理。

`package.json` 没有统一的 `lint`、`test`、`build` 脚本，不要虚构命令。

### 常用命令

```powershell
# 定向测试
bun test <路径>

# 全量裸测试
bun test

# 每个测试文件一个独立进程
bun tools/run-isolated-tests.ts

# CLI 冒烟
bun run version

# 同步本地 file: 依赖（本地包源码变更后必须做）
bun install
```

裸测试验证共享进程中的真实交互；隔离器验证独立环境。两者是互补关系，**隔离器通过不能替代裸测试通过**。

对带 afterAll 状态 reset 的修改，至少连续运行两次裸 `bun test`，确认第二轮不被第一轮遗留状态影响。

## 二、目录与产物纪律

- `test/`：只放一次性临时脚本、沙箱、截图、日志和其他测试产物，结束全部删除，不纳入 git。
- `tools/`：可复用的 e2e、probe、repro、mock 和验证脚本，受 git 跟踪。
- 不得把临时测试脚本散落到其他目录。
- 向 C 盘或系统临时目录写入的测试数据，结束后必须清理；优先使用仓库 `test/` 沙箱。
- 即使测试的 afterAll 已执行，也要检查 `git status`：后台任务可能在清理后重新写入 metadata。
- `tools/run-isolated-tests.ts` 只向 stdout 输出结果，不生成 results JSON 或失败日志。历史遗留文件需要单独删除。

收尾时确认没有临时任务仍在运行。任务结束通知为 failed 不等于需要继续运行；真正需要停止的临时进程必须用 `TaskStop`，再用 `TaskOutput` 核实。

## 三、环境变量是最常见的污染源

测试启动时不能默认继承宿主环境。尤其检查并显式隔离：

| 变量 | 影响 |
|------|------|
| `CLAUDE_CONFIG_DIR` | 决定配置、凭证、锁和日志位置；每个测试文件必须指向独立沙箱 |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` | host-managed 会屏蔽磁盘 endpoint/profile，导致默认 `api.anthropic.com` |
| `DOGE_ACTIVE_MODEL_PROFILE` | 覆盖磁盘 endpoint 选择 |
| `ANTHROPIC_BASE_URL` | 覆盖存储的 endpoint |
| `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` | 改变 anthropic/openai/responses 路由 |
| `DOGE_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | 覆盖存储凭证并触发互斥逻辑 |
| `CLAUDE_CODE_OAUTH_TOKEN` / `..._FILE_DESCRIPTOR` | 改变 OAuth 来源 |
| `CLAUDE_CODE_UNATTENDED_RETRY` | 把 429 从 other/5 改为 infra/10，请求次数会从 6 变成 11 |
| `TERM_PROGRAM` | `vscode` 选择 xterm.js 输入与滚轮路径 |
| `ANTHROPIC_MODEL`、各 tier model env | 覆盖主模型和档位选择 |
| `CLAUDE_CODE_SIMPLE`、custom headers | 改变启动和请求行为 |

不要向日志输出真实 API key、OAuth token 或用户剪贴板内容。测试 key 必须明确是 fixture。

## 四、禁止无约束的全局模块 mock

`mock.module()` 可能影响同进程后续所有测试文件。典型后果：

- `withRetry` 的分类函数被替换成固定值；
- `sdkEventQueue` 只剩一个导出，导致其他文件 `setSdkEventTap` 缺失；
- `authFileDescriptor` 的固定 token 泄漏到 OAuth worker。

优先做法：

1. 使用真实模块和局部 fixture；
2. 使用真实 `setSdkEventTap` 收集事件，并在 finally 恢复；
3. 使用 bootstrap 的 FD 缓存 fixture，不 mock 整个模块；
4. 必须 mock 时保留完整导出并明确恢复，但仍要考虑文件加载顺序，不能把恢复当作万能保险。

真实 `setSdkEventTap` 不会取代非交互队列写入。测试进度事件时应设置并恢复交互态，避免 `drainSdkEvents()` 读到本测试遗留事件。

## 五、模型上下文与配置 reset

### 必须同时 reset 的状态

仅恢复 `process.env` 不够。模型测试还需要：

- `runtimeModelContext._resetModelRuntimeContextForTesting()`：重建 AsyncLocalStorage、OAuth WeakMap/lineage、agentEnvironment map；
- `managedEnv._resetManagedEnvForTesting()`：复位 `persistedProfileStartupComplete`、`restoredProfileEnv`、spawn env key 状态；
- `config._resetGlobalConfigForTesting()`：清 global config cache、lastReadFileStats 和测试配置对象；
- `getApiKeyFromConfigOrMacOSKeychain.cache.clear()`：清登录 Key memoize；
- `resetSettingsCache()`；
- `getGlobalClaudeFile.cache.clear()`；
- 清空当前沙箱的 customApiEndpoint/env/oauthAccount/primaryApiKey/model/profile 等配置。

这些 reset 只能用于测试，不能在正常生产路径调用。

### beforeEach 与 afterAll 都要处理

- beforeEach：指向新的沙箱并 reset，防止上一用例进入本用例；
- afterAll：最终 reset，防止本文件污染下一文件或下一轮裸测试；
- 随后恢复完整 env，不能只恢复四个认证变量。

同一用例中的 sibling-worker 断言之间不要 reset，因为该用例本身正在验证 lineage 共享。

### 配置合并要用 `undefined`

`saveGlobalConfig` 是合并更新：

```ts
// 正确：显式清除旧值
next.customApiEndpoint = undefined

// 错误：旧字段可能因合并而保留
// delete next.customApiEndpoint
```

`NODE_ENV=test` 与 production 的配置缓存不同，测试切换 NODE_ENV 后也必须 reset 对应缓存。

## 六、缓存与 memoize 陷阱

- `getAutoMemPath` 以 projectRoot 为 key，不包含 override；相关测试在 beforeEach 和恢复 env 后调用 `getAutoMemPath.cache.clear()`。
- `getGlobalClaudeFile` 会缓存 config 路径，切换 `CLAUDE_CONFIG_DIR` 后需要清理。
- `persistedProfileStartupComplete` 会阻止第二次模拟启动恢复，因此 startup 测试必须 reset。
- OAuth 内存 lineage 可能让旧 token 覆盖磁盘新 token；不要误以为是 secureStorage 文件缓存。
- `file:` 依赖在 `node_modules` 中可能是静态副本。修改 `packages/@ant/*` 后必须运行 `bun install`，否则直接单测通过但 CLI/e2e 仍执行旧代码。

如果新 config dir 下仍读到旧值，先检查缓存，再检查真实文件，不要直接改测试期望。

## 七、时间、异步和平台语义

- Bun 的 `spawnSync.timeoutMs` 在当前环境可能无效并返回空 stdout/退出码 0。同步 PowerShell 封装使用 Node `spawnSync.timeout` 并验证 `ETIMEDOUT`；异步封装使用显式 kill。
- 同步超时不能声称“未发送”，因为原生调用可能已经发生。结果未知时必须提示不要盲重试。
- 真实异步操作应使用 async runner 和 AbortSignal，不要用同步 sleep 伪造进度。
- 原生滚轮在第一次方向反转时会防抖，第一次不位移、第二次同向事件才滚动；xterm.js 可立即滚动。测试按 `isXtermJs()` 分支断言，不能写死一种行为。
- Windows 第三次点击可能报告 `1,2,1`；验证 down/up 次数、系统 click count 和业务结果时不能混为一谈。
- 测试中使用短 timer 验证生命周期即可，生产超时不应靠长时间等待“碰运气”。

## 八、Computer Use 专项测试规则

### 安全的实机测试

- 只读 e2e：`bun tools/computer-use-e2e.ts`，覆盖 ListTools、真实截图、save_to_disk、zoom、cursor 和锁释放。
- 隔离输入 e2e：`bun tools/computer-use-input-fixture-e2e.ts`，使用脚本自己创建、绑定并关闭的 WinForms fixture。
- 中文输入与批次 e2e：`bun tools/computer-use-win32-unicode-e2e.ts` 通过真实 `computer_batch` 执行原生 EDIT 中文输入和批次内截图，逐字核对控件内容并检查返回图像；`bun tools/computer-use-chromium-unicode-e2e.ts` 独立验证 Electron 输入框的中英文与长 Unicode 文本。
- UAC 与管理员助手：`bun test tools/computer-use-uac.test.ts src/utils/computerUse/win32/elevatedPowerShell.test.ts` 覆盖人工等待/超时、传输、取消、普通目标切回与强杀属主回收；`CU_FIXTURE_ELEVATED=1 bun tools/computer-use-input-fixture-e2e.ts` 使用真实管理员夹具，UAC 必须由用户处理。
- 可信宿主与高物理坐标：`bun tools/computer-use-host-target-e2e.ts` 使用真实不同 PID/exe 的内嵌窗口，验证进程树可信时可由宿主授权、外部进程嵌入不得继承权限；宿主置于主屏右下高物理坐标，防止 DPI 命中回归。
- 自动解绑与坐标代际：纯函数及 `mcpServer.test.ts` 覆盖新进程接管、后台绑定保留、当前输入拒绝、并发解绑只清一次、旧 revision 延迟截图不得覆盖新锚点；原生夹具实际启动第二进程验证旧绑定解除。
- 不得复用用户的记事本、浏览器、IDE、文档或其他已有窗口。
- 不得在测试中进行真实系统级破坏性操作、关闭用户应用或覆盖用户剪贴板。
- 测试窗口、临时图片、配置和进程必须清理。

隔离 fixture 当前覆盖：

- 绑定窗口 PrintWindow 与非黑图像素；
- 显式核验 fixture 为 DPI-unaware 且显示器 DPI > 96，截图画布/JPEG 尺寸一致且右下角无贴角黑边；
- 后台消息的实际客户区坐标与独立显示器 DPI 计算一致；
- 实时物理光标到绑定窗口局部坐标的回读；
- 最小化捕获的图像内容与窗口状态恢复；
- Unicode、中文、emoji、长文本 stdin；
- 组合键按下与释放；
- 双/三击与 Windows 点击序列；
- 中键、后台 mouse-down/up 通道；
- 四向滚动；
- `switch_display("auto")` 解除绑定、全屏捕获不额外枚举显示器、真实 `(0,0)` 移动与全局点击/DPI 映射；
- 无 HWND 的 mouse-down/up、拖拽、滚轮、Unicode、组合键、holdKey、只读剪贴板访问和完整 `computer_batch`；不得为验证全屏剪贴板而覆盖用户原文；
- 工具层用可控 Promise 覆盖活动输入/截图与换目标互斥、open 部分失败清锚点、宿主清理异常后计数恢复，以及 shell/exe 双向 allow/deny 反例；
- 原生 `QueryFullProcessImageName` 当前进程路径读取、注册表 GUID 与运行 exe 并存时完整路径授权和打开仍选择真实 exe；本地 portable exe 不依赖枚举缓存且不提升原应用 tier。

### 不能只验证“有结果”

- `Clicked`/`Typed` 不代表应用生效，必须检查 UI 状态或目标内容；
- 截图有 image block 不代表截图正确，需检查尺寸、坐标、必要时像素；
- `cursor_position` 的数值形状只是冒烟信号；必须用独立 `GetCursorPos + GetWindowRect` 对照实时位置，绑定窗口时验证局部坐标，不能接受缓存的最近目标值。
- down/up 对数正确不代表双击/三击被系统识别，需检查系统点击序列；
- 测试某个输入通道时，不能拿另一个通道的 happy path 作为证明。

## 九、失败处理流程

每个失败按以下顺序处理：

1. **单文件复现**：是独立失败还是组合失败？
2. **最小污染组合复现**：加入可能的 mock/env/cache 来源，确认污染路径。
3. **记录初始状态**：config dir、相关 env、token/cache、调用顺序，不使用秘密值。
4. **判断类型**：
   - 真实产品 bug：修实现并加回归；
   - 测试隔离 bug：修 mock/env/cache/生命周期；
   - 测试期望错误：按现有产品契约修测试，但不能借它掩盖实现 bug。
5. **单文件与组合复验**。
6. **裸全量 + 隔离器 + 相关 e2e（适用时）+ 版本冒烟 + 独立 review**。

禁止：

- 把失败一律称为“基线问题”；
- 修改正确断言来匹配当前错误行为；
- 用 skip、删除用例或减少实质覆盖求绿；
- 只跑隔离器后宣称无跨文件污染；
- 用新 API key 绕过本应由 storage 自愈的测试；
- 把未知副作用写成“未发生”。

## 十、开发、提交与文档

- 新开发从基线新开功能分支，不直接在 main 开发。
- 提交前检查所有改动归属，不混入其他未授权修改。
- 全量测试与独立 review 通过后，按用户明确授权提交、合并、删除分支。
- 合并后再次运行 `bun run version`，必要时做相关冒烟。
- 保留可复用测试脚本在 `tools/`，一次性脚本和产物删除。
- 文档记录真实结果和限制，不写“坐标完全准确”“所有应用兼容”“全部已验证”等无法证明的绝对结论。

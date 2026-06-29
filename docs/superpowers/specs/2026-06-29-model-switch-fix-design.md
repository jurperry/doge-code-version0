# 模型切换错位修复 — 设计文档

- **日期**：2026-06-29
- **分支**：`feat/model-switch-fix`（不合并入 main）
- **范围**：仅修复 `/model` 切换在 ModelProfile（兜底主模型）与 Opus/Sonnet/Haiku tier 之间产生的"状态栏 ≠ 实际请求模型"错位；`/clear` 经用户验证已工作，不在本次修复范围。

---

## 背景

用户报告：在 deepseek、qwen、Opus/Sonnet/Haiku/Default 之间切换时，TUI 状态栏（顶部"Claude Code"那一行）显示的模型名与 `/model` 命令报告的当前模型不一致。复现典型：

```
切到 deepseek 的 Haiku → 切到 Default → 切到 qwen
状态栏：qwen3.7-max (1M Context) with high effort
/model：Set model to qwen3.6-flash
```

代码探查后定位三层根因：

1. **状态栏与 API 客户端的解析路径不同**：`useMainLoopModel()` 走 `parseUserSpecifiedModel` 后即返回，没有再过 `getRuntimeMainLoopModel`；而 API 客户端走完整路径——两者在 plan mode、200k token 等条件下产生差异。
2. **`useMainLoopModel()` fallback 链含 `customApiStorage.model`**：持久化层写入有延迟，状态栏读到旧值。
3. **切换 ModelProfile 时 `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL` 等 env var 未被清理**：当新 profile 不覆盖某个 tier 字段时，旧 profile 的值在 `process.env` 中残留，导致 `getDefaultHaikuModel()` 等 alias 解析指向跨 profile 的错误值。

`.credentials.json` 审计：ModelProfile 数组完整存在 `~/.doge/.credentials.json` 的 `customApiEndpoint.modelProfiles[]` 中（注意是 `credentials` 复数；不存在 `.credential.json` 单数文件）。`model/provider/baseURL/apiKey/authTokenType` 切换时同步三文件；`contextWindow / tier models / capabilities / disable 开关`仅写 `process.env`，由 modelProfiles[] 在下次启动重建——这是设计如此，不在本次修复范围。

---

## §1 架构与不变量

### 新的不变量（修复后必须恒成立）

1. **状态栏一致性**：状态栏渲染的模型名 ≡ 下一次 API 请求会发往的 model ID。`useMainLoopModel()` 与 API 客户端的解析路径必须收敛到同一函数（`parseUserSpecifiedModel + getRuntimeMainLoopModel`）。

2. **兜底切换的原子事务**：切换 ModelProfile 必须按事务顺序执行——
   - **a. 显式清理** 一组由 profile 管控的 env var **白名单**（不依赖 `applyModelProfile` 内部条件写入）：
     - `ANTHROPIC_DEFAULT_OPUS_MODEL`
     - `ANTHROPIC_DEFAULT_SONNET_MODEL`
     - `ANTHROPIC_DEFAULT_HAIKU_MODEL`
     - `CLAUDE_CODE_SUBAGENT_MODEL`
     - `ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES`
     - `ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES`
     - `CLAUDE_CODE_MODEL_CONTEXT_WINDOW`
     - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
     - `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK`
   - **b. 应用** 新 profile（`applyModelProfile`）→ env vars。
   - **c. 持久化** model/provider/baseURL/apiKey/authTokenType 三处（`syncModelConfigToDisk` 现有行为，无需改）。
   - **d. 重置 AppState**：`mainLoopModel = newProfile.model`（非 alias）、`mainLoopModelForSession = null`、触发 onChangeAppState 广播。
   - 失败时回滚到事务前的 env 快照。

3. **Tier 切换的纯净性**：切到 `'opus' | 'sonnet' | 'haiku'` alias 时，`getDefaultXxxModel()` 解析所读 env var 必须**只**来自当前 profile（由不变量 2.a 保证），不再有跨 profile 残留。

4. **EffortLevel 不被兜底切换覆盖**：`CLAUDE_CODE_EFFORT_LEVEL` 保留为独立运行时偏好（与现有设计一致）。

5. **`.credentials.json` 是 ModelProfile 的单一源头**：所有事务后状态都可由该文件 + AppState 重建；不引入新落盘文件。

---

## §2 受影响的组件与改动清单

### 读侧 — 状态栏 → 单一解析路径

| 文件 | 行 | 动作 |
|---|---|---|
| `src/hooks/useMainLoopModel.ts` | 14-36 | **修改**：fallback 链去掉 `readCustomApiStorage().model`；返回值统一经 `getRuntimeMainLoopModel` 处理。需要接收 `permissionMode`、`exceeds200kTokens` 输入（由调用方传入或 hook 内部从已知 store 取）。 |
| `src/components/StatusLine.tsx` | 39-43, 155, 314-315 | **修改**：合并双重解析为单调用；显示文本继续走 `buildStatusLineCommandInput`。 |

### 写侧 — `/model` 命令成为事务入口

| 文件 | 行 | 动作 |
|---|---|---|
| `src/commands/model/model.tsx` | 25-56 | `syncModelConfigToDisk` 核心**不动**，被新事务函数包裹。 |
| `src/commands/model/model.tsx` | 87-184, 301-361 | **修改**：拆为两条路径——P1 切 profile → `switchModelProfileAtomic`；P2 切 alias/裸字符串 → `switchTier`。删除现有"可选清 tier env var"的临时逻辑。 |
| `src/state/onChangeAppState.ts` | 94-112 | **微调**：mainLoopModel 变化时除现有动作外，广播 `modelChanged` signal（兜底信号，正确性不依赖）。 |

### 事务工具（新增）

| 文件 | 动作 |
|---|---|
| `src/utils/model/profileEnvKeys.ts` | **新增**：导出 `PROFILE_MANAGED_ENV_KEYS` 常量（上述 9 个 key），供 clear/apply 共享。 |
| `src/utils/model/switchModelProfile.ts` | **新增**：导出 `switchModelProfileAtomic(profile)`、`switchTier(tier)`、`clearProfileEnvVars()`、`ModelSwitchError`。 |

### 调用方调整

- `src/utils/customApiStorage.ts:225-289 applyModelProfile`：保留写入逻辑，**不在内部清旧 env**（清旧由事务工具步骤 2 负责）。在函数注释顶部声明这一约束。

### 不动

- `parseUserSpecifiedModel`、`getDefaultOpusModel/SonnetModel/HaikuModel`、`getRuntimeMainLoopModel`：函数本体逻辑不改。
- `.claude.json` / `.credentials.json` / `settings.json` 的 schema 与持久化代码：不改。
- ModelProfile 数据结构：不改。
- effort 显示与 `CLAUDE_CODE_EFFORT_LEVEL`：不改。

**改动文件统计**：修改 4 个，新增 2 个，共 6 个文件。

---

## §3 数据流

### 路径 P1：切换 ModelProfile

```
User 选定新 profile
        │
        ▼
/model handleSelect / setModel
        │
        ▼  调用
switchModelProfileAtomic(deepseekProfile)
        │
        ├─[1] envSnapshot = capture(PROFILE_MANAGED_ENV_KEYS)
        │
        ├─[2] clearProfileEnvVars()           ← 按白名单 delete process.env.X
        │      ✓ ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL 清空
        │      ✓ CLAUDE_CODE_SUBAGENT_MODEL / *_CAPABILITIES / *_CONTEXT_WINDOW 清空
        │      ✓ DISABLE_NONESSENTIAL_TRAFFIC / DISABLE_NONSTREAMING_FALLBACK 清空
        │
        ├─[3] applyModelProfile(deepseekProfile)
        │      → process.env.ANTHROPIC_MODEL = "deepseek-chat"
        │      → process.env.ANTHROPIC_BASE_URL / DOGE_API_KEY / PROVIDER ...
        │      → 新 profile 自带的 tier env var 写入（无则保持 unset）
        │
        ├─[4] syncModelConfigToDisk("deepseek-chat", persist=true)
        │      → ~/.doge/.claude.json   (customApiEndpoint.model + provider/baseURL/apiKey)
        │      → ~/.doge/settings.json  (model)
        │      → ~/.doge/.credentials.json (customApiEndpoint.model + 同上)
        │      ※ modelProfiles[] 本身不动（已是源头）
        │
        ├─[5] setAppState(prev => ({
        │       ...prev,
        │       mainLoopModel: "deepseek-chat",
        │       mainLoopModelForSession: null,
        │     }))
        │
        ▼
onChangeAppState 监听到 mainLoopModel 变化
        │
        ├─ writeSettings(userSettings, { model: "deepseek-chat" })
        ├─ setMainLoopModelOverride("deepseek-chat")
        └─ emit("modelChanged")                                       ← 新增（兜底信号）
                │
                ▼
StatusLine 重渲染
        │
        ▼  调用
useMainLoopModel({ permissionMode, exceeds200kTokens })
        │
        │  fallback 链：mainLoopModelForSession(=null) ?? mainLoopModel("deepseek-chat") ?? default
        │  → parseUserSpecifiedModel("deepseek-chat") → "deepseek-chat"
        │  → getRuntimeMainLoopModel({ model, permissionMode, exceeds200kTokens })
        │  → 最终 model ID = API 实际请求时用的 ID
        │
        ▼
显示 "deepseek-chat (... Context) ..."  ✅ 与下一次请求一致

[任一步骤 1–5 抛错]
        │
        ▼
catch → restore(envSnapshot)   ← env 恢复到事务前
        ▶ 抛 ModelSwitchError，toast 提示
```

### 路径 P2：切换 Tier

```
User 输入 /model haiku  或在面板选 Haiku
        │
        ▼
/model handleSelect / setModel  → 检测到是 alias 不是 profile
        │
        ▼  调用
switchTier("haiku")
        │
        ├─[1] setAppState(prev => ({
        │       ...prev,
        │       mainLoopModel: "haiku",          ← 写入 alias 字符串
        │       mainLoopModelForSession: null,
        │     }))
        │
        └─[2] syncModelConfigToDisk("haiku", persist=true)
              → 三文件 customApiEndpoint.model = "haiku"
              ※ 不动任何 env var
              ※ 不动 modelProfiles[]
        │
        ▼
onChangeAppState → 同 P1 末段
        │
        ▼
StatusLine 重渲染
        │
        ▼  调用
useMainLoopModel(...)
        │
        │  fallback 链：null ?? "haiku" ?? ...
        │  → parseUserSpecifiedModel("haiku")
        │       └→ getDefaultHaikuModel()
        │            读 process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
        │            ✓ 由于 P1 已保证白名单纯净，这里读到的只能来自当前 profile
        │  → getRuntimeMainLoopModel → 最终 ID
        │
        ▼
显示 "<解析后的真实模型 ID> ..."  ✅ 与下一次请求一致
```

### 路径选择规则

| 输入 | 走哪条 |
|---|---|
| 用户从 profile 列表选了一项 | P1 |
| 用户输入/点击 `default` / `opus` / `sonnet` / `haiku` | P2 |
| 用户直接输入一个非 alias、非 profile 的裸 model 字符串（如 `/model gpt-4o`） | 沿用 P2 写 AppState 的逻辑，不动 env |

---

## §4 错误处理

### A. P1 事务失败矩阵

| 步骤 | 失败原因 | 处理 |
|---|---|---|
| [1] 快照 env | 不会失败（纯内存读） | — |
| [2] clearProfileEnvVars | 不会失败（delete process.env 不抛） | — |
| [3] applyModelProfile | profile 字段缺失、内部异常 | catch → restore(envSnapshot) → 抛 `ModelSwitchError('apply', cause)` |
| [4] syncModelConfigToDisk | 磁盘只读 / 权限错 / JSON 解析旧文件失败 | catch → restore(envSnapshot) → 抛 `ModelSwitchError('persist', cause)` |
| [5] setAppState | store 损坏 | catch → restore(envSnapshot) → 尝试 `syncModelConfigToDisk(oldProfile.model, true)` 回写旧值；再失败则 warn + toast "切换未完成，建议重启" |

**回滚守则**：`restore(envSnapshot)` 必须使用快照原值（而非"删空"），因为快照前 env 已可能存在用户外部 export 的值。

**用户可见行为**：失败时不更新状态栏（AppState 未提交），通过 toast 输出一行错误。

### B. P2 失败矩阵

| 步骤 | 失败原因 | 处理 |
|---|---|---|
| setAppState | 同 A.[5] | catch → warn + toast；UI 维持旧 tier |
| syncModelConfigToDisk | 磁盘错 | catch → **不**回滚 AppState；toast "已生效但未保存" |

### C. 解析侧容错（useMainLoopModel）

| 异常输入 | 处理 |
|---|---|
| AppState.mainLoopModel = `undefined` | fallback 链兜底到 `getDefaultMainLoopModelSetting()` |
| `mainLoopModel = 'haiku'` 但 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 缺失 | `getDefaultHaikuModel()` 既有逻辑 fallback 到 `ANTHROPIC_MODEL` → `modelStrings.haiku45`——与 API 客户端一致 |
| `parseUserSpecifiedModel` 抛错 | catch → 返回原字符串作为 best-effort 显示 |
| `getRuntimeMainLoopModel` 抛错 | catch → 跳过 runtime 覆盖直接用 parse 结果 |

所有 catch 用 `logDebug('model-switch', cause)`，不写 stderr。

### D. 边界与竞态

1. **并发 /model 调用**：React 单线程同步 handler；事务函数体不 await 外部，原子性靠同步执行保证。不引入 mutex。
2. **/model 期间用户发起 API 请求**：事务同步完成，不存在用户在事务"中间"按下回车的物理可能。
3. **/clear 与 /model 交互**：/clear 不动 mainLoopModel，无新增风险。
4. **modelProfiles[] 损坏**：`readCustomApiStorage` 现有错误处理保留；读取失败时 handleSelect 先报错，不会进 `switchModelProfileAtomic`。

### E. 可观测性

- `logDebug('model-switch', {phase, profile, envBefore, envAfter})` —— 仅在 `--debug=model-switch` 启用时输出
- `model-switch` 加入 `src/utils/debugFilter.ts` 的已知分类
- 错误 toast 格式：`"Model switch failed at <phase>: <message>"`

### F. 不做

- 不引入 `ModelSwitchError` 之外的新错误类型
- 不增加重试逻辑
- 不增加迁移逻辑（profile schema 不变）
- 不修改 `/resume` 与 `/clear` 的现有错误处理

---

## §5 测试

### A. 单元测试

**`src/utils/model/profileEnvKeys.test.ts`** —— 新增

- 断言 `PROFILE_MANAGED_ENV_KEYS` 包含审计报告中 9 个 key 的精确集合（snapshot）。

**`src/utils/model/switchModelProfile.test.ts`** —— 新增

| 用例 | 断言 |
|---|---|
| `clearProfileEnvVars()` 清掉白名单全部 9 个 env var | 调用前预设值，调用后 `process.env.X === undefined` 逐一断言 |
| `switchModelProfileAtomic(deepseekProfile)` 干净链路 | env 含新 model/baseURL/apiKey；AppState.mainLoopModel === deepseek model；mainLoopModelForSession === null |
| 旧 profile 有 haiku 覆盖、新 profile 没 haiku | 切换后 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 必须为 undefined（**核心回归**） |
| applyModelProfile 抛错 → env 回滚 | mock applyModelProfile 抛错；断言 env 与快照逐项相等；AppState 未改 |
| syncModelConfigToDisk 抛错 → env 回滚 + 重抛 | mock writeCustomApiStorage 抛错；断言 env 回滚 + 抛 `ModelSwitchError('persist')` |
| `switchTier('haiku')` 不动任何 env | 预设 9 个 env，调用后 9 个 env 与调用前**逐项相等**；AppState.mainLoopModel === 'haiku' |
| `switchTier(null)` 等价于切回 default | AppState.mainLoopModel === profile.model（非 alias） |

mock 策略：Bun `mock.module` 替换 `syncModelConfigToDisk` 与 `setAppState`；env 直接操作 `process.env` 后用 `afterEach` 还原。

### B. 解析侧测试

**`src/hooks/useMainLoopModel.test.ts`** —— 新增/扩充

| 用例 | 断言 |
|---|---|
| mainLoopModel = 具体 ID | hook 返回值 === 该 ID 经 `getRuntimeMainLoopModel` 处理后的值 |
| mainLoopModel = 'haiku'，env.HAIKU_MODEL = X | hook 返回值 === X（不是 'haiku'） |
| mainLoopModel = 'haiku'，env.HAIKU_MODEL 缺失，env.ANTHROPIC_MODEL = Y | 返回 Y |
| permissionMode='plan' + mainLoopModel='haiku' | 返回 `getDefaultSonnetModel()`（plan mode 强升） |
| mainLoopModel = undefined | 返回 `getDefaultMainLoopModelSetting()` |
| mainLoopModelForSession 存在 | 优先于 mainLoopModel |
| **fallback 链不再读 customApiStorage** | mock `readCustomApiStorage` 返回 `{model:'CONTAMINATED'}`，AppState 为 undefined → 返回 default（不是 CONTAMINATED） |

### C. 集成测试

**`src/commands/model/handlers.test.ts`** —— 新增

抽离 `handleSelect`/`setModel` 的决策与副作用为纯函数 `decideAndSwitch(input, ctx)`：

| 输入 | 期望调用 |
|---|---|
| 用户选 profile X | `switchModelProfileAtomic(X)` 调一次，`switchTier` 未调 |
| 用户输入 'haiku' | `switchTier('haiku')` 调一次 |
| 用户输入 'default' | `switchTier(null)` 调一次 |
| 用户输入裸 model 'gpt-4o' | 走 P2 裸字符串分支：setAppState + sync，不动 env |

### D. 手动验证脚本

详见同目录 `2026-06-29-model-switch-fix-manual-verify.md`。核心 9 步：

1. 准备两个 ModelProfile（qwen-max 三 tier 全配置；deepseek-chat 三 tier 留空）。
2. 启动 doge，状态栏应显示 `qwen-max`。
3. /model → haiku，状态栏应显示 qwen profile 的 defaultHaikuModel。
4. /model → default，状态栏回到 `qwen-max`。
5. /model → deepseek-chat（兜底切换），状态栏立刻 `deepseek-chat`。
6. /model → haiku，状态栏应显示 `deepseek-chat`（**关键回归**：以前会显示 qwen 残留 haiku）。
7. /model → qwen-max，再 /model → haiku，状态栏应回到 qwen profile haiku 值（正向路径未破）。
8. 第 6 步发一次真实请求，对比 `~/.doge/debug/<sessionId>.txt` 中 API 实际 model ID ≡ 状态栏文本。
9. 模拟 `.credentials.json` 只读 → /model 切 profile → 应看到失败 toast，状态栏与 env 保持旧值。

### E. 运行

```sh
bun test src/utils/model/profileEnvKeys.test.ts \
         src/utils/model/switchModelProfile.test.ts \
         src/hooks/useMainLoopModel.test.ts \
         src/commands/model/handlers.test.ts
```

本地必须全绿。手动脚本 9 步全过的录屏/截图附在 PR。

### F. 不写

- 跨平台测试（Windows-only）
- 真实 API 调用测试（mock 已覆盖错位 bug）
- 性能测试（事务 O(1) 同步）

---

## 验收标准

1. 上述 7 个单元/集成测试全绿。
2. 手动脚本第 6 步：deepseek-chat profile（无 haiku 覆盖）+ /model haiku → 状态栏显示 deepseek-chat（不是任何 qwen 残留）。
3. 手动脚本第 8 步：API 实际请求 model ID ≡ 状态栏文本（debug 日志比对）。
4. 手动脚本第 9 步：磁盘只读时切换失败，env 与状态栏均保持旧值。
5. 既有 `/clear` / `/resume` / 普通对话流程无回归。

---

## 不做的事

- 不动 `.credentials.json` / `.claude.json` / `settings.json` 的 schema。
- 不动 ModelProfile 数据结构。
- 不动 `parseUserSpecifiedModel` / `getDefaultXxxModel` 函数体。
- 不动 effort / thinking 相关代码。
- 不引入新落盘文件、新 UI、新命令。
- 不修复 `CLAUDE_CODE_EFFORT_LEVEL` 的"故意不同步"设计——若未来需要随 profile 切，单独立项。

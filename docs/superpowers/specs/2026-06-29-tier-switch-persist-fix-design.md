# Tier 切换持久化断裂修复 — 设计

**日期**: 2026-06-29
**分支**: `feat/model-switch-fix`（承接上一轮 model-switch-fix，不合并入 main）
**状态**: 设计阶段

## 1. 问题现象

用户在 `/model` 命令中切换到 tier 别名（Opus / Sonnet / Haiku）后退出，**裸 `doge` 启动**（不跑 `start_*.ps1`）时，状态栏停留在字面字符串 `"opus"` / `"sonnet"` / `"haiku"`，而非其背后真实模型，导致实际 API 请求发出字面 tier 字符串，API 无法识别，**直接无法使用**。

切换到"兜底模型"（default / null）后退出，下次裸启动正常。

## 2. 根因（已由数据流追踪证实）

### 2.1 bug 双重触点，都在 `switchTier` 路径

`switchTier(tier, deps)`（`src/utils/model/switchModelProfile.ts:216-224`）：

```ts
export function switchTier(tier: TierAlias, deps: SwitchTierDeps): void {
  const modelString = tier              // "haiku"
  deps.syncToDisk(modelString ?? '', true)   // ← clearCredentials=true
  deps.commitAppState((prev) => ({
    ...prev,
    mainLoopModel: modelString,         // "haiku"
    mainLoopModelForSession: null,
  }))
}
```

**触点 A — 传 `clearCredentials=true`**：`syncModelConfigToDisk("haiku", true)`（`src/commands/model/model.tsx:27-58`）走 `clearCredentials` 分支，把磁盘 `customApiEndpoint` 的 `provider / baseURL / apiKey / authTokenType` **全部清成 undefined**。

**触点 B — 把 tier 字符串当作 `customApiEndpoint.model` 持久化**：`writeCustomApiStorage({ ...currentStorage, model: "haiku", ...cleared })`。`modelProfiles[]` 以**真实模型 ID** 为键（`getModelProfile` 用 `normalizeModelName` 精确匹配，`customApiStorage.ts:124-129`），tier 字符串 `"haiku"` **永远找不到匹配 profile**。

### 2.2 裸启动恢复链断裂的完整时序

裸 `doge` 启动时 `process.env` 初始全空，`applyPersistedCustomApiEndpointEnv()`（`src/utils/managedEnv.ts:204-315`）在 `init()` 早期运行：

1. 第 214 行：`customApiEndpoint.model = "haiku"` 且 `!process.env.ANTHROPIC_MODEL` 成立 → `process.env.ANTHROPIC_MODEL = "haiku"`（**字面字符串灌入**）。
2. 第 230 行：`activeModel = "haiku"`。
3. 第 234 行：`getModelProfile("haiku")` → **undefined**（无匹配 profile）→ 第 235-291 行的 profile 恢复块**整体跳过** → `ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_BASE_URL`、`DOGE_API_KEY` 等**全不恢复**。
4. `main.tsx:2120`：`setInitialMainLoopModel(getUserSpecifiedModelSetting())`。`getUserSpecifiedModelSetting`（`model.ts:62-79`）第 70 行 = `process.env.ANTHROPIC_MODEL || settings.model` = `"haiku"` → `initialMainLoopModel = "haiku"`。
5. 运行时 `parseUserSpecifiedModel("haiku")`（`model.ts:516-545`）→ `getDefaultHaikuModel()`（`model.ts:168-193`）：
   - `process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL` 不存在 → 跳过。
   - `getUserSpecifiedModelSetting()` = `"haiku"` → `isModelAlias("haiku")` true → 跳过（防循环）。
   - `process.env.ANTHROPIC_MODEL` = `"haiku"` → **返回字面 `"haiku"`**。
6. 字面 `"haiku"` 被当作真实模型 ID 发往 API → API 不认识 → **无法使用**。

### 2.3 为何当前会话不出问题、只有"下次启动"才崩

当前会话内，`process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL` 等仍存在（PS 脚本注入，或上一次 `applyModelProfile` 写入，`switchTier` 不碰 env），`parseUserSpecifiedModel("haiku")` 仍能命中 `getDefaultHaikuModel` 的第一优先级返回真实模型。只有**退出后裸启动**，env 丢失 + 磁盘 tier 字符串无法定位 profile，恢复链才断裂。

### 2.4 为何"兜底模型"下次启动正常

`switchTier(null)` → `mainLoopModel = null` → `onChangeAppState`（`state/onChangeAppState.ts:96-104`）走 "remove model" 分支，`updateSettingsForSource('userSettings', { model: undefined })` 清掉 settings.model，`setMainLoopModelOverride(null)`。`getUserSpecifiedModelSetting` 回落 `ANTHROPIC_MODEL`（若被 214 行设成真实 ID 则健康；若为空则回落 built-in default）。default 路径未把字面 "default" 写进 `ANTHROPIC_MODEL`，故不触发字面字符串污染。

### 2.5 PS 脚本启动场景为何健康

`start_*.ps1` 在启动 `doge` 前先 `Remove-Item Env:\ANTHROPIC_MODEL` 等再重新设置成脚本固定真实模型（`start_deepseek.ps1:10,26`；`start_opus.ps1:10,22`）。故 `applyPersistedCustomApiEndpointEnv` 第 214 行守卫 `!process.env.ANTHROPIC_MODEL` 为 false → 不会把磁盘 "haiku" 灌进 env；tier env var 由脚本固定值提供 → 运行时解析健康。**问题仅在裸 `doge` 启动时爆发**（用户已确认其复现场景即裸启动）。

## 3. 设计目标

1. **修复"无法使用"**：tier 切换后裸启动，实际 API 请求必须发出真实模型 ID，而非字面 tier 字符串。
2. **状态栏一致性**（承接上一轮原始需求）：tier 切换后裸启动，状态栏显示**真实会被请求的 tier 模型**（如 `deepseek-v4-flash`），而非字面 `"haiku"`。
3. **不丢 tier 选择语义**：切到 Haiku 重启后，用的就是 Haiku tier 背后的真实模型（而非主模型）。
4. **不破坏 PS 脚本启动场景**：修复对 PS 脚本启动必须是无害的（该场景已健康）。
5. **不破坏 P1（真实 profile 切换）路径**：上一轮已验证 P1 健康且原子，本修复只动 P2（tier）路径。

## 4. 方案选型

### 4.1 否决的方案

- **方案 A（仅保留 profile 锚点 + settings 存 tier alias）**：`customApiEndpoint.model` 保留真实主模型 ID，`settings.model` 存 "haiku"。问题：`getUserSpecifiedModelSetting` 优先取 `ANTHROPIC_MODEL`（= 真实主模型 ID），`initialMainLoopModel` 变成主模型而非 Haiku tier → **tier 选择丢失**（重启后用主模型）。需追加改 `getUserSpecifiedModelSetting` / main.tsx 启动逻辑才能恢复 tier 选择，改动面大且引入"settings.model 与 ANTHROPIC_MODEL 语义分裂"的复杂度。
- **方案 B（tier 模型 ID 当 profile key）**：把 `customApiEndpoint.model` 写成真实 tier 模型 ID，但 tier 模型无 profile → 凭证恢复靠 top-level 回落。若 top-level 凭证被清空（触点 A），回落失败。需配合不清凭证，本质退化成方案 C。

### 4.2 选定方案 C — "tier 切换 = 在当前活跃 profile 内切 tier，持久化真实 tier 模型 ID + 保留凭证"

**核心语义变更**：tier 切换不再把 tier **别名字符串**当作 `customApiEndpoint.model` 持久化，而是：

1. **解析真实 tier 模型 ID**：tier 切换那一刻，`process.env.ANTHROPIC_DEFAULT_<TIER>_MODEL` 一定有值（PS 脚本注入 / profile 恢复 / 上一次 `applyModelProfile` 写入——`switchTier` 不碰 env，故该值在切换瞬间保持有效）。用 `parseUserSpecifiedModel(tier)` 解析出真实 tier 模型 ID（如 `deepseek-v4-flash`）。
2. **持久化真实 tier 模型 ID + 保留当前 profile 凭证**：`syncToDisk(真实tier模型ID, clearCredentials=false)`。
   - `customApiEndpoint.model` = 真实 tier 模型 ID（恢复锚点）。
   - `customApiEndpoint.provider/baseURL/apiKey/authTokenType` = **当前活跃 profile 的凭证**（由 `syncModelConfigToDisk` 的 `profile` 分支写入，`getModelProfile(当前主模型)` 解析；若当前无 profile 则保留 top-level 现值不清空）。
3. **`mainLoopModel` = 真实 tier 模型 ID**：状态栏显示真实模型（满足目标 2），运行时不再走 `parseUserSpecifiedModel("haiku")` 别名解析（因 `mainLoopModel` 已是真实 ID）。

### 4.3 裸启动恢复链（修复后）

1. `customApiEndpoint.model` = 真实 tier 模型 ID（如 `deepseek-v4-flash`）→ 第 214 行 `ANTHROPIC_MODEL = "deepseek-v4-flash"`。
2. `activeModel = "deepseek-v4-flash"` → `getModelProfile` 可能找不到（tier 模型无 profile）→ 走 top-level credentials 回落（`managedEnv.ts:297-313`），用 `customApiEndpoint` 保留的 provider/baseURL/apiKey → **凭证正确恢复**。
3. `getUserSpecifiedModelSetting` = `ANTHROPIC_MODEL` = `"deepseek-v4-flash"` → `initialMainLoopModel = "deepseek-v4-flash"`。
4. 运行时 `parseUserSpecifiedModel("deepseek-v4-flash")` → 非别名 → 直接返回 `"deepseek-v4-flash"` → **请求发出真实 tier 模型 ID** ✓。
5. 状态栏显示 `"deepseek-v4-flash"`（真实 tier 模型）✓。

### 4.4 PS 脚本启动场景（修复后无害）

PS 脚本先清空再注入固定 env。`applyPersistedCustomApiEndpointEnv` 第 214 行守卫 `!process.env.ANTHROPIC_MODEL` 为 false → 不覆盖脚本值。tier env var 由脚本提供。`customApiEndpoint.model` = 真实 tier 模型 ID 仅作磁盘记录，不污染 env。**PS 场景行为不变**。

### 4.5 关键事实：自定义 provider 用户的 tier 全走 P2

`getAPIProvider()`（`providers.ts:6-14`）只认 `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`。自定义 DeepSeek/GLM/Qwen 用户不设这些 → `getAPIProvider() = 'firstParty'` → `modelOptions.ts` 的 `is3P = getAPIProvider() !== 'firstParty'` = **false**。故：

- `getSonnet46Option().value` = `is3P ? ... : 'sonnet'` = **`'sonnet'`**（字面）→ P2
- `getOpus46Option().value` = **`'opus''`**（字面）→ P2
- `getHaiku45Option().value` = **`'haiku'`**（恒定字面）→ P2

**自定义 provider 用户三个 tier 全走 P2（`switchTier`）**，与用户报告"opus/sonnet/haiku 都崩"完全吻合。方案 C 修复 `switchTier` 即精确覆盖用户场景。§7.4 关于"ModelPicker 传真实 ID 导致 P2 不触发"的担忧**不适用于自定义 provider 用户**——他们的 ModelPicker 传字面 tier 别名，P2 必触发（仅对真正 3P provider——bedrock/vertex/foundry——才有 Sonnet/Opus 走 P3 的分歧，不属本修复用户群）。

### 4.6 default 路径（`switchTier(null)`）

保持现有语义：`mainLoopModel = null`，`syncToDisk("", true)` 清凭证 + 清 model。`onChangeAppState` 走 remove 分支。**default 路径不动**（已健康，且清凭证是 default 的正确语义——切回 default 意味着不再绑定任何自定义 profile）。

## 5. 不变性

1. **`customApiEndpoint.model` 永远是真实模型 ID（或空串/default 路径的清空）**，绝不是 tier 别名字符串。这是裸启动恢复链的正确性前提。
2. **tier 切换不清空凭证**：`switchTier` 的 `clearCredentials` 第二参数从 `true` 改为 `false`。tier 切换是"在同一 profile 内换 tier"，不是"切到新 provider"，凭证应保留。仅 default（`null`）路径清凭证。
3. **`mainLoopModel` 持久化值 = 状态栏显示值 = 实际请求模型 ID**（三者合一）。tier 切换后这三者都是真实 tier 模型 ID，消除"显示 alias、请求 alias"的错位。
4. **P1（真实 profile 切换）路径不变**：`switchModelProfileAtomic` 已正确持久化真实主模型 ID + 重置 env，本修复不触碰。
5. **PS 脚本启动场景不变**：修复只在"裸启动 + 磁盘 model 字段"层面生效，PS 脚本 env 优先级不变。

## 6. 实现变更点

### 6.1 `src/utils/model/switchModelProfile.ts` — `switchTier` 语义重构

当前：
```ts
export function switchTier(tier: TierAlias, deps: SwitchTierDeps): void {
  const modelString = tier
  deps.syncToDisk(modelString ?? '', true)   // clearCredentials=true ← bug
  deps.commitAppState((prev) => ({ ...prev, mainLoopModel: modelString, mainLoopModelForSession: null }))
}
```

变更后（草稿，注入依赖版，最终签名由 writing-plans 定）：
```ts
export interface SwitchTierDeps {
  syncToDisk: (model: string, clearCredentials: boolean, credentialSourceProfile?: ModelProfile) => void
  commitAppState: (updater: (prev: AppStateSlice) => AppStateSlice) => void
  resolveTierModel: (tier: 'opus' | 'sonnet' | 'haiku') => string
  getActiveProfile: () => ModelProfile | undefined
}

export function switchTier(tier: TierAlias, deps: SwitchTierDeps): void {
  if (tier === null) {
    // default 路径：清凭证 + 清 model，保持现有语义
    deps.syncToDisk('', true, undefined)
    deps.commitAppState((prev) => ({ ...prev, mainLoopModel: null, mainLoopModelForSession: null }))
    return
  }
  // tier 路径：解析真实 tier 模型 ID，保留并回写当前活跃 profile 凭证
  const realTierModel = deps.resolveTierModel(tier)           // "haiku" → "deepseek-v4-flash"
  const activeProfile = deps.getActiveProfile()               // 当前活跃 profile（凭证来源）
  deps.syncToDisk(realTierModel, false, activeProfile)        // clearCredentials=false + 凭证回写 ← 修复
  deps.commitAppState((prev) => ({ ...prev, mainLoopModel: realTierModel, mainLoopModelForSession: null }))
}
```

`bindings.ts` 注入真实实现：
```ts
import { getModelProfile, type ModelProfile } from '../customApiStorage.js'
import { parseUserSpecifiedModel } from './model.js'

export function switchTierBound(tier, deps) {
  return switchTierCore(tier, {
    syncToDisk: deps.syncToDisk,
    commitAppState: bindCommit(deps.setAppState),
    resolveTierModel: (t) => parseUserSpecifiedModel(t),
    getActiveProfile: () => process.env.ANTHROPIC_MODEL ? getModelProfile(process.env.ANTHROPIC_MODEL) : undefined,
  })
}
```

**关键**：`resolveTierModel` 在 tier 切换那一刻调用，`process.env.ANTHROPIC_DEFAULT_<TIER>_MODEL` 必有值（`switchTier` 不碰 env，该值从 PS 脚本/profile 恢复/上次 applyModelProfile 继承），故解析可靠。`getActiveProfile` 反查用的 `process.env.ANTHROPIC_MODEL` 是切换前当前会话的主模型（真实 ID），命中 profile 即得凭证来源。`switchTier` 仍**不碰 env**（只读 env 解析，不写），保留"不动白名单 env var"不变式。

### 6.2 凭证来源：tier 切换时明确回写当前活跃 profile 凭证

方案 C 的核心风险：tier 模型 ID（如 `deepseek-v4-flash`）≠ profile key（主模型 `deepseek-v4-pro[1m]`），故 `syncModelConfigToDisk(真实tier模型ID, false)` 走 `getModelProfile(真实tier模型ID)` = undefined → `credsUpdate = {}` → `customApiEndpoint` 凭证**保留磁盘现值**。若磁盘现值是更早残留（非当前活跃 profile），裸启动凭证恢复错位。

**增强**：tier 切换时，`switchTier` 先解析**当前活跃 profile**（由 `process.env.ANTHROPIC_MODEL` 当前值反查 `getModelProfile`），把该 profile 的 provider/baseURL/apiKey/authTokenType **明确回写**到 `customApiEndpoint`，而非依赖磁盘残留。

实现上 `syncModelConfigToDisk` 已有 `profile` 分支（`model.tsx:33-40`）：当 `getModelProfile(model)` 命中时从 profile 取凭证。但 tier 模型 ID 不命中。故需让 `switchTier` 传入"当前活跃 profile"作为凭证来源，而非让 `syncModelConfigToDisk` 用 tier 模型 ID 反查。

两种实现选项（writing-plans 细化）：
- **选项 a**：`switchTier` 在调 `syncToDisk` 前，先用当前 `process.env.ANTHROPIC_MODEL` 反查 `getModelProfile`，若命中则把该 profile 的凭证先 `writeCustomApiStorage` 回写到 `customApiEndpoint` 顶层，再调 `syncToDisk(真实tier模型ID, false)`（此时 `getModelProfile(真实tierID)` 仍 undefined，`credsUpdate={}`，保留刚回写的凭证）。
- **选项 b（选定，注入依赖版）**：保持 `switchModelProfile.ts` 纯 util 性质（不直接 import `model.ts`/`customApiStorage.ts` 的解析函数，避免把它们拉进 util 依赖图），改为向 `switchTier` **注入**两个解析依赖：
  - `resolveTierModel: (tier: 'opus'|'sonnet'|'haiku') => string` — 真实实现 = `parseUserSpecifiedModel(tier)`。
  - `getActiveProfile: () => ModelProfile | undefined` — 真实实现 = `() => process.env.ANTHROPIC_MODEL ? getModelProfile(process.env.ANTHROPIC_MODEL) : undefined`。
  - `syncToDisk` 签名扩展为 `(model: string, clearCredentials: boolean, credentialSourceProfile?: ModelProfile) => void`，tier 路径传 `getActiveProfile()` 的结果。
  - `bindings.ts` 负责注入真实实现（`switchTierBound` 内 wire `parseUserSpecifiedModel` + `getModelProfile`），测试注入 mock。

选项 b 比选项 a 更优：单一存储写入（无两次写竞态）、显式依赖、纯 util 不耦合解析模块、完全可测。**放弃选项 a**。

`syncModelConfigToDisk`（`model.tsx:27-58`）相应扩展：增加可选第三参数 `credentialSourceProfile?: ModelProfile`。当传入时，`credsUpdate` 取自该 profile（覆盖 `getModelProfile(model)` 反查分支）；未传入时保持现有 `getModelProfile(model)` 反查逻辑（P1/default 路径不变）。

### 6.3 裸启动凭证恢复（修复后）

`customApiEndpoint.model` = 真实 tier 模型 ID（如 `deepseek-v4-flash`），`customApiEndpoint` 凭证 = 当前活跃 profile 回写值（provider/baseURL/apiKey）。裸启动：

1. 第 214 行：`ANTHROPIC_MODEL = "deepseek-v4-flash"`。
2. 第 230-234 行：`activeModel = "deepseek-v4-flash"` → `getModelProfile("deepseek-v4-flash")` = undefined（tier 模型无 profile）→ profile 恢复块跳过 → **tier env var 不恢复**。
3. 第 297-313 行（top-level 回落）：因 `hasProfileCredentials = false`，用 `customApiEndpoint` 顶层 provider/baseURL/apiKey 恢复 → **凭证正确**（来自 §6.2 回写的当前活跃 profile 值）。
4. `getUserSpecifiedModelSetting` = `ANTHROPIC_MODEL` = `"deepseek-v4-flash"` → `initialMainLoopModel = "deepseek-v4-flash"`。
5. 运行时 `parseUserSpecifiedModel("deepseek-v4-flash")` → 非别名 → 直接返回 → **请求发出 `deepseek-v4-flash`** ✓。状态栏显示 `deepseek-v4-flash` ✓。

**关键**：方案 C 下运行时不再走 `parseUserSpecifiedModel("haiku")` 别名解析（`mainLoopModel` 已是真实 ID），故**不依赖** `ANTHROPIC_DEFAULT_HAIKU_MODEL` 是否恢复——仅需凭证（baseURL/apiKey）正确恢复，由 §6.2 回写 + top-level 回落保证。

### 6.4 不需要改动的部分

- `applyPersistedCustomApiEndpointEnv`（`managedEnv.ts`）：恢复逻辑已正确，只要磁盘 `customApiEndpoint.model` 是真实 ID + 凭证已回写即可正常工作。
- `onChangeAppState`（`state/onChangeAppState.ts`）：`mainLoopModel !== null` 分支写 settings.model = 真实 tier 模型 ID，正确。
- `getUserSpecifiedModelSetting` / `parseUserSpecifiedModel` / `getDefault*Model`：解析链已正确，无需改。
- `switchModelProfileAtomic`（P1 路径）：不动。
- `decideAndSwitch`（`handlers.ts`）：P2 分支调用 `switchTierBound` 不变，语义变更在 `switchTier` 内部吸收。

## 7. 边界与风险

### 7.1 `parseUserSpecifiedModel(tier)` 解析失败的可能

若 tier 切换那一刻 `process.env.ANTHROPIC_DEFAULT_<TIER>_MODEL` 恰好为空（理论上不应发生——`switchTier` 不碰 env，该值从 PS 脚本注入或 profile 恢复或上次 `applyModelProfile` 继承），`getDefaultHaikuModel` 会回落到 `ANTHROPIC_MODEL`（真实主模型 ID）或 built-in default。此时 `realTierModel` 可能解析成主模型而非 Haiku tier 模型——但这是**降级行为**（用主模型而非崩溃用字面 "haiku"），仍优于现状。可在实现时加 debug 日志标记此降级。

用户确认用 `/add-model` 存过 profile，故裸启动后若磁盘 `customApiEndpoint.model` 是主模型 ID 则 profile 恢复会注入 `ANTHROPIC_DEFAULT_*_MODEL`；但方案 C 下 tier 切换已把磁盘 model 改成真实 tier 模型 ID（非主模型 ID），profile 恢复块跳过，`ANTHROPIC_DEFAULT_*_MODEL` 不恢复。**这无碍**——方案 C 不依赖该 env（见 §6.3）。仅当 tier 切换**瞬间**（非重启）该 env 缺失才会触发本节降级，而切换瞬间该 env 来自当前会话已注入的值（PS 脚本/profile 恢复/上次 apply），缺失概率极低。

### 7.2 `[1m]` / `[2m]` 后缀保留

`parseUserSpecifiedModel` 会保留 `contextSuffix`（`[1m]`/`[2m]`）。若用户选 `haiku[1m]`，解析出 `deepseek-v4-flash[1m]`，持久化带后缀。`normalizeModelName` 在 profile 匹配时剥离后缀，但 `customApiEndpoint.model` 持久化的是带后缀的完整字符串——裸启动时 `ANTHROPIC_MODEL = "deepseek-v4-flash[1m]"`，本地剥离后缀用于上下文窗口计算，发请求时剥离（现有 `[1m]` 处理逻辑）。**与现有 `[1m]` 行为一致，无需特殊处理**。

### 7.3 顶层凭证对齐（本修复主动处理）

P1 路径 `switchModelProfileAtomic` 调 `syncToDisk(profile.model, true)` 清空顶层 `customApiEndpoint` 凭证，但 `applyModelProfile` 不回写顶层凭证（只写 `customApiStorage.model`，见 `customApiStorage.ts:300-311`）。这导致 P1 切换后顶层凭证可能错位（属上一轮设计遗留）。**方案 C 的 §6.2 增强在 tier 切换时主动从当前活跃 profile 回写顶层凭证**，间接修复了"tier 切换后顶层凭证错位"这一具体表现。但 P1 路径自身的顶层凭证错位（P1 切换后、未做 tier 切换时裸启动）仍未根治——若出现需另立修复（让 `applyModelProfile` 同步回写顶层凭证）。本修复不承诺根治 P1 顶层凭证错位，仅保证 tier 切换路径凭证正确。

### 7.4 ModelPicker tier 选项 value（已核实，不适用）

经核实（modelOptions.ts:135-183, providers.ts:6-14）：自定义 provider 用户的 `getAPIProvider() = 'firstParty'` → `is3P = false` → Sonnet/Opus 选项 value 为字面 `'sonnet'`/`'opus'`，Haiku 恒为 `'haiku'`。三个 tier 全走 P2（`switchTier`），方案 C 精确覆盖。"ModelPicker 传真实 ID 导致 P2 不触发"的担忧**仅对真正 3P provider（bedrock/vertex/foundry）成立，不属本修复用户群**，无需处理。

## 8. 验收标准

### 8.1 自动化测试（`switchModelProfile.test.ts` 扩展）

测试通过注入 `resolveTierModel` / `getActiveProfile` mock，不再依赖真实 `parseUserSpecifiedModel`/`getModelProfile`（保持 `switchTier` 单元纯度）。

1. `switchTier('haiku')` 注入 `resolveTierModel: () => "deepseek-v4-flash"`、`getActiveProfile: () => <profile P>` → `syncToDisk` 被调 with `("deepseek-v4-flash", false, P)`；`commitAppState` 的 `mainLoopModel === "deepseek-v4-flash"`。
2. `switchTier('opus')` 注入 `resolveTierModel: () => "deepseek-v4-pro[1m]"` → `syncToDisk("deepseek-v4-pro[1m]", false, <profile>)`；`mainLoopModel === "deepseek-v4-pro[1m]"`。
3. `switchTier(null)` → `syncToDisk("", true, undefined)`（清凭证 + 清 model）；`mainLoopModel === null`。（default 路径回归不变）
4. `switchTier('haiku')` 不再传 `clearCredentials=true`：断言 `syncToDisk` 第二参数为 `false`。
5. `switchTier('haiku')` 注入 `getActiveProfile: () => undefined`（无当前 profile）→ `syncToDisk` 第三参数为 `undefined`（不崩溃，保留磁盘现值凭证）。
6. `switchTier` 仍不碰白名单 env var（保留现有不变式）：预设 9 个 env，调用后逐项相等。

### 8.2 既有测试兼容性

`switchModelProfile.test.ts:175` 现有断言 `expect(syncMock).toHaveBeenCalledWith('haiku', true)` 在修复后**必失败**（新行为是 `("deepseek-v4-flash", false, ...)`）。该测试需同步更新为新语义。`switchTier(null)` 测试（:179-190）断言 `mainLoopModel === null` 仍成立，无需改。`handlers.test.ts` 对 `switchTierBound` 的调用断言（`toHaveBeenCalledWith('haiku', expect.anything())`）仍成立（绑定层签名不变，只内部 `switchTier` 行为变），无需改。

### 8.2 手动验证（裸 `doge` 启动）

1. 用 `start_deepseek.ps1` 启动 → `/model` 切到 Haiku → 确认当前会话状态栏显示 `deepseek-v4-flash`，能正常对话。
2. 退出。**裸 `doge` 启动**（不跑任何 start 脚本）→ 状态栏显示 `deepseek-v4-flash`（真实 tier 模型，非字面 "haiku"）→ 能正常对话（请求发出 `deepseek-v4-flash`）。
3. 裸启动下查 `~/.doge/debug/<sessionId>.txt`：API 请求 model ID = `deepseek-v4-flash` ≡ 状态栏文本。
4. 同样验证 Opus、Sonnet tier。
5. PS 脚本启动场景回归：`start_deepseek.ps1` → `/model haiku` → 退出 → `start_deepseek.ps1` 重启 → 行为与修复前一致（仍健康）。
6. default 回归：`/model default` → 退出 → 裸启动 → 状态栏显示主模型（非字面 "default"），能正常对话。

## 9. 实现任务分解（待 writing-plans 细化）

1. `syncModelConfigToDisk`（`model.tsx`）扩展第三参数 `credentialSourceProfile?`，传入时 `credsUpdate` 取自该 profile（P1/default 路径不变）。
2. `SwitchTierDeps` 扩展注入 `resolveTierModel` + `getActiveProfile`；`syncToDisk` 签名加 `credentialSourceProfile?`。
3. `switchTier` 语义重构（`switchModelProfile.ts`）：null 走清凭证路径，tier 走 `resolveTierModel` 解析真实 ID + `clearCredentials=false` + 传 `getActiveProfile()` 凭证。
4. `switchModelProfile.bindings.ts`：`switchTierBound` 注入 `parseUserSpecifiedModel` + `getModelProfile` 真实实现。
5. `switchModelProfile.test.ts`：更新现有 `switchTier('haiku')` 断言（新语义）+ 新增 5 个测试（含凭证回写、降级、null 路径）。
6. 全量回归：`bun test` + restore-check + 手动验证 6 步。

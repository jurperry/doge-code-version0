# Doge Code 修复日志（下篇续：Chapter 26+）

上篇（Chapter 1-10）见 `debug_updates_1.md`，中篇（Chapter 11-25）见 `debug_updates_2.md`。

---

## Chapter 26: Model Switching 凭据覆盖修复 — env > storage 优先级 + applyModelProfile 双通道分离

### 修复日期

2026-05-14

### 问题描述

`/model` 切换主模型时 `.credentials.json` 存在配置覆盖问题：

1. **跨模型切换时顶层凭据被覆盖**：从 DeepSeek 切换到 GLM 时，`applyModelProfile()` 把 `provider=anthropic, baseURL=open.bigmodel.cn` 写入 `.credentials.json` 顶层。下次用 `start_deepseek.ps1` 启动时，`CLAUDE_CODE_COMPATIBLE_API_PROVIDER=openai` 被 env var 设置，但 `customApiStorage.provider`（来自上次 GLM 切换）覆盖了 env var，导致用 openai provider 连接 GLM 的 API → 请求失败。

2. **storage > env var 的优先级链错误**：`auth.ts` 和 `client.ts` 中 provider 解析使用 `customApiStorage.provider ?? getGlobalCompatProvider()`，storage 优先于 env var。start script 设置的 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 被持久化的旧值覆盖。

3. **`[1m]`/`[2m]` Context Window 指示器不显示**：`renderModelSetting()` 对 alias 直接返回 `capitalize(setting)`（如 `"Opus"`），绕过 `formatCustomModelLabel()`，导致 `(1M Context)` / `(2M Context)` 后缀丢失。`renderModelLabel()` 对 null + persisted model 路径也绕过格式化。

### 根本原因

#### 根因 1：`applyModelProfile()` 写入顶层凭据

**文件**: `src/utils/customApiStorage.ts` 第 277-285 行

```typescript
// 每次 /model 切换都写入顶层 provider/baseURL/apiKey/authTokenType
const current = readCustomApiStorage()
writeCustomApiStorage({
    ...current,
    model: profile.model,
    provider: profile.provider,        // ← 覆盖了上一个模型的 provider
    baseURL: profile.baseURL,          // ← 覆盖了上一个模型的 baseURL
    apiKey: profile.apiKey,            // ← 覆盖了上一个模型的 apiKey
    authTokenType: profile.authTokenType, // ← 覆盖了类型
})
```

`/model` 是会话切换操作，不应持久化凭据到顶层。只有 `/add-model`（显式保存）才能写顶层凭据。Profile 数据已存储在 `modelProfiles[]` 中，`/model` 切换时设置 `process.env` 即可，无需更新顶层 storage。

#### 根因 2：Provider 解析 storage > env var（共 4 处）

| 文件 | 行号 | 原代码 |
|------|------|--------|
| `auth.ts` | 264 | `customApiStorage.provider ?? (compatProviderEnv === ... ? compatProviderEnv : 'anthropic')` |
| `client.ts` | 103 | `readCustomApiStorage().provider ?? getGlobalCompatProvider()` |
| `claude.ts` | 538 | `customApiStorage.provider ?? getGlobalCompatProvider()` |
| `agent.ts` | 145 | `readCustomApiStorage().provider ?? getGlobalConfig().customApiEndpoint?.provider ?? 'anthropic'` |

全部使用 `storage ?? env` 优先级。start script 的 `CLAUDE_CODE_COMPATIBLE_API_PROVIDER` env var 被持久化 storage 覆盖。

> **注**：`claude.ts:1868` 已在 Chapter 23 修复（`envCompatProvider ? getGlobalCompatProvider() : storageFallback`），此处不变。

#### 根因 3：`renderModelSetting()` alias 早期返回绕过格式化

**文件**: `src/utils/model/model.ts` 第 377-385 行

```typescript
export function renderModelSetting(setting: ModelName | ModelAlias): string {
    if (setting === 'opusplan') return 'Opus Plan'
    if (isModelAlias(setting)) return capitalize(setting)  // ← 直接返回 "Opus"/"Sonnet"
    return renderModelName(setting)                        // ← 从未对 alias 调用!
}
```

`formatCustomModelLabel()`（通过 `renderModelName()` 调用）负责检测 `[1m]`/`[2m]` 后缀并添加 `(1M Context)`/`(2M Context)` 指示器。alias 路径完全绕过该格式化。

虽然 `useMainLoopModel()` 在调用 `renderModelSetting()` 之前通过 `parseUserSpecifiedModel()` 解析 alias，使 header 的正确性得以保留，但其他调用者可能直接使用未解析的 alias。

#### 根因 4：`renderModelLabel()` null+持久化模型路径绕过格式化

**文件**: `src/commands/model/model.tsx` 第 459-466 行

```typescript
if (model === null && persistedCustomModel) {
    return persistedCustomModel  // ← 原始 "deepseek-v4-pro[1m]"，不格式化!
}
```

当选择 Default 且有持久化模型时，返回原始存储的模型名（如 `"deepseek-v4-pro[1m]"`），不通过 `formatCustomModelLabel()` → 不显示 `(1M Context)`。

### 修复方案

#### 设计原则

```
/add-model  → 显式保存 → 写入顶层凭据 + 创建 ModelProfile
/model      → 会话切换 → 仅设置 env var + 更新 model 名 → 不写顶层凭据
start_.ps1  → 启动入口 → 设置 env var（真实数据源）
Storage     → 后备回退 → 仅当 env var 不存在时使用
```

#### 修复 1：`applyModelProfile()` 仅更新 model（`customApiStorage.ts`）

```typescript
// Before:
writeCustomApiStorage({
    ...current,
    model: profile.model,
    provider: profile.provider,
    baseURL: profile.baseURL,
    apiKey: profile.apiKey,
    authTokenType: profile.authTokenType,
})

// After:
writeCustomApiStorage({
    ...current,
    model: profile.model,
    // 顶层 provider/baseURL/apiKey/authTokenType 不在此更新
    // 由 /add-model 管理（显式保存），作为无 start script 启动时的后备
})
```

Profile 数据保留在 `modelProfiles[]` 中。`applyModelProfile()` 仍设置所有 `process.env` 变量用于当前会话。

#### 修复 2：Provider 优先级 env > storage（4 处）

**`auth.ts:263-270`**：
```typescript
// Before: storage ?? env
const customProvider = customApiStorage.provider ?? 
    (compatProviderEnv === 'openai' || compatProviderEnv === 'responses' ? compatProviderEnv : 'anthropic')

// After: env ?? storage
const customProvider =
    (compatProviderEnv === 'openai' || compatProviderEnv === 'responses' ? compatProviderEnv : undefined) ??
    customApiStorage.provider ??
    'anthropic'
```

**`client.ts:102-110`**：
```typescript
// Before: storage ?? env
const customApiProvider = readCustomApiStorage().provider ?? getGlobalCompatProvider()

// After: env ?? storage（getGlobalCompatProvider() 默认返回 'anthropic'，仅 non-default 值作为显式 env）
const envProvider = getGlobalCompatProvider()
const customApiProvider =
    (envProvider !== 'anthropic' ? envProvider : undefined) ??
    readCustomApiStorage().provider ??
    'anthropic'
```

**`claude.ts:538-541`**：
```typescript
// Before: storage ?? env
const compatProvider = customApiStorage.provider ?? getGlobalCompatProvider()

// After: env ?? storage
const compatProvider =
    getGlobalCompatProvider() !== 'anthropic'
        ? getGlobalCompatProvider()
        : customApiStorage.provider ?? 'anthropic'
```

**`agent.ts:144-152`**（之前完全缺失 env var 检查）：
```typescript
// Before: 仅 storage
const customApiProvider = readCustomApiStorage().provider ??
    getGlobalConfig().customApiEndpoint?.provider ?? 'anthropic'

// After: env ?? storage
const compatProviderEnv = process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
const customApiProvider =
    (compatProviderEnv === 'openai' || compatProviderEnv === 'responses' ? compatProviderEnv : undefined) ??
    readCustomApiStorage().provider ??
    getGlobalConfig().customApiEndpoint?.provider ??
    'anthropic'
```

#### 修复 3：`renderModelSetting()` 始终解析 + 格式化（`model.ts`）

```typescript
// Before:
if (isModelAlias(setting)) return capitalize(setting)

// After:
if (isModelAlias(setting)) return renderModelName(parseUserSpecifiedModel(setting))
```

现在 alias 被解析为具体模型名（如 `"deepseek-v4-pro[1m]"`），然后由 `renderModelName()` → `formatCustomModelLabel()` 添加 context window 指示器。

#### 修复 4：`renderModelLabel()` null 路径格式化（`model.tsx`）

```typescript
// Before:
if (model === null && persistedCustomModel) return persistedCustomModel

// After:
if (model === null && persistedCustomModel) return formatCustomModelLabel(persistedCustomModel)
```

新增 import：`formatCustomModelLabel` 从 `../../utils/model/model.js`。

#### 修复 5：No-profile 切换路径验证（`model.tsx`）

验证了 `handleSelect()` 和 `setModel()` 中全部 6 个切换路径，确认修复 1 后安全：

| 路径 | 条件 | Storage 写入 | 安全？ |
|------|------|-------------|--------|
| Profile 匹配 | `getModelProfile(model)` | 仅 `model`（修复 1） | ✓ |
| 已知 alias + 第三方 | `isKnownAlias` + custom API | `{ ...current, model }` | ✓ |
| 已知 alias + 原生 | `isKnownAlias` + firstParty | 显式清除凭据 | ✓ |
| 无 Profile | 不在上述范围内 | `{ ...current, model }` | ✓ |

`{ ...current, model }` 展开现在安全，因为 `applyModelProfile()` 不再写入顶层凭据 — `current` 持有最后 `/add-model`（显式保存）的凭据。

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/utils/customApiStorage.ts` | `applyModelProfile()` 从顶层 storage 写入中移除 `provider/baseURL/apiKey/authTokenType` |
| `src/utils/auth.ts` | Provider 解析：env > storage（`CLAUDE_CODE_COMPATIBLE_API_PROVIDER` 优先） |
| `src/services/api/client.ts` | Provider 解析：env > storage（与 auth.ts 一致） |
| `src/services/api/claude.ts` | Provider 解析：env > storage（流创建路径） |
| `src/utils/model/agent.ts` | Provider 解析：新增 env var 检查（之前完全缺失） |
| `src/utils/model/model.ts` | `renderModelSetting()`：alias 路径解析后再格式化 |
| `src/commands/model/model.tsx` | `renderModelLabel()`：null+持久化路径格式化；新增 `formatCustomModelLabel` import |

### Context Window 显示链

完整追踪从模型名到 header 显示的调用链：

```
CondensedLogo.tsx:26-27
  useMainLoopModel()                      → hooks/useMainLoopModel.ts:29-34
    parseUserSpecifiedModel(model)         → model.ts:498-559（解析 alias）
  renderModelSetting(resolvedModel)        → model.ts:377-385
    renderModelName(model)                 → model.ts:448-468
      formatCustomModelLabel(model)        → model.ts:440-446（[1m]/[2m] 检测）
```

规则：
- 模型中带 `[1m]` 后缀 → 显示 `"(1M Context)"`
- 模型中带 `[2m]` 后缀 → 显示 `"(2M Context)"`
- 无后缀 → 原样显示（GLM 等模型使用 `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` env var 代替）

### 验证步骤

1. `start_deepseek.ps1` → `/add-model deepseek-v4-pro[1m]` → 保存 profile
2. `start_glm.ps1` → `/add-model glm-5.1` → 保存 profile
3. `/model deepseek-v4-pro[1m]` → env var 切换到 DeepSeek，检查 `.credentials.json` 顶层不变
4. `/model glm-5.1` → env var 切换到 GLM，检查 `.credentials.json` 顶层不变
5. 退出，`start_deepseek.ps1` → 验证 DeepSeek API 正常（env var 覆盖 storage）
6. 退出，`start_glm.ps1` → 验证 GLM API 正常（env var 覆盖 storage）
7. `/model`（选择器）→ 验证 Opus/Sonnet/Haiku/Default 显示正确模型
8. 选择 'sonnet' → 主模型切换到 Sonnet-tier 模型，显示 `(1M Context)`
9. 选择 Default → header 正确显示带 context window 的模型名
10. `/model deepseek-v4-pro[1m]` 直接切换 → `/model` 命令输出显示 `(1M Context)`

### 影响范围

- 所有使用多个 `start_*.ps1` + `/add-model` + `/model` 多模型切换的用户
- 所有通过 start script 启动后使用 `/model` 切换模型的用户
- context window 指示器（`(1M Context)` / `(2M Context)`）正确显示在 header、ModelPicker、`/model` 命令输出中

---

---
## Chapter 27: 凭据错位修复 + effort 显示一致性修复

### 修复日期

2026-05-17

### 问题描述

Claude Opus 4.7 对 doge-code 模型管理系统进行了 16 项代码审计，发现以下 4 个需要修复的 Bug：

1. **凭据错位（审计项 3/4/7/10）**：`applyPersistedCustomApiEndpointEnv()` 启动时只读取 `.credentials.json` 顶层标量（provider/baseURL/apiKey），不查 `modelProfiles[]`。纯 `doge`（无 `start_.ps1`）重启时，顶层凭据属于最后添加的模型，而非当前活跃模型，导致 A 模型运行在 B 的 endpoint/key 上。

2. **applyModelProfile 不恢复 effort（审计项 14）**：`applyModelProfile()` 有明确注释故意不恢复 `CLAUDE_CODE_EFFORT_LEVEL`，`ModelProfile.effortLevel` 字段被采集但从不被应用（死数据）。`/model` 切换主模型后 effort 不会切到新模型的配置。

3. **effort 显示不一致（审计项 15）**：`getEffortSuffix()` 在 `resolveAppliedEffort` 返回 undefined 时返回空字符串，但 API 实际会默认使用 'high'。TUI 主面板不显示 "with high effort"，与实际 API 行为脱节。

4. **ModelPicker effort 初始化不读 env（审计项 15）**：`/model` 面板打开时，effort state 只从 `AppState.effortValue` 初始化，不读 `CLAUDE_CODE_EFFORT_LEVEL` env var。start script 配置了 `max` effort，但 picker 显示默认值 'high'。

### 修复方案

#### 1. 凭据错位修复（managedEnv.ts）

`applyPersistedCustomApiEndpointEnv()` 新增：当活跃模型有对应的 `ModelProfile` 时，从 profile 中应用完整的 provider/baseURL/apiKey/effortLevel/contextWindow。使用 env var 守卫（`!process.env.*`），不覆盖 start script 设置的环境变量。

```typescript
// managedEnv.ts — applyPersistedCustomApiEndpointEnv() 新增
const activeModel = process.env.ANTHROPIC_MODEL || customApiEndpoint?.model
if (activeModel) {
  const profile = getModelProfile(activeModel)
  if (profile) {
    if (profile.provider && !process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER) {
      process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = profile.provider
    }
    if (profile.baseURL && !process.env.ANTHROPIC_BASE_URL) {
      process.env.ANTHROPIC_BASE_URL = profile.baseURL
    }
    if (profile.apiKey && !process.env.DOGE_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      // ... apply key with correct authTokenType
    }
    if (profile.effortLevel && !process.env.CLAUDE_CODE_EFFORT_LEVEL) {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = profile.effortLevel
    }
    if (profile.contextWindow !== undefined && !process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOW) {
      process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOW = String(profile.contextWindow)
    }
  }
}
```

#### 2. applyModelProfile 恢复 effort（customApiStorage.ts）

移除 "Do NOT restore CLAUDE_CODE_EFFORT_LEVEL" 注释和跳过逻辑，改为正常应用。`resolveAppliedEffort()` 的优先级链（AppState.effortValue > env var）确保手动切换的 effort 不会被 profile 的 effort 覆盖。

#### 3. effort 显示默认值修复（effort.ts）

`getEffortSuffix()` 改为：只有当 env 显式设为 'unset' 时才返回空字符串；其他情况下，若 `resolveAppliedEffort` 返回 undefined，显示 'high'（与 API 默认行为一致）。

```typescript
// effort.ts — getEffortSuffix() 修改
const resolved = resolveAppliedEffort(model, effortValue)
if (resolved === undefined && process.env.CLAUDE_CODE_EFFORT_LEVEL?.toLowerCase() === 'unset') {
  return ''
}
const display = resolved ?? 'high'
return ` with ${convertEffortValueToLevel(display)} effort`
```

#### 4. ModelPicker effort 初始化修复（ModelPicker.tsx）

- 初始 effort state 增加 env override 回退：`effortValue ?? getEffortEnvOverride()`
- `handleFocus` 也检查 env override：当存在 env override 时优先使用，不覆盖为模型默认值

### 修改文件

- `src/utils/managedEnv.ts` — `applyPersistedCustomApiEndpointEnv()` 新增 profile-based credential recovery
- `src/utils/customApiStorage.ts` — `applyModelProfile()` 恢复 CLAUDE_CODE_EFFORT_LEVEL 应用
- `src/utils/effort.ts` — `getEffortSuffix()` 显示 high 作为 API 默认 effort fallback
- `src/components/ModelPicker.tsx` — effort 初始化和 handleFocus 读 env override

### 影响范围

- 所有使用纯 `doge`（无 `start_.ps1`）启动的多模型用户
- 所有依赖 start script effort 配置的用户
- TUI 主面板 effort 显示、`/model` picker effort 显示、右下角 effort 通知三处保持一致

---
## Chapter 28: Model Switcher 显示逻辑 + 配置同步修复

### 修复日期

2026-05-22

### 问题描述

根据 agents_debug_rec.md 中的 16 项代码审计，发现以下问题：

1. **ModelPicker 显示不完整**：`/model` 切换模型时没有正确显示 Default(recommended)、Opus、Sonnet、Haiku 子模型和主模型的完整列表
2. **子模型继承逻辑**：未显式设置子模型环境变量时，应该继承主模型配置
3. **remove-model TUI 删除功能**：需要支持通过上下选择并删除模型，或直接输入模型名删除
4. **配置文件同步**：`.claude.json`、`.credentials.json`、`.settings.json` 三个配置文件需要保持一致
5. **Context Window 指示**：TUI 主显示面板应正确显示 `(1M Context)` / `(2M Context)` 等上下文窗口信息


6. **effort 思考程度协调**：TUI 主面板、对话框右下角和 `/model` 切换面板中的 effort 显示需要保持一致

### 修复方案

#### 1. ModelPicker 显示逻辑修复（modelOptions.ts）

`getDefaultOptionForUser()` 针对自定义 API 用户（DeepSeek、GLM 等），Default(recommended) 选项现在正确显示 Sonnet tier 模型信息和价格。

```typescript
if (isCustomAPI) {
  const sonnetModel = getDefaultSonnetModel()
  const formattedSonnetModel = formatCustomModelLabel(sonnetModel)
  return {
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model Sonnet (currently ${formattedSonnetModel}) · ${formatModelPricing(COST_TIER_3_15)}`,
  }
}
```

#### 2. remove-model TUI 删除功能（remove-model/index.ts）

修复了 remove-model 命令的入口文件，将导入从 `./remove-model.js` 改为 `./remove-model.tsx`，启用交互式选择删除功能：
- 执行 `/remove-model` 不带参数时显示模型列表
- 支持上下选择并按 Enter 删除
- 支持直接输入模型名删除

#### 3. 配置文件同步修复（model.tsx）

`syncModelConfigToDisk()` 函数现在确保三个配置文件同步更新：

```typescript
function syncModelConfigToDisk(model: string, clearCredentials?: boolean): void {
  // 更新 .claude.json
  saveGlobalConfig(current => ({...}))
  
  // 更新 settings.json
  updateSettingsForSource('userSettings', { model })
  
  // 更新 .credentials.json
  const currentStorage = readCustomApiStorage()
  writeCustomApiStorage({...currentStorage, model, ...credsClear })
}
```

#### 4. Context Window 指示（model.ts）

`formatCustomModelLabel()` 和 `renderModelName()` 函数正确处理 `[1m]`/`[2m]` 后缀，添加 `(1M Context)`/`(2M Context)` 指示器。

#### 5. effort 思考程度协调

现有 `resolveAppliedEffort()` 实现了正确的优先级链：
- 环境变量 `CLAUDE_CODE_EFFORT_LEVEL` → AppState.effortValue → 模型默认值
- `getDisplayedEffortLevel()` 和 `getEffortSuffix()` 确保 TUI 各位置显示一致

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/utils/model/modelOptions.ts` | `getDefaultOptionForUser()` 自定义 API 用户显示优化 |
| `src/commands/remove-model/index.ts` | 修复入口文件导入 |
| `src/commands/model/model.tsx` | `syncModelConfigToDisk()` 三文件同步 |

### 影响范围

- 所有使用 `/model` 切换模型的用户
- 所有使用 `/remove-model` 删除模型的用户
- 配置文件一致性保障

---

## Chapter 29: ANTHROPIC_AUTH_TOKEN 认证修复 — API key 获取逻辑缺失 + 凭据加载顺序问题

### 修复日期

2026-05-22

### 问题描述

使用自定义 API（如 Qwen、DeepSeek、GLM）时，即使正确配置了 `ANTHROPIC_AUTH_TOKEN` 环境变量，API 请求仍然返回 `403 invalid api-key` 错误。

**关键发现**: 
1. `.credentials.json` 文件中顶层配置与 `modelProfiles` 中的配置不一致时，会使用错误的认证方式
2. `getAnthropicApiKeyWithSource()` 函数完全忽略了 `ANTHROPIC_AUTH_TOKEN` 环境变量

### 根本原因

**根因 1**: `auth.ts` 中 `getAnthropicApiKeyWithSource()` 函数只检查 `DOGE_API_KEY`，忽略 `ANTHROPIC_AUTH_TOKEN`

```typescript
// 原代码：只检查 DOGE_API_KEY
const apiKeyEnv = isRunningOnHomespace()
  ? undefined
  : process.env.DOGE_API_KEY  // ← 问题：忽略了 ANTHROPIC_AUTH_TOKEN
```

**根因 2**: `managedEnv.ts` 中凭据加载顺序错误

顶层凭据先于 profile 凭据被加载，导致 profile 中的正确配置无法覆盖顶层的错误配置。

### 修复方案

**修复 1**: 修改 `auth.ts` 中 `getAnthropicApiKeyWithSource()` 函数

```typescript
// 修复：同时检查 DOGE_API_KEY 和 ANTHROPIC_AUTH_TOKEN
const apiKeyEnv = isRunningOnHomespace()
  ? undefined
  : process.env.DOGE_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
```

**修复 2**: 修改 `managedEnv.ts` 中 `applyPersistedCustomApiEndpointEnv()` 的加载顺序

```typescript
// 先尝试加载 profile 凭据
if (profile.apiKey && !process.env.DOGE_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  ...
  hasProfileCredentials = true
}

// 只有当 profile 没有提供凭据时，才使用顶层凭据作为 fallback
if (!hasProfileCredentials) {
  // 加载顶层凭据
  ...
}
```

**修复 3**: 恢复 `client.ts` 中 `configureApiKeyHeaders()` 函数的原始逻辑

```typescript
const token =
  process.env.ANTHROPIC_AUTH_TOKEN ||
  (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
if (token) {
  headers['Authorization'] = `Bearer ${token}`
}
```

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/utils/auth.ts` | `getAnthropicApiKeyWithSource()` 添加对 `ANTHROPIC_AUTH_TOKEN` 的检查 |
| `src/utils/managedEnv.ts` | 凭据加载顺序修复：profile 优先于顶层 |
| `src/services/api/client.ts` | 恢复 `configureApiKeyHeaders()` 对 `ANTHROPIC_AUTH_TOKEN` 的处理 |

### 影响范围

- 所有使用 `ANTHROPIC_AUTH_TOKEN` 环境变量的自定义 API 用户（Qwen、DeepSeek、GLM 等）
- 所有通过 `/add-model` 添加的第三方模型
- 多模型切换场景下的凭据正确性保障

---

## Chapter 30: Effort 参数传递修复 — OpenAI 兼容路径丢失 effort

### 修复日期

2026-05-22

### 问题描述

effort 参数在 OpenAI 兼容 API 路径中完全丢失，导致自定义 API 模型（如 DeepSeek）无法收到 effort 参数。

### 根本原因

**文件**: `src/services/api/claude.ts` 第 1880-1888 行

当使用 OpenAI 兼容 API（如 DeepSeek）时，`convertAnthropicRequestToOpenAI()` 函数没有接收 `output_config` 参数：

```typescript
const openAIRequest = convertAnthropicRequestToOpenAI({
  model: params.model,
  system: params.system,
  messages: params.messages,
  tools: params.tools,
  tool_choice: params.tool_choice,
  temperature: params.temperature,
  max_tokens: params.max_tokens,
  // 没有传递 output_config！effort 丢失了！
})
```

### 修复方案

**修复 1**: 修改 `claude.ts`，传递 `output_config`：

```typescript
const openAIRequest = convertAnthropicRequestToOpenAI({
  ...,
  output_config: params.output_config,
})
```

**修复 2**: 修改 `openaiCompat.ts`，添加 `output_config` 参数支持：

```typescript
export function convertAnthropicRequestToOpenAI(input: {
  ...
  output_config?: { effort?: string }
}): OpenAIChatRequest {
  return {
    ...,
    ...(input.output_config?.effort ? { effort: input.output_config.effort } : {}),
  }
}
```

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/services/api/claude.ts` | OpenAI 兼容请求添加 `output_config` 参数 |
| `src/services/api/openaiCompat.ts` | 添加 `output_config` 参数支持并传递 effort |

### 影响范围

- 所有使用 OpenAI 兼容 API 的用户（DeepSeek 等）
- effort 参数现在会正确传递给第三方模型

---

## Chapter 30.1: Responses API Effort 参数传递修复

### 修复日期

2026-05-24

### 问题描述

与 OpenAI 兼容 API 一样，`responses` provider 的 API 请求也丢失了 effort 参数，导致模型永远使用默认的思考程度。

### 根本原因

**文件**: `src/services/api/responsesCompat.ts`

`convertAnthropicRequestToResponses()` 函数的输入参数和返回类型都没有包含 `output_config`/`effort` 字段，导致 effort 参数在转换过程中丢失。

同时，`claude.ts` 中调用 `convertAnthropicRequestToResponses()` 时也没有传递 `output_config` 参数。

### 修复方案

**修复 1**: 修改 `responsesCompat.ts`，添加 `output_config` 参数支持：

```typescript
export function convertAnthropicRequestToResponses(input: {
  ...
  output_config?: { effort?: string }
}): ResponsesRequest {
  return {
    ...,
    ...(input.output_config?.effort ? { effort: input.output_config.effort } : {}),
  }
}
```

**修复 2**: 修改 `claude.ts`，传递 `output_config` 参数：

```typescript
const responsesRequest = convertAnthropicRequestToResponses({
  ...,
  output_config: params.output_config,
})
```

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/services/api/responsesCompat.ts` | 添加 `output_config` 参数支持并传递 effort |
| `src/services/api/claude.ts` | Responses 请求添加 `output_config` 参数 |

### 影响范围

- 所有使用 responses 兼容 API 的用户
- effort 参数现在会正确传递给 responses 格式的第三方模型

---

## Chapter 31: Max Effort 支持修复 — 自定义 API 模型无法使用 max effort

### 修复日期

2026-05-22

### 问题描述

用户配置了 `effortLevel: "max"`，但 TUI 显示的仍然是 `high effort`。自定义 API 模型（如 Qwen、DeepSeek、GLM）无法使用 `max` effort 级别。

### 根本原因

**文件**: `src/utils/effort.ts` 第 70-71 行

`modelSupportsMaxEffort()` 函数检查条件不完整：

```typescript
// 原代码：只检查第三方提供商
if (getAPIProvider() !== 'firstParty' && matchesTierModel(model)) {
  return true
}
```

当使用自定义 API 端点（`ANTHROPIC_BASE_URL`）时，`getAPIProvider()` 仍然返回 `'firstParty'`，导致条件不满足，无法支持 `max` effort。

### 修复方案

修改 `modelSupportsMaxEffort()` 函数，同时检查自定义 API 端点：

```typescript
const isCustomApi = process.env.ANTHROPIC_BASE_URL && !isFirstPartyAnthropicBaseUrl()
if ((getAPIProvider() !== 'firstParty' || isCustomApi) && matchesTierModel(model)) {
  return true
}
```

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/utils/effort.ts` | `modelSupportsMaxEffort()` 添加自定义 API 支持 + 导入 `isFirstPartyAnthropicBaseUrl` |

### 影响范围

- 所有使用自定义 API 端点的用户（Qwen、DeepSeek、GLM 等）
- 配置了 `max` effort 的模型配置

---

## Chapter 31: Effort 配置同步修复

### 修复日期

2026-05-22

### 问题描述

`/model` 切换模型后，思考程度（effort）无法保持与环境配置一致。启动脚本（`start_.ps1`）中设置的 `CLAUDE_CODE_EFFORT_LEVEL` 环境变量在切换模型时被无条件覆盖或删除。

### 根本原因

**文件**: `src/utils/customApiStorage.ts` 第 273 行

`applyModelProfile()` 函数无条件调用 `applyEnvVar('CLAUDE_CODE_EFFORT_LEVEL', profile.effortLevel)`，当 profile 中没有设置 `effortLevel` 时，会**删除**环境变量，导致启动脚本设置的全局配置丢失。

### 修复方案

修改 `applyModelProfile()` 函数，只在 profile 明确设置了 `effortLevel` 时才更新环境变量：

```typescript
// 修复前：无条件覆盖
applyEnvVar('CLAUDE_CODE_EFFORT_LEVEL', profile.effortLevel)

// 修复后：仅在 profile 明确设置时才更新
if (profile.effortLevel !== undefined) {
  applyEnvVar('CLAUDE_CODE_EFFORT_LEVEL', profile.effortLevel)
}
```

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/utils/customApiStorage.ts` | `applyModelProfile()` 函数添加 effortLevel 条件检查 |

### 影响范围

- 所有使用 `CLAUDE_CODE_EFFORT_LEVEL` 环境变量设置默认思考程度的用户
- 多模型切换场景下的 effort 一致性保障

---

## Chapter 31: syncModelConfigToDisk 凭据同步修复

### 修复日期

2026-05-22

### 问题描述

`.credentials.json` 文件存储出现严重不一致：
- 顶层 `model` 显示为 "qwen3.7-max[1m]"
- 但顶层凭据（provider/baseURL/apiKey）却是 GLM 的
- `savedModels` 和 `modelProfiles` 中只有 deepseek，没有 qwen

### 根本原因

**文件**: `src/commands/model/model.tsx` 中的 `syncModelConfigToDisk` 函数

当切换模型时，该函数只更新 `model` 字段，没有同时更新顶层的 provider/baseURL/apiKey 等凭据信息：

```typescript
function syncModelConfigToDisk(model: string, clearCredentials?: boolean): void {
  // 只更新了 model 字段
  writeCustomApiStorage({
    ...currentStorage,
    model,
    ...credsClear,
  })
}
```

### 修复方案

修改 `syncModelConfigToDisk` 函数，使其从当前模型的 profile 中读取并同步完整的凭据信息：

```typescript
function syncModelConfigToDisk(model: string, clearCredentials?: boolean): void {
  const profile = getModelProfile(model)
  
  let credsUpdate = {}
  if (clearCredentials) {
    credsUpdate = { provider: undefined, ... }
  } else if (profile) {
    // 如果模型有profile，从profile中读取完整的凭据信息
    credsUpdate = {
      provider: profile.provider,
      baseURL: profile.baseURL,
      apiKey: profile.apiKey,
      authTokenType: profile.authTokenType,
    }
  }
  
  // 同步更新所有三个配置文件
  ...
}
```

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/commands/model/model.tsx` | `syncModelConfigToDisk` 函数添加凭据同步逻辑 |

### 影响范围

- 所有使用 `/model` 切换模型的用户
- 多模型切换场景下的凭据一致性保障

---

## 修改时间日志

- 凭据覆盖修复 + env>storage 优先级 + Context Window 显示修复（Ch26）：2026-05-14
- 凭据错位修复 + effort 显示一致性修复（Ch27）：2026-05-17
- Model Switcher 显示逻辑 + 配置同步修复（Ch28）：2026-05-22
- ANTHROPIC_AUTH_TOKEN 认证修复（Ch29）：2026-05-22
- syncModelConfigToDisk 凭据同步修复（Ch30）：2026-05-22

# Doge Code 修复日志（上篇：Chapter 1-10）

本文档汇总了 Doge Code 项目中 API 兼容性、上下文窗口、自动压缩、Agent 模型选择和 Computer Use Windows 平台支持等修复记录。

下篇（Chapter 11-21）见 `debug_updates_2.md`。

---

## Chapter 1: 自定义 API 登录流程修复

### 问题描述

使用自定义 OpenAI 兼容 API（如 DeepSeek）时，系统仍要求进行 API 密钥审批流程，无法直接使用 `DOGE_API_KEY` 环境变量进行认证。

### 解决方法

修改认证逻辑，当检测到自定义 API 提供商时，跳过 API 密钥审批流程，直接使用环境变量中的密钥。

### 修改的文件

- `src/utils/auth.ts`
- `src/services/api/client.ts`

### 代码修改对比

#### `src/utils/auth.ts`

**修改前**：标准 Anthropic 认证流程，所有请求都需要审批。

**修改后**：

```typescript
// 检测自定义提供商
const customProvider = customApiStorage.provider ?? getGlobalCompatProvider()
const isFirstParty = isFirstPartyAnthropicBaseUrl()

// 跳过审批条件
if (effectiveApiKeyEnv && (customProvider === 'openai' || customProvider === 'responses' || !isFirstParty)) {
  return {
    apiKey: effectiveApiKeyEnv,
    source: 'DOGE_API_KEY'
  }
}
```

#### `src/services/api/client.ts`

**修改前**：`getGlobalCompatProvider()` 函数未导出，导致循环依赖问题。

**修改后**：

```typescript
// 导出函数供其他模块使用
export function getGlobalCompatProvider(): 'anthropic' | 'openai' | 'responses' {
  const provider = process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER
  if (provider === 'openai') return 'openai'
  if (provider === 'responses') return 'responses'
  return 'anthropic'
}
```

---

## Chapter 2: OpenAI 兼容 API 路径与 max_tokens 限制修复

### 问题描述

1. OpenAI 兼容 API 使用了错误的请求路径
2. DeepSeek API 的 `max_tokens` 限制为 8192，但系统默认请求 32000，导致 API 返回错误

### 解决方法

1. 使用标准的 `/v1/chat/completions` 路径
2. 自动检测 DeepSeek API 并将 `max_tokens` 限制为 8192

### 修改的文件

- `src/services/api/openaiCompat.ts`

### 代码修改对比

**修改前**：

```typescript
// 路径处理不一致
// max_tokens 无限制，可能导致 DeepSeek API 报错
```

**修改后**：

```typescript
// 使用标准 OpenAI 路径
const path = '/v1/chat/completions'

// DeepSeek max_tokens 限制, 里面的 max_tokens 限制为 8192，可以调整为 32000(deepseek v4等新模型上下文长度更大)
if (maxTokens && maxTokens > 8192 && process.env.ANTHROPIC_BASE_URL?.includes('deepseek')) {
  maxTokens = 8192
}
```

---

## Chapter 3: Responses API 兼容层新增

### 问题描述

部分 API 网关使用 Anthropic Responses API 格式（`/v1/responses`），而非标准的 Messages API 或 OpenAI Chat Completions API。

### 解决方法

新增 `responses` provider 类型，实现完整的 Responses API 兼容层，包括请求格式转换和流式事件翻译。

### 修改的文件

- `src/services/api/responsesCompat.ts`（新建）
- `src/services/api/claude.ts`
- `src/services/api/openaiCompat.ts`
- `src/services/api/client.ts`
- `src/utils/customApiStorage.ts`
- `src/utils/config.ts`
- `src/utils/auth.ts`

### 代码修改对比

#### `src/services/api/responsesCompat.ts`（新建）

```typescript
// Responses API 流式事件翻译
const EVENT_MAP = {
  'response.output_text.delta': 'content_block_delta',
  'response.output_item.added': 'content_block_start',
  'response.function_call_arguments.delta': 'content_block_delta',
  'response.output_item.done': 'content_block_stop',
  'response.completed': 'message_stop',
  'response.incomplete': 'message_stop',
  'response.failed': 'message_stop'
}
```

#### `src/services/api/claude.ts`

```typescript
// 扩展 provider 支持
if (compatProvider === 'openai') {
  yield* streamOpenAICompat(...)
} else if (compatProvider === 'responses') {
  yield* streamResponsesCompat(...)
}
```

#### 类型定义扩展

```typescript
// 支持 'anthropic' | 'openai' | 'responses' 三种 provider
type CompatibleAPIProvider = 'anthropic' | 'openai' | 'responses'
```

---

## Chapter 4: 第三方模型上下文窗口检测修复

### 问题描述

使用第三方 API（DeepSeek、GLM、Gemini 等）时，系统无法正确识别模型的真实上下文窗口大小，导致：

1. 自动压缩阈值计算错误
2. 即使调整环境变量也无效
3. 容易触发 API 的上下文长度限制错误

### 根本原因

`modelCapabilities` 系统只支持第一方 Anthropic API。对于第三方 API，`getModelCapability()` 返回 `undefined`，系统回退到默认的 200k 上下文窗口，而实际模型可能只有 128k 甚至更少。

### 解决方法

采用双层方案：
1. **硬编码常见第三方模型**：自动识别 DeepSeek、GLM、Gemini、GPT-4 等模型
2. **通用环境变量覆盖**：新增 `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` 环境变量

### 修改的文件

- `src/utils/context.ts`
- `start_deepseek.ps1`
- `start_gemini.ps1`
- `start_glm.ps1`

### 代码修改对比

#### `src/utils/context.ts`

**修改前**：

```typescript
export function getContextWindowForModel(model: string, betas?: string[]): number {
  // ant用户环境变量
  if (process.env.USER_TYPE === 'ant' && process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    return parseInt(...)
  }
  // ... 其他检测
  return MODEL_CONTEXT_WINDOW_DEFAULT  // 200k - 第三方模型错误地使用此值
}
```

**修改后**：

```typescript
export function getContextWindowForModel(model: string, betas?: string[]): number {
  // 新增：通用环境变量覆盖（最高优先级）
  const envContextWindow = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOW
  if (envContextWindow) {
    const parsed = parseInt(envContextWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }

  // ant用户环境变量
  // ...

  // 新增：第三方模型硬编码配置
  const modelLower = model.toLowerCase()
  if (modelLower.includes('deepseek')) return 102_400
  if (modelLower.includes('glm-5') || modelLower.includes('glm5')) return 200_000
  if (modelLower.includes('gemini-1.5') || modelLower.includes('gemini-2.') || modelLower.includes('gemini-3')) return 1_000_000
  if (modelLower.includes('gpt-4-turbo') || modelLower.includes('gpt-4o')) return 128_000
  if (modelLower.includes('gpt-3.5-turbo-16k')) return 16_385
  if (modelLower.includes('gpt-3.5-turbo')) return 4_096

  // ... 原有检测逻辑
  return MODEL_CONTEXT_WINDOW_DEFAULT
}
```

### 环境变量优先级

从高到低：
1. `CLAUDE_CODE_MODEL_CONTEXT_WINDOW` - 通用覆盖（新增）
2. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` - ant用户专用
3. 硬编码的第三方模型配置（新增）
4. `[1m]` 后缀检测
5. `modelCapabilities` API检测
6. Beta headers
7. 默认值 200k

---

## Chapter 5: DeepSeek 上下文窗口精确修复

### 问题描述

用户设置了 `CLAUDE_CODE_MODEL_CONTEXT_WINDOW=100000`，系统仍发送了 105,295 tokens 的请求，DeepSeek API 返回错误：

```
This model's maximum context length is 102400 tokens.
```

### 根本原因

硬编码值为 100,000，但实际 API 限制是 102,400 tokens。

### 解决方法

将 DeepSeek 的硬编码值从 100,000 调整为 102,400。

### 修改的文件

- `src/utils/context.ts`

### 代码修改对比

**修改前**：

```typescript
// DeepSeek series - 100k context window (API actual limit is 102400 tokens)
if (modelLower.includes('deepseek')) {
  return 100_000
}
```

**修改后**：

```typescript
// DeepSeek series - 102400 tokens context window (API actual limit)
if (modelLower.includes('deepseek')) {
  return 102_400
}
```

### 自动压缩阈值计算

| 项目 | 修复前 (100k) | 修复后 (102.4k) |
|------|--------------|----------------|
| 上下文窗口 | 100,000 | 102,400 |
| 输出预留 | 20,000 | 20,000 |
| 有效窗口 | 80,000 | 82,400 |
| 自动压缩阈值 | 67,000 | 69,400 |
| 安全边界 | 35,400 | 33,000 |

---

## Chapter 6: 自动压缩 Token 计数修复

### 问题描述

即使上下文窗口配置正确，自动压缩仍未触发，导致对话增长到 97k tokens 时仍报错。

### 根本原因

`openaiCompat.ts` 第 322 行只在第一个 chunk 读取 `prompt_tokens`：

```typescript
if (!started) {
  started = true
  promptTokens = chunk.usage?.prompt_tokens ?? 0  // DeepSeek 第一个 chunk 没有 usage
}
```

DeepSeek 流式响应只在**最后一个 chunk**（带 `finish_reason`）报告 usage，第一个 chunk 没有 usage 数据。因此：

1. `promptTokens` 始终为 0
2. `tokenCountWithEstimation()` 返回极小的值
3. `shouldAutoCompact()` 认为远低于阈值 → 永不触发压缩

### 解决方法

1. 在每个 chunk 中持续更新 `promptTokens` 和 `completionTokens`
2. 在 `message_delta` 事件中包含 `input_tokens`

### 修改的文件

- `src/services/api/openaiCompat.ts`

### 代码修改对比

**修改前**：

```typescript
if (!started) {
  started = true
  promptTokens = chunk.usage?.prompt_tokens ?? 0  // 只在第一个 chunk 读
  yield { type: 'message_start', ... }
}

// ... 后续 chunk 不更新 promptTokens

yield {
  type: 'message_delta',
  usage: {
    output_tokens: completionTokens,
    // 没有 input_tokens
  }
}
```

**修改后**：

```typescript
// 在每个 chunk 中持续更新 usage
if (chunk.usage?.prompt_tokens !== undefined && chunk.usage.prompt_tokens > 0) {
  promptTokens = chunk.usage.prompt_tokens
}
if (chunk.usage?.completion_tokens !== undefined && chunk.usage.completion_tokens > 0) {
  completionTokens = chunk.usage.completion_tokens
}

if (!started) {
  started = true
  // 不再只在这里读取 promptTokens
  yield { type: 'message_start', ... }
}

// ... message_delta 事件
yield {
  type: 'message_delta',
  usage: {
    input_tokens: promptTokens,  // 新增！
    output_tokens: completionTokens,
  }
}
```

### 修复后的数据流

```
chunk 1 (无 usage):
  → promptTokens = 0
  → yield message_start { input_tokens: 0 }

chunk N (finish_reason + usage { prompt_tokens: 90000 }):
  → promptTokens = 90000   ← 从 usage 更新
  → yield message_delta { input_tokens: 90000, output_tokens: 2000 }

claude.ts 中 updateUsage():
  → input_tokens: 90000 > 0 → 更新！

tokenCountWithEstimation():
  → 返回 92000 → 超过阈值 → 触发自动压缩
```

---

## 附录：支持的第三方模型配置

| 模型系列 | 上下文窗口 | 匹配规则 |
|---------|-----------|---------|
| DeepSeek | 102,400 | 包含 "deepseek" |
| GLM-5.x | 200,000 | 包含 "glm-5" 或 "glm5" |
| Gemini 1.5/2.x/3.x | 1,000,000 | 包含 "gemini-1.5" / "gemini-2." / "gemini-3" |
| GPT-4 Turbo | 128,000 | 包含 "gpt-4-turbo" |
| GPT-4o | 128,000 | 包含 "gpt-4o" |
| GPT-3.5 Turbo 16k | 16,385 | 包含 "gpt-3.5-turbo-16k" |
| GPT-3.5 Turbo | 4,096 | 包含 "gpt-3.5-turbo" |

---

## 附录：自动压缩阈值计算公式

```
有效窗口 = 上下文窗口 - 20,000（输出预留）
自动压缩阈值 = 有效窗口 - 13,000（缓冲区）
```

示例（DeepSeek 102.4k）：
```
有效窗口 = 102,400 - 20,000 = 82,400
自动压缩阈值 = 82,400 - 13,000 = 69,400
→ 对话超过 69,400 tokens 时自动触发压缩
```

---

## Chapter 7: Agent 模型选择 Fallback 机制修复

### 问题描述

**发现日期**：2026-04-08  
**严重程度**：高  
**影响范围**：所有使用 Agent 工具的场景

当用户只配置了一个模型（如 `claude-opus-4-6`）时，创建不同层级的 Agent 会出现以下问题：

1. **模型名"捏造"问题**：Agent 显示 `claude-sonnet-4-6` 或 `claude-haiku-4-5-20251001`，但用户配置中没有这些模型
2. **单一模型 API 无法使用**：当 API 只支持一个模型时，调用其他层级的 Agent 会失败
3. **显示名与实际不一致**：显示的模型名与实际 API 调用使用的模型不匹配

#### 问题场景

```typescript
// 用户配置
{
  "model": "claude-opus-4-6"  // 只有 Opus 访问权限
}

// Agent 调用
Agent(
  subagent_type="general-purpose",
  model="haiku"  // 显式指定 Haiku
)

// 结果：API 调用失败
// getDefaultHaikuModel() 返回 "claude-haiku-4-5-20251001"
// 但 API 不支持该模型 ❌
```

### 根本原因

三个模型默认函数缺少 fallback 机制：
- `getDefaultOpusModel()` - 硬编码返回 `claude-opus-4-6`
- `getDefaultSonnetModel()` - 硬编码返回 `claude-sonnet-4-6`
- `getDefaultHaikuModel()` - 硬编码返回 `claude-haiku-4-5-20251001`

**问题逻辑流程**：
```
用户配置: { "model": "claude-opus-4-6" }
         ↓
Agent 指定: model="haiku"
         ↓
调用: getDefaultHaikuModel()
         ↓
返回: "claude-haiku-4-5-20251001" (硬编码)
         ↓
API 调用失败 ❌ (API 只支持 Opus)
```

#### 为什么之前没发现

默认情况下，Agent 使用 `inherit` 模式，会继承父模型，所以大多数情况不会触发这个 bug：

```typescript
// src/utils/model/agent.ts 第27-29行
export function getDefaultSubagentModel(): string {
  return 'inherit'  // 默认继承，不会调用 getDefault*Model()
}
```

### 解决方法

在三个模型默认函数中添加 fallback 机制，优先级顺序：

1. **环境变量覆盖** (`ANTHROPIC_DEFAULT_*_MODEL`)
2. **用户配置的主模型** (settings.json 或 ANTHROPIC_MODEL)
3. **硬编码默认值** (原有逻辑)

### 修改的文件

- `src/utils/model/model.ts`

### 代码修改对比

#### getDefaultOpusModel()

**修改前**：
```typescript
export function getDefaultOpusModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().opus46
  }
  return getModelStrings().opus46
}
```

**修改后**：
```typescript
export function getDefaultOpusModel(): ModelName {
  // 1. 环境变量优先
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }

  // 2. BUGFIX: Fallback 到用户配置的主模型
  // 直接读取 settings 避免循环依赖
  const settings = getSettings_DEPRECATED() || {}
  const userModel = process.env.ANTHROPIC_MODEL || settings.model
  if (userModel) {
    return userModel
  }

  // 3. 硬编码默认值
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().opus46
  }
  return getModelStrings().opus46
}
```

#### getDefaultSonnetModel() 和 getDefaultHaikuModel()

采用相同的修复模式，添加 fallback 到用户配置的主模型。

### 关键修复点

1. **避免循环依赖**：
   - 不调用 `getUserSpecifiedModelSetting()`（会触发解析）
   - 不调用 `parseUserSpecifiedModel()`（会递归调用 getDefault*Model）
   - 直接读取 `process.env.ANTHROPIC_MODEL` 和 `settings.model`

2. **保持原始值**：
   - 返回原始配置值，不进行别名解析
   - 让 `parseUserSpecifiedModel()` 在更高层处理别名

3. **向后兼容**：
   - 不影响已有的环境变量配置
   - 不影响硬编码默认值的使用场景

### 修复后的调用链

```
Agent(model="sonnet")
  → parseUserSpecifiedModel("sonnet")
    → getDefaultSonnetModel()
      → 检查 ANTHROPIC_DEFAULT_SONNET_MODEL ❌ (未配置)
        → 读取 settings.model = "deepseek-chat" ✅
          → 返回 "deepseek-chat" ✅ (正确 fallback)
```

### 测试验证

#### 场景 1：单一模型配置
```json
{ "model": "deepseek-chat" }
```

| 函数调用 | 返回值 | 结果 |
|---------|--------|------|
| getDefaultOpusModel() | deepseek-chat | ✅ 正确 fallback |
| getDefaultSonnetModel() | deepseek-chat | ✅ 正确 fallback |
| getDefaultHaikuModel() | deepseek-chat | ✅ 正确 fallback |
| parseUserSpecifiedModel('opus') | deepseek-chat | ✅ |
| parseUserSpecifiedModel('sonnet') | deepseek-chat | ✅ |
| parseUserSpecifiedModel('haiku') | deepseek-chat | ✅ |

#### 场景 2：三层模型映射
```json
{
  "model": "claude-opus-4-6",
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "GLM-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "GLM-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "GLM-4.5-air"
  }
}
```

| 函数调用 | 返回值 | 结果 |
|---------|--------|------|
| getDefaultOpusModel() | GLM-5.1 | ✅ 环境变量优先 |
| getDefaultSonnetModel() | GLM-5.1 | ✅ 环境变量优先 |
| getDefaultHaikuModel() | GLM-4.5-air | ✅ 环境变量优先 |

#### 场景 3：部分映射
```json
{
  "model": "deepseek-chat",
  "env": {
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "custom-haiku"
  }
}
```

| 函数调用 | 返回值 | 结果 |
|---------|--------|------|
| getDefaultOpusModel() | deepseek-chat | ✅ fallback 到主模型 |
| getDefaultSonnetModel() | deepseek-chat | ✅ fallback 到主模型 |
| getDefaultHaikuModel() | custom-haiku | ✅ 环境变量优先 |

### 使用建议

#### 强制所有层级使用同一模型

如果你的 API 只支持一个模型，或者想强制所有 Agent 使用同一模型：

```json
{
  "model": "claude-opus-4-6",
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4-6"
  }
}
```

或在启动脚本中：
```powershell
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-opus-4-6"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-opus-4-6"
```

#### 使用不同层级的模型

如果你的 API 支持多个模型，可以配置不同层级：

```json
{
  "model": "claude-opus-4-6",
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

#### 自动 Fallback（推荐）

如果不配置环境变量，系统会自动 fallback 到主模型：

```json
{
  "model": "deepseek-chat"
}
```

所有 Agent 层级都会自动使用 `deepseek-chat`。
```typescript
export function getDefaultSonnetModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}
```

**修改后**：
```typescript
export function getDefaultSonnetModel(): ModelName {
  // 1. 环境变量优先
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }

  // 2. BUGFIX: Fallback 到用户配置的主模型
  const userModel = getUserSpecifiedModelSetting()
  if (userModel !== undefined && userModel !== null) {
    return parseUserSpecifiedModel(userModel)
  }

  // 3. 硬编码默认值
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}
```

#### getDefaultHaikuModel()

**修改前**：
```typescript
export function getDefaultHaikuModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }
  return getModelStrings().haiku45
}
```

**修改后**：
```typescript
export function getDefaultHaikuModel(): ModelName {
  // 1. 环境变量优先
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }

  // 2. BUGFIX: Fallback 到用户配置的主模型
  const userModel = getUserSpecifiedModelSetting()
  if (userModel !== undefined && userModel !== null) {
    return parseUserSpecifiedModel(userModel)
  }

  // 3. 硬编码默认值
  return getModelStrings().haiku45
}
```

### 修复后的行为

#### 场景1：用户只有 Opus 访问权限

**配置**：
```json
{
  "model": "claude-opus-4-6"
}
```

**Agent 调用**：
```typescript
Agent(model="haiku")
```

**修复前**：
```
getDefaultHaikuModel() → "claude-haiku-4-5-20251001" → API 失败 ❌
```

**修复后**：
```
getDefaultHaikuModel() → 检查用户配置 → "claude-opus-4-6" → API 成功 ✅
```

#### 场景2：使用环境变量配置三层模型

**配置**：
```json
{
  "model": "claude-opus-4-6",
  "env": {
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "GLM-4.5-air",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "GLM-5.1",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "GLM-5.1"
  }
}
```

**行为**：环境变量优先级最高，直接返回配置的模型 ID ✅

#### 场景3：默认行为（inherit）

**配置**：
```json
{
  "model": "claude-opus-4-6"
}
```

**Agent 调用**：
```typescript
Agent()  // 不指定 model，默认 inherit
```

**行为**：继承父模型，不调用 `getDefault*Model()`，行为不变 ✅

### 影响评估

#### 兼容性
- ✅ 向后兼容：不影响现有行为
- ✅ 默认行为不变：inherit 模式仍然是默认
- ✅ 环境变量优先级保持不变

#### 性能
- 影响极小：只在显式指定模型时多调用一次 `getUserSpecifiedModelSetting()`
- 该函数已被缓存，性能开销可忽略

#### 安全性
- ✅ 不引入新的安全风险
- ✅ 遵循现有的权限和配置机制

### 测试建议

#### 测试用例1：单一模型 API
```bash
# 配置只支持 Opus 的 API
export ANTHROPIC_MODEL="claude-opus-4-6"
export ANTHROPIC_BASE_URL="your-api-endpoint"

# 测试 Agent 显式指定其他模型
doge
> 创建一个使用 haiku 模型的子任务
```

**期望**：子任务使用 Opus 模型，不报错

#### 测试用例2：环境变量覆盖
```bash
# 配置三层模型映射
export ANTHROPIC_MODEL="claude-opus-4-6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="custom-haiku-model"
export ANTHROPIC_DEFAULT_SONNET_MODEL="custom-sonnet-model"

# 测试 Agent
doge
> 创建使用 haiku 的子任务
```

**期望**：子任务使用 `custom-haiku-model`

#### 测试用例3：默认行为
```bash
# 标准配置
export ANTHROPIC_MODEL="claude-opus-4-6"

# 测试 Agent 不指定模型
doge
> 创建一个子任务（不指定模型）
```

**期望**：子任务继承 Opus 模型

### 相关文件

- `src/utils/model/model.ts` - 主要修改文件
- `src/utils/model/agent.ts` - Agent 模型选择逻辑
- `src/utils/settings/settings.ts` - 配置读取
- `C:\Users\jsr\.doge\settings.json` - 用户配置文件

### 详细文档

完整的修复说明和测试用例请参考：`BUGFIX_MODEL_FALLBACK.md`

### 补充修复：循环依赖问题（2026-04-08）

#### 问题发现

在实际测试中发现，即使用户配置了自定义模型（如 `deepseek-chat`），Agent 仍然会"捏造"出 `claude-sonnet-4-6` 等硬编码模型。

#### 根本原因

初始修复方案使用了 `getUserSpecifiedModelSetting()` 和 `parseUserSpecifiedModel()`，但这导致了循环依赖：

```typescript
getDefaultMainLoopModelSetting()
  → getDefaultSonnetModel()
    → getUserSpecifiedModelSetting()
      → 返回 undefined (初始化中)
        → fallback 失效
          → 返回硬编码的 "claude-sonnet-4-6" ❌
```

#### 最终解决方案

**直接读取配置源，避免循环依赖**：

```typescript
export function getDefaultSonnetModel(): ModelName {
  // 1. 环境变量优先
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }

  // 2. 直接读取配置源，避免循环依赖
  const settings = getSettings_DEPRECATED() || {}
  const userModel = process.env.ANTHROPIC_MODEL || settings.model
  if (userModel) {
    return userModel  // 返回原始ID，不解析别名
  }

  // 3. 硬编码默认值
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}
```

**关键改进**：
- 不调用 `getUserSpecifiedModelSetting()` - 避免循环
- 不调用 `parseUserSpecifiedModel()` - 避免无限递归
- 直接读取 `process.env.ANTHROPIC_MODEL` 和 `settings.model`
- 返回原始模型ID，不进行别名解析

#### 修复效果

**修复前**：
```
配置: { "model": "deepseek-chat" }
→ Agent 仍使用硬编码的 "claude-sonnet-4-6" → API 失败 ❌
```

**修复后**：
```
配置: { "model": "deepseek-chat" }
→ 所有 Agent 层级自动 fallback 到 deepseek-chat ✅
```

---

## Chapter 8: Computer Use Windows 平台支持

### 问题描述

**发现日期**：2026-04-24
**严重程度**：高（功能性缺失）
**影响范围**：所有 Windows 用户使用 Computer Use 功能

Computer Use 功能原本仅支持 macOS（通过 Swift CGEventTap + TCC 权限系统），在 Windows 平台上存在以下严重问题：

1. **TCC 权限面板误触发**：`ensureOsPermissions()` 在 Windows 上返回 `granted: false`，导致 MCP 包显示 macOS 专属的 TCC 权限面板（辅助功能 + 屏幕录制），在 Windows 上完全无用
2. **应用发现不完整**：`listInstalled()` 仅扫描注册表，遗漏了大量非注册表安装的应用（如联想应用商店安装的网易云音乐、便携式应用等）
3. **中文编码乱码**：PowerShell 输出的中文应用名显示为乱码
4. **ESC 安全中止缺失**：macOS 使用 CGEventTap 实现全局 ESC 中止，Windows 没有对应实现
5. **UIPI 权限隔离未处理**：Windows UIPI 机制阻止低 IL 进程向高 IL 窗口发送 SendMessage，缺少检测和回退机制
6. **类型定义不完整**：`ensureOsPermissions` 返回类型仅支持 macOS TCC 格式

### 解决方法

采用分层方案，在不影响 macOS 功能的前提下为 Windows 添加完整支持：

#### 修复 1：权限检查平台适配（hostAdapter.ts + types.ts + toolCalls.ts）

**核心问题**：Windows 没有 TCC 系统，但代码假设所有平台都使用 macOS 的辅助功能/屏幕录制权限模型。

**修改方案**：
- `hostAdapter.ts`：Windows 平台直接返回 `{ granted: true }`，UIPI 检查在每次操作时进行
- `types.ts`：扩展 `ensureOsPermissions` 返回类型，支持 Windows 的 `{ granted: false; platform?: string; reason?: string }` 格式
- `toolCalls.ts`：添加平台判断，Windows 显示管理员提权提示而非 TCC 面板

**修改的文件**：

- `src/utils/computerUse/hostAdapter.ts`
- `packages/@ant/computer-use-mcp/src/types.ts`
- `packages/@ant/computer-use-mcp/src/toolCalls.ts`

##### 修改对比

###### `src/utils/computerUse/hostAdapter.ts`

**修改前**：

```typescript
ensureOsPermissions: async () => {
  if (process.platform === 'darwin') {
    const cu = requireComputerUseSwift()
    const accessibility = (cu as any).tcc.checkAccessibility()
    const screenRecording = (cu as any).tcc.checkScreenRecording()
    return accessibility && screenRecording
      ? { granted: true }
      : { granted: false, accessibility, screenRecording }
  }
  // 其他平台未处理
}
```

**修改后**：

```typescript
ensureOsPermissions: async () => {
  if (process.platform === 'darwin') {
    const cu = requireComputerUseSwift()
    const accessibility = (cu as any).tcc.checkAccessibility()
    const screenRecording = (cu as any).tcc.checkScreenRecording()
    return accessibility && screenRecording
      ? { granted: true }
      : { granted: false, accessibility, screenRecording }
  }

  // Windows: no TCC system — always grant at this level.
  // UIPI/elevation checks happen per-operation in platforms/win32.ts
  if (process.platform === 'win32') {
    return { granted: true }
  }

  // Linux: no permission system needed
  return { granted: true }
}
```

###### `packages/@ant/computer-use-mcp/src/types.ts`

**修改前**：

```typescript
ensureOsPermissions(): Promise<
  | { granted: true }
  | { granted: false; accessibility: boolean; screenRecording: boolean }
>;
```

**修改后**：

```typescript
ensureOsPermissions(): Promise<
  | { granted: true }
  | { granted: false; accessibility: boolean; screenRecording: boolean }
  | { granted: false; platform?: string; reason?: string; [key: string]: unknown }
>;
```

###### `packages/@ant/computer-use-mcp/src/toolCalls.ts`

**修改前**：

```typescript
if (!osPerms.granted) {
  if (name !== "request_access" && name !== "request_teach_access") {
    return errorResult(
      "Accessibility and Screen Recording permissions are required.",
      "tcc_not_granted"
    );
  }
  tccState = {
    accessibility: osPerms.accessibility,
    screenRecording: osPerms.screenRecording,
  };
}
```

**修改后**：

```typescript
if (!osPerms.granted) {
  if (name !== "request_access" && name !== "request_teach_access") {
    const platformHint = osPerms.platform === 'win32'
      ? "Elevated permissions are required. Run your terminal as Administrator and try again."
      : "Accessibility and Screen Recording permissions are required.";
    return errorResult(platformHint, "tcc_not_granted");
  }
  // macOS: thread TCC state for the permission panel
  // Windows/Linux: skip TCC panel, proceed to app selection directly
  if ('accessibility' in osPerms && 'screenRecording' in osPerms) {
    tccState = {
      accessibility: osPerms.accessibility,
      screenRecording: osPerms.screenRecording,
    };
  }
}
```

---

#### 修复 2：应用发现增强（platforms/win32.ts）

**核心问题**：`listInstalled()` 仅扫描注册表的 `Uninstall` 键，遗漏了：
- 联想应用商店等第三方商店安装的应用
- 便携式应用（无需安装，解压即用）
- 开始菜单中手动添加的快捷方式

**修改方案**：扩展 `listInstalled()` 为四层扫描 + UTF-8 编码。

##### 扫描层次

| 层级 | 来源 | 覆盖场景 |
|------|------|----------|
| 1 | 注册表 `HKLM/HKCU\...\Uninstall\*` | 标准 MSI/EXE 安装的应用 |
| 2 | `Get-AppxPackage` | Microsoft Store (UWP/MSIX) 应用 |
| 3 | 开始菜单 `.lnk` 快捷方式 | 非注册表安装的应用（便携式、第三方商店） |
| 4 | `Get-StartApps` | Windows 开始菜单固定/推荐的应用 |

##### 编码修复

```powershell
# 修复前：中文应用名显示为乱码（无编码设置，使用默认 GBK/GB2312）
# 修复后：强制 UTF-8 输出
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

**修改的文件**：`src/utils/computerUse/platforms/win32.ts`（`listInstalled()` 函数）

---

#### 修复 3：ESC 安全中止（win32/escHook.ts + escHotkey.ts）

**核心问题**：Computer Use 的安全机制要求用户可以随时按 ESC 中止操作。macOS 通过 CGEventTap 实现，Windows 没有对应实现。

**修改方案**：使用 Windows `WH_KEYBOARD_LL` 低级键盘钩子，在后台 PowerShell 进程中运行，通过 Named Pipe 通信。

**架构**：

```
[Bun/Node.js 主进程]
       ↕ Named Pipe ("cu-esc-hook")
[PowerShell 后台进程]
       ↕ SetWindowsHookEx(WH_KEYBOARD_LL)
[Windows 内核]
       ↕ 键盘输入 → 用户按下 ESC
```

**关键设计决策**：

| 决策 | 原因 |
|------|------|
| 后台 PowerShell 进程 | WH_KEYBOARD_LL 需要消息循环，Node.js/Bun 单线程无法提供 |
| Named Pipe 通信 | 进程间通信最简方案，无需额外依赖 |
| 250ms 轮询间隔 | 平衡响应速度和 CPU 开销 |
| 只读钩子（不消费按键） | Windows 钩子仅监听 ESC 事件，不拦截按键 |

**修改的文件**：

- `src/utils/computerUse/win32/escHook.ts`（新建，~230行）
- `src/utils/computerUse/escHotkey.ts`（修改，添加 Windows 分支）

---

#### 修复 4：UIPI 权限隔离检测与回退（win32/elevation.ts + platforms/win32.ts）

**核心问题**：Windows UIPI (User Interface Privilege Isolation) 阻止低完整性级别 (IL) 的进程向高 IL 窗口发送 `SendMessage`。

**修改方案**：
1. 新建 `elevation.ts` 模块，检测进程和窗口的 IL
2. 在 `platforms/win32.ts` 中添加 `ensureSendAccess()` 检查
3. 所有输入操作（click/typeText/key/keys）自动回退到全局 `SendInput`

**UIPI 检测流程**：

```
首次输入操作 → ensureSendAccess()
    ↓ (sendMessageOk === null)
testSendMessage(hwnd) → PowerShell P/Invoke: SendMessage(WM_NULL)
    ↓
成功 → sendMessageOk = true → 后续使用 SendMessage
失败 → sendMessageOk = false → 后续使用 SendInput 回退
```

**修改的文件**：

- `src/utils/computerUse/win32/elevation.ts`（新建，~280行）
- `src/utils/computerUse/platforms/win32.ts`（修改，添加 `ensureSendAccess()` 和回退逻辑）

##### elevation.ts 核心接口

```typescript
export type IntegrityLevel = 'low' | 'medium' | 'high' | 'system' | 'unknown'

export interface ElevationStatus {
  currentIL: IntegrityLevel   // 当前进程完整性级别
  isAdmin: boolean            // 是否以管理员运行
  uacEnabled: boolean         // UAC 是否启用
}

export interface WindowILCheck {
  il: IntegrityLevel          // 目标窗口完整性级别
  canSendMessages: boolean    // 是否能 SendMessage
  blockedReason?: string      // 阻止原因
}

// 核心函数
export function getCurrentProcessIL(): IntegrityLevel
export function getProcessIL(pid: number): IntegrityLevel
export function getElevationStatus(): ElevationStatus
export function checkWindowAccess(hwnd: number): WindowILCheck
export function testSendMessage(hwnd: number): boolean
export function getElevationGuidance(status: ElevationStatus): string
```

##### platforms/win32.ts UIPI 回退模式

```typescript
let sendMessageOk: boolean | null = null

function ensureSendAccess(): boolean {
  if (!boundHwnd) return false
  if (sendMessageOk === null) {
    sendMessageOk = checkSendMessageAccess(boundHwnd)
  }
  return sendMessageOk
}

// click/typeText/key/keys 中统一使用此模式：
async click(x, y, button) {
  if (boundHwnd) {
    if (ensureSendAccess()) {
      getWm().sendClick(boundHwnd, x, y, button)  // SendMessage 优先
      return
    }
    // UIPI 阻止 — 回退到全局 SendInput
    ps(`...SetCursorPos...SendInput...`)
    return
  }
}
```

---

#### 修复 5：typeText 字符注入安全修复（platforms/win32.ts）

**核心问题**：原始 `typeText` 实现将字符直接插入 PowerShell 脚本字符串（`'${ch}'`），存在代码注入风险。

**修改方案**：使用 `charCodeAt()` 获取字符的数字编码，通过 `VkKeyScan([char]${vk})` 在 PowerShell 侧转换为虚拟键码。

**修改前**：

```typescript
// 危险：字符直接插入 PowerShell 字符串
for (const ch of text) {
  ps(`${WIN32_TYPES}; [CuWin32]::keybd_event('${ch}', ...)`)
}
```

**修改后**：

```typescript
// 安全：使用字符编码
for (const ch of text) {
  const vk = ch.charCodeAt(0)
  if (vk < 0x20 || vk > 0x7e) {
    ps(`${WIN32_TYPES}; [CuWin32]::keybd_event([byte]0, ${vk}, 0, [UIntPtr]::Zero)`)
  } else {
    ps(`${WIN32_TYPES}; $vk = [CuWin32]::VkKeyScan([char]${vk}); ...`)
  }
}
```

---

### 修改文件总览

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/utils/computerUse/hostAdapter.ts` | 修改 | Windows 平台返回 `granted: true` |
| `packages/@ant/computer-use-mcp/src/types.ts` | 修改 | 扩展 `ensureOsPermissions` 返回类型 |
| `packages/@ant/computer-use-mcp/src/toolCalls.ts` | 修改 | 平台感知的权限检查 + 管理员提权提示 |
| `src/utils/computerUse/platforms/win32.ts` | 修改 | UIPI 回退 + 四层应用扫描 + UTF-8 编码 + 字符注入修复 |
| `src/utils/computerUse/escHotkey.ts` | 修改 | 跨平台 ESC 热键注册 |
| `src/utils/computerUse/win32/escHook.ts` | 新建 | WH_KEYBOARD_LL ESC 安全中止（~230行） |
| `src/utils/computerUse/win32/elevation.ts` | 新建 | UIPI/完整性级别检测（~280行） |

### Windows Computer Use 架构

```
用户请求 "打开应用"
       ↓
MCP toolCalls.ts → ensureOsPermissions()
       ↓ (Windows: granted: true)
request_access → listInstalled() → 四层扫描
       ↓ (应用列表 → 授权对话框)
open_application → open() → 启动进程 → 绑定 HWND
       ↓
输入操作 (click/type/key)
       ↓
ensureSendAccess() → UIPI 检测
       ↓
SendMessage 可达 → sendClick/sendText/sendKey（窗口绑定，不干扰用户桌面）
SendMessage 受阻 → SendInput/keybd_event（全局回退，需前台窗口）
       ↓
截图 → PrintWindow (HWND 绑定) / CopyFromScreen (全局)
```

### 测试验证

#### 测试场景：连续打开多个应用

```
request_access(["网易云音乐", "UU加速器", "Visual Studio Code"])
# → 三个应用全部授权成功（通过开始菜单快捷方式 + Get-StartApps 发现）

open_application("网易云音乐")      # ✅ 启动成功
open_application("UU加速器")        # ✅ 启动成功
open_application("Visual Studio Code")  # ✅ 启动成功（click 权限层级）
```

---

## Chapter 9: DeepSeek reasoning_content 多轮透传修复

### 问题描述

**发现日期**：2026-04-24
**严重程度**：高（功能性阻塞）
**影响范围**：所有使用 DeepSeek V4 Pro 模型进行多轮工具调用的场景（Computer Use / MCP / Agent）

使用 DeepSeek V4 Pro 模型时，多轮工具调用（如 Computer Use 的 `list_granted_applications`、`screenshot` 等）稳定报 400 错误：

```
OpenAI compatible request failed with status 400:
{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.",
"type":"invalid_request_error"}}
```

单轮对话（普通问答）不受影响，只有涉及多轮工具调用的场景才会触发。

### 根本原因

DeepSeek V4 Pro 的 API 在流式响应中返回 `reasoning_content` 字段（思考链内容），并且要求：

1. **第一轮**：API 响应的 SSE chunk 中包含 `delta.reasoning_content`（模型思考过程）
2. **第二轮**：客户端必须将上一轮的 `reasoning_content` 原样传回 API 请求的 assistant 消息中

但 `openaiCompat.ts` 中的流式解析器完全忽略了 `reasoning_content`：

```typescript
// 修改前：createAnthropicStreamFromOpenAI() 只处理 delta.content 和 delta.tool_calls
if (delta?.content) { /* 处理文本 */ }
for (const toolCall of delta?.tool_calls ?? []) { /* 处理工具调用 */ }
// delta.reasoning_content 被完全忽略 → 丢失
```

第二轮请求构建时，`convertAnthropicRequestToOpenAI()` 也不包含 `reasoning_content`：

```typescript
// 修改前：assistant 消息只提取 text 和 tool_use 块
const text = blocks.filter(b => b.type === 'text').map(...)
const toolCalls = blocks.filter(b => b.type === 'tool_use').map(...)
messages.push({ role: 'assistant', content: text, tool_calls: toolCalls })
// reasoning_content 缺失 → DeepSeek API 报 400 错误
```

**数据丢失路径**：
```
DeepSeek 响应: delta.reasoning_content = "思考中..."
         ↓
openaiCompat.ts: 忽略 reasoning_content ← 丢失！
         ↓
claude.ts: 流式事件中无 reasoning 数据
         ↓
下一轮请求: convertAnthropicRequestToOpenAI() → 无 reasoning_content
         ↓
DeepSeek API: 检测到 reasoning_content 缺失 → 400 错误 ❌
```

### 解决方法

利用 Anthropic 原生的 `thinking` 内容块机制，将 DeepSeek 的 `reasoning_content` 透明传递：

1. **捕获阶段**：在流式解析器中，将 `delta.reasoning_content` 作为 Anthropic `thinking` 内容块发出
2. **存储阶段**：`claude.ts` 中已有的 thinking 处理器自动将 thinking 块存储在 `AssistantMessage.message.content` 中
3. **回传阶段**：在 `convertAnthropicRequestToOpenAI()` 中，从 thinking 块提取文本，转换回 DeepSeek 所需的 `reasoning_content` 格式

**修复后的数据流**：
```
DeepSeek 响应: delta.reasoning_content = "思考中..."
         ↓
openaiCompat.ts: 发出 thinking 内容块事件 (content_block_start/delta/stop)
         ↓
claude.ts: thinking 处理器自动存储 → AssistantMessage.message.content 包含 thinking 块
         ↓
消息管道: normalizeMessagesForAPI() → assistantMessageToMessageParam() → thinking 块保留
         ↓
convertAnthropicRequestToOpenAI(): 提取 thinking 块 → 转换为 reasoning_content
         ↓
DeepSeek API: 收到 reasoning_content → 正常处理 ✅
```

### 为什么 thinking 块不会被过滤

消息管道中有三个 thinking 块过滤函数，但都不影响本修复：

| 过滤函数 | 行为 | 为什么不影响 |
|---------|------|-------------|
| `filterTrailingThinkingFromLastAssistant` | 移除末尾的 thinking 块 | DeepSeek 的 reasoning 在 content 之前，不在末尾 |
| `filterOrphanedThinkingOnlyMessages` | 移除只有 thinking 的消息 | 消息还有 text/tool_use 块，不是 thinking-only |
| `stripSignatureBlocks` | 凭证变更后移除 thinking 块 | 仅在凭证变更时触发，正常流程不触发 |

### 修改的文件

- `src/services/api/openaiCompat.ts`

### 代码修改对比

#### 1. 类型定义扩展

**修改前**：

```typescript
type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      role?: 'assistant'
      content?: string | null
      tool_calls?: Array<{ ... }>
    }
  }>
}
```

**修改后**：

```typescript
type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  reasoning_content?: string  // 新增：DeepSeek reasoning 透传
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

type OpenAIStreamChunk = {
  choices?: Array<{
    delta?: {
      role?: 'assistant'
      content?: string | null
      reasoning_content?: string | null  // 新增：DeepSeek 流式 reasoning
      tool_calls?: Array<{ ... }>
    }
  }>
}
```

#### 2. 流式解析器 — 捕获 reasoning_content 并发出 thinking 事件

**修改前**：

```typescript
// createAnthropicStreamFromOpenAI() 中只有这些变量
let emittedAnyContent = false
const toolCallState = new Map<...>()

// 直接处理 delta.content
if (delta?.content) { /* 文本事件 */ }
for (const toolCall of delta?.tool_calls ?? []) { /* 工具调用事件 */ }
```

**修改后**：

```typescript
// 新增 reasoning 追踪变量
let emittedAnyContent = false
let reasoningStarted = false      // reasoning 内容块是否已开始
let reasoningContentIndex: number | null = null  // reasoning 块的 content index
let reasoningClosed = false       // reasoning 块是否已关闭
const toolCallState = new Map<...>()

// 处理 DeepSeek reasoning_content — 以 thinking 内容块形式发出
if (delta?.reasoning_content) {
  if (!reasoningStarted) {
    reasoningStarted = true
    reasoningContentIndex = nextContentIndex
    nextContentIndex++
    yield {
      type: 'content_block_start',
      index: reasoningContentIndex,
      content_block: { type: 'thinking', thinking: '' },
    }
  }
  yield {
    type: 'content_block_delta',
    index: reasoningContentIndex ?? 0,
    delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
  }
  emittedAnyContent = true
}

// 切换到 content/tool_calls 时自动关闭 reasoning 块
if (reasoningStarted && !reasoningClosed &&
    (delta?.content || (delta?.tool_calls && delta.tool_calls.length > 0))) {
  reasoningClosed = true
  yield { type: 'content_block_stop', index: reasoningContentIndex ?? 0 }
}

// 原有处理
if (delta?.content) { /* 文本事件 */ }
for (const toolCall of delta?.tool_calls ?? []) { /* 工具调用事件 */ }
```

#### 3. finish_reason 处理 — 关闭未关闭的 reasoning 块

**修改前**：

```typescript
if (choice?.finish_reason) {
  if (!emittedAnyContent) { /* 占位文本块 */ }
  // 关闭 text/tool_use 块
  // 发出 message_delta / message_stop
}
```

**修改后**：

```typescript
if (choice?.finish_reason) {
  // 新增：关闭仍未关闭的 reasoning 块（边缘情况：reasoning 后无 content/tool_calls）
  if (reasoningStarted && !reasoningClosed) {
    reasoningClosed = true
    yield { type: 'content_block_stop', index: reasoningContentIndex ?? 0 }
  }
  if (!emittedAnyContent) { /* 占位文本块 */ }
  // 关闭 text/tool_use 块
  // 发出 message_delta / message_stop
}
```

#### 4. 请求构建 — 从 thinking 块提取 reasoning_content 回传

**修改前**：

```typescript
if (message.role === 'assistant') {
  const blocks = Array.isArray(message.content) ? ... : []
  const text = blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')

  const toolCalls = blocks
    .filter(block => block.type === 'tool_use')
    .map(...)

  messages.push({
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  })
}
```

**修改后**：

```typescript
if (message.role === 'assistant') {
  const blocks = Array.isArray(message.content) ? ... : []
  const text = blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')

  // 新增：从 thinking 块提取 reasoning_content（DeepSeek 兼容）
  const reasoningText = blocks
    .filter(block => block.type === 'thinking')
    .map(block => typeof block.thinking === 'string' ? block.thinking : '')
    .join('')

  const toolCalls = blocks
    .filter(block => block.type === 'tool_use')
    .map(...)

  messages.push({
    role: 'assistant',
    content: text || null,
    ...(reasoningText ? { reasoning_content: reasoningText } : {}),  // 新增！
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  })
}
```

### 关键设计决策

| 决策 | 原因 |
|------|------|
| 使用 `thinking` 内容块存储 reasoning | 复用 `claude.ts` 已有的 thinking 处理管道，无需修改上游代码 |
| reasoning 块在 content 之前发出 | DeepSeek SSE 流的 `reasoning_content` 先于 `content` 到达 |
| 切换到 content 时关闭 reasoning 块 | 避免多个 `content_block_stop` 事件冲突 |
| 使用空字符串作为 thinking 块的 signature | Anthropic API 要求 signature 字段，但 OpenAI 请求路径不经过 Anthropic API |
| 不修改 `claude.ts` | thinking 块管道已完善，只需在 openaiCompat.ts 两端做转换 |

### 影响评估

#### 兼容性
- ✅ 向后兼容：GLM、Gemini 等不返回 `reasoning_content` 的模型不受影响
- ✅ 不影响 Anthropic 原生 provider
- ✅ 不影响 Responses API provider
- ✅ 已有的 thinking 块处理流程不受影响

#### 性能
- 影响极小：仅多一个 `delta.reasoning_content` 判断和 thinking 块事件

#### 安全性
- ✅ reasoning_content 仅透传，不做任何修改
- ✅ 不引入新的安全风险

### 测试验证

#### 测试场景 1：DeepSeek V4 Pro + Computer Use 多轮调用

```
1. 启动 CLI: start_deepseek.ps1
2. 请求: "请用 Computer Use 打开网易云音乐"
3. 首轮: model 返回 reasoning + text + tool_use(list_granted_applications)
4. 二轮: tool result 传回 → model 返回 reasoning + text + tool_use(open_application)
5. 三轮: tool result 传回 → model 返回 reasoning + text

期望结果：
- 修复前：第二轮或第三轮报 400 "reasoning_content must be passed back"
- 修复后：所有轮次正常，reasoning_content 正确透传 ✅
```

#### 测试场景 2：GLM-5.1 模型 + Computer Use

```
1. 启动 CLI: start_glm.ps1
2. 请求: "请用 Computer Use 打开网易云音乐"
3. GLM 不返回 reasoning_content → 无 thinking 块生成

期望结果：行为与修复前完全一致，不受影响 ✅
```

#### 测试场景 3：DeepSeek 普通问答

```
1. 启动 CLI: start_deepseek.ps1
2. 请求: "什么是量子计算？"
3. 单轮问答，不涉及工具调用

期望结果：正常响应，不受影响 ✅
```

### 相关文件

- `src/services/api/openaiCompat.ts` - 唯一修改的文件
- `src/services/api/claude.ts` - 未修改，但 thinking 块处理管道是本修复的基础
- `src/utils/messages.ts` - 未修改，thinking 块过滤函数不影响本修复

---

## Chapter 10: Computer Use Windows 稳定性修复

### 问题描述

Computer Use 在 Windows 上存在三个严重问题：

1. **Zoom 卡死**：多次调用 `zoom` 工具后整个事件循环冻结，所有后续操作无响应
2. **点击坐标丢失**：所有点击操作都落在窗口左上角 (0,0)，无法点击按钮、播放音乐等
3. **窗口不可手动操作**：`open_application` 打开的窗口被移到屏幕外 (-32000,-32000)，用户完全看不到也操作不了（无法最大化/最小化/手动点击）

### 根因分析

#### 根因 1：窗口被移到屏幕外 (最关键)

**文件**: `src/utils/computerUse/platforms/win32.ts` `open()` 方法

原代码在找到窗口 HWND 后执行：
```powershell
[CuPos]::SetWindowPos([IntPtr]$hwnd, [IntPtr]::Zero, -32000, -32000, 0, 0, ...)
```
将窗口移到 (-32000,-32000) 坐标，用户完全看不到窗口，无法手动操作。

**设计意图**：模拟 macOS 的窗口隐藏行为，让自动化操作不干扰用户桌面。
**实际问题**：Windows 没有 macOS 的 SCContentFilter 等效机制，直接把窗口移到屏幕外导致用户完全失去对窗口的控制。

#### 根因 2：点击坐标被硬编码为 (0,0)

**文件**: `src/utils/computerUse/executor.ts` 第 369-370 行

原代码：
```typescript
mouseButton: (btn, a, count) =>
  p.click(0, 0, btn), // simplified — real coords handled by caller via moveMouse
```

这是为 macOS 设计的架构：macOS 上先 `moveMouse(x, y)` 移动真实光标，再 `mouseButton()` 在光标位置点击（无需坐标）。但 Windows HWND-bound 模式下 `moveMouse` 是空操作（no-op），SendMessage 使用客户区坐标，所以坐标被完全丢弃。

**调用链**：
```
toolCalls.ts scaleCoord(x=500, y=300)
  → executor.ts click(500, 300)
    → moveAndSettle(500, 300) → moveMouse(500, 300) → no-op (HWND bound)
    → mouseButton('left') → p.click(0, 0, 'left') ← 坐标丢失！
```

#### 根因 3：Bun.spawnSync 无 timeout

**文件**: 多个 win32 模块

`PrintWindow` 是同步阻塞的 Win32 API，通过 `Bun.spawnSync()` 调用 PowerShell 执行。当目标窗口忙碌（正在处理其他消息、调整大小、有模态对话框等），`PrintWindow` 会无限等待，导致整个 Bun 事件循环卡死。

#### 根因 4：captureRegion 忽略裁剪参数

**文件**: `src/utils/computerUse/platforms/win32.ts` `captureRegion()` 方法

当 HWND 绑定时，`captureRegion(x, y, w, h)` 忽略了 (x, y, w, h) 参数，每次都调用 `captureWindow()` 重新进行完整的 PrintWindow 截图。zoom 操作本应只裁剪局部区域，却触发了完整的窗口截图。

#### 根因 5：ESC hook 重叠 spawn

**文件**: `src/utils/computerUse/win32/escHook.ts`

`setInterval(250ms)` 每 250ms spawn 一个 PowerShell 进程读取命名管道。如果上一次 spawn 尚未完成（管道竞争或 PS 进程卡住），新的 spawn 会继续创建，累积僵尸进程。

### 解决方法

#### 修复 1：窗口保持正常位置（不再移到屏幕外）

**文件**: `src/utils/computerUse/platforms/win32.ts` `open()` 方法

删除 `SetWindowPos(-32000, -32000)` 及其 CuPos 类型定义。窗口保持正常位置显示：
- 用户可以看到并手动操作窗口（最大化/最小化/点击）
- `PrintWindow` 截图不依赖窗口位置，无论窗口在何处都能正常工作
- `SendMessage` 使用客户区坐标，不受窗口位置影响
- DWM 绿色边框指示器正常显示

```powershell
# 修改前：移到屏幕外
[CuPos]::SetWindowPos([IntPtr]$hwnd, ..., -32000, -32000, ...) | Out-Null

# 修改后：保持正常位置
# Keep the window at its normal position — user can see and interact with it.
# PrintWindow captures work regardless of window position/occlusion.
# SendMessage uses client-area coordinates, so position doesn't matter.
```

#### 修复 2：坐标透传（不再丢弃为 0,0）

**文件**: `src/utils/computerUse/executor.ts` `getInput()` 闭包

保存 `moveMouse` 的最后坐标，在 `mouseButton` 中使用：

```typescript
// 修改前
const getInput = () => ({
  moveMouse: (x, y, _animated) => p.moveMouse(x, y),
  mouseButton: (btn, a, count) => p.click(0, 0, btn), // 坐标丢失
})

// 修改后
let lastMouseX = 0, lastMouseY = 0
const getInput = () => ({
  moveMouse: (x, y, _animated) => { lastMouseX = x; lastMouseY = y; return p.moveMouse(x, y) },
  mouseButton: (btn, a, count) => p.click(lastMouseX, lastMouseY, btn), // 坐标保留
})
```

macOS 路径不受影响（`isDarwin` 分支直接使用 `requireComputerUseInput()`）。

#### 修复 3：所有 Bun.spawnSync 加 timeout

为所有 win32 模块的 PowerShell 调用添加超时：

| 文件 | timeout | 用途 |
|------|---------|------|
| `windowCapture.ts` `runPs()` | 15000ms | PrintWindow 截图 |
| `win32.ts` `ps()` | 10000ms | 全局 PS 调用 |
| `win32.ts` `psAsync()` | 15000ms (setTimeout+kill) | 异步 PS 调用 |
| `windowMessage.ts` `runPs()` | 8000ms | SendMessage 输入 |
| `windowBorder.ts` `ps()` | 5000ms | DWM 边框设置 |
| `escHook.ts` pipe read | 3000ms | ESC 检测 |
| `elevation.ts` `runPs()` | 8000ms | UIPI 检测 |
| `windowEnum.ts` | 8000ms | 窗口枚举 |
| `comExcel.ts` `ps()` | 8000ms | COM Excel 操作 |
| `comWord.ts` `runPs()` | 8000ms | COM Word 操作 |
| `ocr.ts` `runPs()` | 8000ms | OCR 识别 |
| `uiAutomation.ts` `ps()` | 8000ms | UI Automation |

#### 修复 4：点击前发送 WM_MOUSEMOVE

**文件**: `src/utils/computerUse/win32/windowMessage.ts` `sendClick()`

许多 Windows 应用（尤其是 Chromium/Electron 应用）期望在 `WM_LBUTTONDOWN` 之前收到 `WM_MOUSEMOVE`，用于跟踪悬停状态和激活控件。添加后：

```typescript
// 修改前：只有 DOWN + UP
[WinMsg]::SendMessage($hwnd, WM_LBUTTONDOWN, 0, $lp)
[WinMsg]::SendMessage($hwnd, WM_LBUTTONUP, 0, $lp)

// 修改后：MOVE + DOWN + UP
[WinMsg]::SendMessage($hwnd, 0x0200, 0, $lp)  // WM_MOUSEMOVE
[WinMsg]::SendMessage($hwnd, WM_LBUTTONDOWN, 0, $lp)
[WinMsg]::SendMessage($hwnd, WM_LBUTTONUP, 0, $lp)
```

#### 修复 5：Zoom 使用截图缓存裁剪

**文件**: `src/utils/computerUse/platforms/win32.ts`

新增截图缓存机制，避免 zoom 每次都重新 PrintWindow：

```typescript
// 缓存结构
let cachedScreenshot: { base64: string; width: number; height: number; ts: number } | null = null
const SCREENSHOT_CACHE_TTL = 500 // 500ms 内复用缓存

// captureRegion 改造
async captureRegion(x, y, w, h) {
  if (boundHwnd) {
    // 缓存过期时重新 PrintWindow
    if (!cachedScreenshot || (now - cachedScreenshot.ts) > SCREENSHOT_CACHE_TTL) {
      cachedScreenshot = { ...captureWindow(), ts: now }
    }
    // 从缓存裁剪，不重新截图
    return cropScreenshot(cachedScreenshot, x, y, w, h)
  }
}
```

`cropScreenshot()` 使用 .NET `System.Drawing.Graphics.DrawImage()` 裁剪，比重新 PrintWindow 快 10 倍以上。在 `bindWindow()` 时自动清除缓存。

#### 修复 6：ESC hook 重叠 spawn 防护

**文件**: `src/utils/computerUse/win32/escHook.ts`

```typescript
// 修改前：无保护
setInterval(async () => {
  const result = Bun.spawnSync(...)  // 可能与上一次重叠
}, 250)

// 修改后：pipeBusy 守卫
let pipeBusy = false
setInterval(async () => {
  if (pipeBusy) return  // 上一次尚未完成，跳过
  pipeBusy = true
  try { const result = Bun.spawnSync(...) }
  finally { pipeBusy = false }
}, 250)
```

### 修改的文件汇总

| 文件 | 修改内容 |
|------|---------|
| `src/utils/computerUse/platforms/win32.ts` | 删除 SetWindowPos(-32000)；captureRegion 缓存裁剪；ps/psAsync 加 timeout |
| `src/utils/computerUse/executor.ts` | getInput() 坐标透传（lastMouseX/Y） |
| `src/utils/computerUse/win32/windowMessage.ts` | sendClick 加 WM_MOUSEMOVE；runPs 加 timeout |
| `src/utils/computerUse/win32/windowCapture.ts` | runPs 加 timeout (15s) |
| `src/utils/computerUse/win32/windowBorder.ts` | ps 加 timeout (5s) |
| `src/utils/computerUse/win32/escHook.ts` | pipeBusy 守卫；spawnSync 加 timeout |
| `src/utils/computerUse/win32/elevation.ts` | runPs 加 timeout (8s) |
| `src/utils/computerUse/win32/windowEnum.ts` | listWindows 加 timeout (8s) |
| `src/utils/computerUse/win32/comExcel.ts` | ps 加 timeout (8s) |
| `src/utils/computerUse/win32/comWord.ts` | runPs 加 timeout (8s) |
| `src/utils/computerUse/win32/ocr.ts` | runPs 加 timeout (8s) |
| `src/utils/computerUse/win32/uiAutomation.ts` | ps 加 timeout (8s) |

### 已知限制

- Electron/CEF 应用（如网易云音乐）使用 Chromium 内部消息循环，可能不响应 `SendMessage` 的 `WM_LBUTTONDOWN`。窗口已可见可手动操作，但 Computer Use 的自动点击可能需要通过 SendInput fallback 路径
- `WM_MOUSEMOVE` 前置发送提升了兼容性，但不能保证所有应用都能正确响应合成鼠标事件

---


## 修改时间日志

- 首次整理（Ch1-6）：2026-04-07
- Agent 模型选择 Fallback 修复（Ch7）：2026-04-08
- Computer Use Windows 平台支持（Ch8）：2026-04-24
- DeepSeek reasoning_content 多轮透传修复（Ch9）：2026-04-24
- Computer Use Windows 稳定性修复（Ch10）：2026-04-24
- 文档拆分整理：2026-05-07

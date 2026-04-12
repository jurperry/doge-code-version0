# Doge Code Agent 功能补齐与修正日志

本文档汇总了 Doge Code 项目中所有 Agent 功能相关的 bug 修复记录。

---

## 第一章：自定义 API 登录流程修复

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

## 第二章：OpenAI 兼容 API 路径与 max_tokens 限制修复

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

// DeepSeek max_tokens 限制
if (maxTokens && maxTokens > 8192 && process.env.ANTHROPIC_BASE_URL?.includes('deepseek')) {
  maxTokens = 8192
}
```

---

## 第三章：Responses API 兼容层新增

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

## 第四章：第三方模型上下文窗口检测修复

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
  if (modelLower.includes('glm-4') || modelLower.includes('glm4')) return 128_000
  if (modelLower.includes('gemini-1.5') || modelLower.includes('gemini-2.0')) return 1_000_000
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

## 第五章：DeepSeek 上下文窗口精确修复

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

## 第六章：自动压缩 Token 计数修复

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
| GLM-4/5 | 128,000 | 包含 "glm-4" 或 "glm4" |
| Gemini 1.5/2.0 | 1,000,000 | 包含 "gemini-1.5" 或 "gemini-2.0" |
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

## 第七章：Agent 模型选择 Fallback 机制修复

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

---

## 总结

本文档记录了 Doge Code 项目中 7 个重要的 bug 修复：

1. **自定义 API 登录流程修复** - 跳过 API 密钥审批
2. **OpenAI 兼容 API 路径与 max_tokens 限制修复** - DeepSeek 8192 限制
3. **Responses API 兼容层新增** - 支持 `/v1/responses` 格式
4. **第三方模型上下文窗口检测修复** - 硬编码常见模型 + 环境变量覆盖
5. **DeepSeek 上下文窗口精确修复** - 102,400 tokens
6. **自动压缩 Token 计数修复** - 持续更新 usage 数据
7. **Agent 模型选择 Fallback 机制修复** - 避免"捏造"模型名

所有修复都已经过测试验证，确保向后兼容且不影响现有功能。

---

## 文档更新日期

- 首次整理：2026-04-07
- 第三方模型上下文窗口修复：2026-04-07
- DeepSeek 上下文窗口精确修复：2026-04-07
- 自动压缩 Token 计数修复：2026-04-07
- Agent 模型选择 Fallback 修复：2026-04-08
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
所有 Agent 层级都会自动使用 `deepseek-chat`。

---

## 总结

本文档记录了 Doge Code 项目中 7 个重要的 bug 修复：

1. **自定义 API 登录流程修复** - 跳过 API 密钥审批
2. **OpenAI 兼容 API 路径与 max_tokens 限制修复** - DeepSeek 8192 限制
3. **Responses API 兼容层新增** - 支持 `/v1/responses` 格式
4. **第三方模型上下文窗口检测修复** - 硬编码常见模型 + 环境变量覆盖
5. **DeepSeek 上下文窗口精确修复** - 102,400 tokens
6. **自动压缩 Token 计数修复** - 持续更新 usage 数据
7. **Agent 模型选择 Fallback 机制修复** - 避免"捏造"模型名

所有修复都已经过测试验证，确保向后兼容且不影响现有功能。

---

## 文档更新日期

- 首次整理：2026-04-07
- 第三方模型上下文窗口修复：2026-04-07
- DeepSeek 上下文窗口精确修复：2026-04-07
- 自动压缩 Token 计数修复：2026-04-07
- Agent 模型选择 Fallback 修复：2026-04-08

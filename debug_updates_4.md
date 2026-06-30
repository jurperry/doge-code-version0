# DOGE-CODE 调试修改日志

## 2026-05-29 思考强度 (Effort) 全链路修复

---

### 修改 1: DeepSeek Responses compat max_tokens 修复
**文件**: `src/services/api/responsesCompat.ts`  
**行号**: L232  
**内容**: DeepSeek max_tokens 上限从 `8192` 修正为 `32000`，与 OpenAI compat 路径保持一致。

```diff
-    maxOutputTokens > 8192 &&
+    maxOutputTokens > 32000 &&
```

---

### 修改 2: modelSupportsEffort() isCustomApi 守卫
**文件**: `src/utils/effort.ts`  
**行号**: L45-48  
**内容**: 添加 `isCustomApi` 检查，与 `modelSupportsMaxEffort()` 逻辑对齐。

```diff
+  const isCustomApi = process.env.ANTHROPIC_BASE_URL && !isFirstPartyAnthropicBaseUrl()
-  if (getAPIProvider() !== 'firstParty' && matchesTierModel(model)) {
+  if ((getAPIProvider() !== 'firstParty' || isCustomApi) && matchesTierModel(model)) {
```

---

### 修改 3: modelSupportsThinking() isCustomApi 守卫
**文件**: `src/utils/thinking.ts`  
**行号**: L104-111  
**内容**: 自定义 API 端点上的未知模型不再默认启用 thinking，改为走 3P 保守路径。

```diff
+  const isCustomApi = process.env.ANTHROPIC_BASE_URL && !isFirstPartyAnthropicBaseUrl()
-  if (provider === 'foundry' || provider === 'firstParty') {
+  if (provider === 'foundry' || (provider === 'firstParty' && !isCustomApi)) {
     return !canonical.includes('claude-3-')
   }
-  // 3P (Bedrock/Vertex): only Opus 4+ and Sonnet 4+
+  // 3P (Bedrock/Vertex) and custom APIs: only Opus 4+ and Sonnet 4+
```

---

### 修改 4: modelSupportsAdaptiveThinking() isCustomApi 守卫
**文件**: `src/utils/thinking.ts`  
**行号**: L139-144  
**内容**: 自定义 API 端点上的未知模型不再默认启用 adaptive thinking。

```diff
+  const isCustomApi = process.env.ANTHROPIC_BASE_URL && !isFirstPartyAnthropicBaseUrl()
-  return provider === 'firstParty' || provider === 'foundry'
+  return provider === 'foundry' || (provider === 'firstParty' && !isCustomApi)
```

---

### 修改 5: OpenAI/Responses compat temperature 修复
**文件**: `src/services/api/claude.ts`  
**行号**: L1889, L1923  
**内容**: OpenAI/Responses compat 路径不再传递 thinking 衍生的 temperature，改用显式 override。
thinking 配置在 OpenAI compat 路径不被消费，但 `hasThinking` 状态会错误触发 `temperature: 1`。

```diff
-  temperature: params.temperature,
+  temperature: options.temperatureOverride,
```

---

### 修改 6: ModelPicker effort 初始化空窗期修复
**文件**: `src/components/ModelPicker.tsx`  
**行号**: L61  
**内容**: effort 初始化时若无 env 和 effortValue，fallback 到模型的默认 effort，避免面板空白。

```diff
-  : undefined
+  : getDefaultEffortLevelForOption(initialValue)
```

---

### 修改 7: 污染链根因修复 — captureModelProfile
**文件**: `src/utils/customApiStorage.ts`  
**行号**: L206  
**内容**: `/add-model` 不再快照 `CLAUDE_CODE_EFFORT_LEVEL`。effort 是运行时用户偏好，不是模型配置。

```diff
-    effortLevel: envStr(process.env.CLAUDE_CODE_EFFORT_LEVEL),
+    // NOTE: Do NOT capture CLAUDE_CODE_EFFORT_LEVEL...
```

---

### 修改 8: 污染链根因修复 — managedEnv
**文件**: `src/utils/managedEnv.ts`  
**行号**: L253-256  
**内容**: 启动时不再从被污染的 profile 恢复 effort 到环境变量。

```diff
-      if (profile.effortLevel && !process.env.CLAUDE_CODE_EFFORT_LEVEL) {
-        process.env.CLAUDE_CODE_EFFORT_LEVEL = profile.effortLevel
-      }
```

---

### 修改 9: 污染链根因修复 — applyModelProfile
**文件**: `src/utils/customApiStorage.ts`  
**行号**: L266-271  
**内容**: 切换模型时不再从 profile 恢复 effort。回退了 Issue 1 的修复（该修复基于存在污染数据的 profile）。

```diff
-  if (!skipEffort) {
-    applyEnvVar('CLAUDE_CODE_EFFORT_LEVEL', profile.effortLevel)
-  }
+  // NOTE: Do NOT apply CLAUDE_CODE_EFFORT_LEVEL from profile...
```
同步回退了 `applyModelProfile(profile, skipEffort)` → `applyModelProfile(profile)` 签名。

---

### 污染链完整说明

```
DeepSeek PS脚本 → CLAUDE_CODE_EFFORT_LEVEL=max (正确)
    │
    ├─→ /add-model glm-5.1
    │   captureModelProfile() 读取当前 env → effortLevel="max"
    │   ├─→ 错误！GLM 的 profile 被 DeepSeek 的 effort 污染
    │   └─→ 存入 credentials.json
    │
    └─→ 下次启动 GLM
        managedEnv.ts:254 读取 profile.effortLevel="max"
        ├─→ 设置 CLAUDE_CODE_EFFORT_LEVEL=max
        └─→ 错误！GLM 继承了 DeepSeek 的 max effort

修复后：
  - profile 不再携带 effortLevel（不再捕获、不再恢复）
  - effort 来源唯一：CLAUDE_CODE_EFFORT_LEVEL(PS脚本) → AppState.effortValue → 模型默认
```

---

## 2026-06-30 Tier 切换持久化断裂修复

### 问题现象

通过 `/add-model` 保存过自定义模型 profile 后，用户在 `/model` 中切换到 `opus` / `sonnet` / `haiku` 这类基础模型层级，退出后再用裸 `doge` 启动时，状态和请求会停留在字面层级名上，而不是这些层级背后实际应请求的真实模型 ID（例如 `deepseek-v4-flash`）。只有切回 default 后再退出，下一次裸启动才不会触发该问题。

### 根因

旧的 `switchTier()` 直接把 tier alias（`'opus'` / `'sonnet'` / `'haiku'`）写入磁盘配置，并且以 `clearCredentials=true` 同步到 `customApiEndpoint`。裸 `doge` 启动没有 `start_*.ps1` 提供的环境变量兜底时，恢复链会用磁盘上的 `customApiEndpoint.model` 作为 `ANTHROPIC_MODEL`，随后执行 `getModelProfile(activeModel)`。

当 `activeModel` 是字面 alias（例如 `'haiku'`）时，`getModelProfile('haiku')` 无法命中以真实模型 ID 保存的 profile，provider/baseURL/apiKey/tier env 无法恢复，最终请求模型也可能变成字面 `'haiku'`，导致自定义 API 不可用。

### 修复

- `switchTier()` 对非 null tier 先解析真实 tier 模型 ID，再持久化真实模型 ID，而不是持久化 alias。
- tier 路径调用 `syncToDisk(realTierModel, false, activeProfile)`：不再清凭证，并从当前 active profile 回写顶层 `provider` / `baseURL` / `apiKey` / `authTokenType`，保证裸启动时有 credential fallback。
- AppState 的 `mainLoopModel` 同步写真实 tier 模型 ID，使状态栏显示值、磁盘持久化值、实际请求模型三者一致。
- `switchTierBound()` 的 tier 解析直接读取 `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`，避免 `parseUserSpecifiedModel()` 的 fallback chain 被前一次 tier 切换留下的 `mainLoopModelOverride` 污染。
- `getActiveProfile()` 优先使用 `getUserSpecifiedModelSetting()`，再回退到 `process.env.ANTHROPIC_MODEL`，覆盖 bare model 切换后 env 尚未更新的场景。
- default/null 路径保持原语义：清空 model、清凭证，并把 `mainLoopModel` / `mainLoopModelForSession` 置为 null。
- 清理 `switchModelProfile.bindings.ts` 中已不再使用的 `parseUserSpecifiedModel` import。

### 验证

自动验证已完成：

```text
bun test src/utils/model/switchModelProfile.test.ts
→ 16 pass, 0 fail

bun test src/utils/model/ src/commands/model/
→ 26 pass, 0 fail

bun test src/utils/model/ src/commands/model/ src/state/
→ 26 pass, 0 fail

bun run dev:restore-check
→ CLI 正常启动到等待输入阶段

bun build src/utils/model/switchModelProfile.ts --no-bundle
→ exit 0

bun build src/utils/model/switchModelProfile.bindings.ts --no-bundle
→ exit 0

bun build src/commands/model/model.tsx --no-bundle
→ exit 0
```

交互式手动验证仍需在真实终端中执行（当前自动化子任务环境无法安全驱动 `/model` TUI 并进行真实 API 对话）：

1. `start_deepseek.ps1` 启动后，`/model` 选择 Haiku，状态栏应显示 `deepseek-v4-flash`，对话请求的 model ID 应一致。
2. 退出后不运行任何 `start_*.ps1`，裸 `doge` 启动，状态栏仍应显示真实 tier 模型 ID 且可对话。
3. Opus / Sonnet tier 做同样验证。
4. default 路径回归：切回 default 后应清空 override/凭证覆盖，不破坏 PS 脚本启动场景。

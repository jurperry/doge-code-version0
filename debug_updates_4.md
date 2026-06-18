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

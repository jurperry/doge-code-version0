# Tier 切换持久化断裂修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复裸 `doge` 启动后 tier 切换（Opus/Sonnet/Haiku）停留在字面别名、API 请求发出字面 "haiku" 致不可用的问题——让 tier 切换持久化真实 tier 模型 ID + 保留当前活跃 profile 凭证，使 `mainLoopModel`/状态栏/请求模型三者合一。

**Architecture:** `switchTier` 从"持久化 tier 别名字符串 + 清空凭证"改为"注入解析依赖得到真实 tier 模型 ID + 从当前活跃 profile 回写凭证 + `clearCredentials=false`"。`syncModelConfigToDisk` 增加可选 `credentialSourceProfile` 参数承载凭证回写。`bindings.ts` 注入真实 `parseUserSpecifiedModel`/`getModelProfile`，测试注入 mock。default（`null`）路径保持清凭证语义不变。

**Tech Stack:** Bun 1.3.5+, TypeScript ESM（`.js` 导入规格）, React JSX（`react-jsx`）, `bun:test` 内置测试运行器。`src/commands/model/model.tsx` 为 React compiler 编译产物（含 `t2 = function handleSelect(...)` 与 `$[N]` 缓存数组，须保留结构）。

**设计依据:** `docs/superpowers/specs/2026-06-29-tier-switch-persist-fix-design.md`

---

## File Structure

| 文件 | 职责 | 本计划改动 |
|---|---|---|
| `src/commands/model/model.tsx` | `syncModelConfigToDisk` 三文件同步（`.claude.json`/settings.json/customApiStorage） | 扩增第三参数 `credentialSourceProfile?`（Task 1） |
| `src/utils/model/switchModelProfile.ts` | `switchModelProfileAtomic` + `switchTier` 纯事务函数 | `SwitchTierDeps` 扩展 + `switchTier` 语义重构（Task 2-3） |
| `src/utils/model/switchModelProfile.bindings.ts` | 把纯函数 wire 到真实依赖（applyModelProfile/setAppState 等） | `switchTierBound` 注入 `resolveTierModel`/`getActiveProfile`（Task 4） |
| `src/utils/model/switchModelProfile.test.ts` | switchModelProfile 单元测试 | 更新 `switchTier` 断言 + 新增 5 测试（Task 5） |
| `src/utils/model/switchModelProfile.ts` 顶部 import | — | 引入 `ModelProfile` 类型已存在（Task 2） |

**不动**：`applyPersistedCustomApiEndpointEnv`（managedEnv.ts）、`onChangeAppState`、`parseUserSpecifiedModel`/`getDefault*Model`、`switchModelProfileAtomic`（P1 路径）、`decideAndSwitch`/`handlers.test`（P2 分支调用 `switchTierBound` 签名不变）。

---

### Task 1: `syncModelConfigToDisk` 扩展 `credentialSourceProfile` 参数

**Files:**
- Modify: `src/commands/model/model.tsx:27-58`

- [ ] **Step 1: 阅读当前 `syncModelConfigToDisk` 实现**

确认当前签名 `function syncModelConfigToDisk(model: string, clearCredentials?: boolean): void`，第 28-40 行：`const profile = getModelProfile(model)`，`if (clearCredentials) { credsUpdate = {清空} } else if (profile) { credsUpdate = {取自 profile} }`。`getModelProfile` 已在第 15 行 import。

- [ ] **Step 2: 修改签名与凭证源逻辑**

把 `src/commands/model/model.tsx:27-40` 改为：

```typescript
function syncModelConfigToDisk(
  model: string,
  clearCredentials?: boolean,
  credentialSourceProfile?: ModelProfile,
): void {
  const profile = credentialSourceProfile ?? getModelProfile(model)
  let credsUpdate: Record<string, unknown> = {}

  if (clearCredentials) {
    credsUpdate = { provider: undefined as unknown as string, baseURL: undefined as unknown as string, apiKey: undefined as unknown as string, authTokenType: undefined as unknown as string }
  } else if (profile) {
    credsUpdate = {
      provider: profile.provider,
      baseURL: profile.baseURL,
      apiKey: profile.apiKey,
      authTokenType: profile.authTokenType,
    }
  }
```

注意：`else if (profile)` 的 `credsUpdate` 块（第 42-49 行的 `saveGlobalConfig`、第 50 行 `updateSettingsForSource`、第 52-57 行 `readCustomApiStorage`/`writeCustomApiStorage`）**保持不变**。只改第 27-40 行节区。`ModelProfile` 类型需在 import 行加入（第 15 行 `import { applyModelProfile, getModelProfile, readCustomApiStorage, writeCustomApiStorage } from '../../utils/customApiStorage.js'`）。

- [ ] **Step 3: 把 `ModelProfile` 类型加入 import**

把 `src/commands/model/model.tsx:15` 改为：

```typescript
import { applyModelProfile, getModelProfile, readCustomApiStorage, writeCustomApiStorage, type ModelProfile } from '../../utils/customApiStorage.js';
```

- [ ] **Step 4: 确认 P1/default 调用点行为不变**

`switchModelProfileAtomic` 调 `syncToDisk(profile.model, true)`（两参），`switchTier` 旧调 `syncToDisk(modelString, true)`（两参）——两参调用第三参数 `undefined`，`credentialSourceProfile ?? getModelProfile(model)` = `getModelProfile(model)`，与旧行为一致。P1/default 路径无回归。

- [ ] **Step 5: 类型检查编译**

Run: `cd E:/ClaudeCode/doge-code && bunx tsc --noEmit src/commands/model/model.tsx 2>&1 | head -20`（若 tsc 单文件不支持，改用 `bun build src/commands/model/model.tsx --no-bundle 2>&1 | head -20`）
Expected: 无新增类型错误（可能因依赖其他模块而有现有告警，确认本次改动无新增）。

- [ ] **Step 6: Commit**

```bash
git add src/commands/model/model.tsx
git commit -m "feat(model): syncModelConfigToDisk 支持 credentialSourceProfile 参数

为 tier 切换凭证回写做准备：允许调用方显式传入 profile 作为凭证来源，
绕过 getModelProfile(model) 反查（tier 模型 ID 无 profile 会命空）。
未传入时行为与旧逻辑完全一致（P1/default 路径无回归）。"
```

---

### Task 2: `SwitchTierDeps` 扩展注入依赖

**Files:**
- Modify: `src/utils/model/switchModelProfile.ts:118-126`（`SwitchTierDeps` 接口）

- [ ] **Step 1: 修改 `SwitchTierDeps` 接口与 `syncToDisk` 类型**

把 `src/utils/model/switchModelProfile.ts:118-126` 改为：

```typescript
export interface SwitchTierDeps {
  syncToDisk: (
    model: string,
    clearCredentials: boolean,
    credentialSourceProfile?: ModelProfile,
  ) => void
  commitAppState: (updater: (prev: AppStateSlice) => AppStateSlice) => void
  /** Resolve a tier alias ('opus'|'sonnet'|'haiku') to the real model ID
   *  the active profile maps it to (e.g. 'haiku' → 'deepseek-v4-flash').
   *  Real binding: parseUserSpecifiedModel(tier). */
  resolveTierModel: (tier: 'opus' | 'sonnet' | 'haiku') => string
  /** Return the currently active ModelProfile (for credential write-back).
   *  Real binding: () => process.env.ANTHROPIC_MODEL ? getModelProfile(...) : undefined. */
  getActiveProfile: () => ModelProfile | undefined
}
```

`ModelProfile` 类型已在第 2 行 import（`import type { ModelProfile } from '../customApiStorage.js'`），确认无需新增 import。

- [ ] **Step 2: 类型检查**

Run: `cd E:/ClaudeCode/doge-code && bunx tsc --noEmit src/utils/model/switchModelProfile.ts 2>&1 | head -20`（或 `bun build`）
Expected: 现有 `switchTier` 实现还未用新 deps，可能会有"未使用"告警，但**不应有类型错误**（新 deps 是接口字段，不强制旧实现立即使用——但 TS 会因 `switchTier` 函数体未引用新字段而无错）。下一步实现会使用它们。

- [ ] **Step 3: Commit**

```bash
git add src/utils/model/switchModelProfile.ts
git commit -m "feat(model): SwitchTierDeps 扩展 resolveTierModel + getActiveProfile 注入

为 switchTier 语义重构做准备：注入 tier→真实模型 ID 解析与当前活跃
profile 反查，保持 switchModelProfile.ts 纯 util 性质（不直接 import
model.ts/customApiStorage 解析函数），完全可测。"
```

---

### Task 3: `switchTier` 语义重构

**Files:**
- Modify: `src/utils/model/switchModelProfile.ts:208-224`（`switchTier` 函数及其注释）

- [ ] **Step 1: 更新 `switchTier` 文档注释**

把 `src/utils/model/switchModelProfile.ts:208-215` 的注释改为：

```typescript
/**
 * Switch to a tier alias (opus/sonnet/haiku) or back to default (null).
 *
 * Tier path (opus/sonnet/haiku) — persists the REAL tier model ID (resolved
 * from the active profile's ANTHROPIC_DEFAULT_<TIER>_MODEL via resolveTierModel),
 * NOT the bare alias string, plus writes back the active profile's credentials
 * (getActiveProfile) so a bare `doge` restart can restore baseURL/apiKey. The
 * alias string alone would break the restart recovery chain: getModelProfile
 * keys profiles by real model ID, so a persisted "haiku" finds no profile and
 * ANTHROPIC_MODEL ends up as the literal "haiku" → API request fails.
 *
 * Does NOT touch any env vars (only reads env via injected deps for resolution).
 * Relies on the invariant that env reflects the active ModelProfile.
 *
 * - tier = 'opus' | 'sonnet' | 'haiku': commits the resolved real model ID
 *   as mainLoopModel; persists real ID + active profile credentials.
 * - tier = null (revert to default): clears mainLoopModel, clears stored
 *   credentials and model (existing semantics preserved).
 */
```

- [ ] **Step 2: 重写 `switchTier` 函数体**

把 `src/utils/model/switchModelProfile.ts:216-224` 改为：

```typescript
export function switchTier(tier: TierAlias, deps: SwitchTierDeps): void {
  if (tier === null) {
    // default 路径：清凭证 + 清 model，保持现有语义
    deps.syncToDisk('', true, undefined)
    deps.commitAppState((prev) => ({
      ...prev,
      mainLoopModel: null,
      mainLoopModelForSession: null,
    }))
    return
  }
  // tier 路径：解析真实 tier 模型 ID + 从当前活跃 profile 回写凭证
  const realTierModel = deps.resolveTierModel(tier)
  const activeProfile = deps.getActiveProfile()
  deps.syncToDisk(realTierModel, false, activeProfile)
  deps.commitAppState((prev) => ({
    ...prev,
    mainLoopModel: realTierModel,
    mainLoopModelForSession: null,
  }))
}
```

- [ ] **Step 3: 类型检查**

Run: `cd E:/ClaudeCode/doge-code && bunx tsc --noEmit src/utils/model/switchModelProfile.ts 2>&1 | head -20`（或 `bun build`）
Expected: 无类型错误。`TierAlias` = `'opus'|'sonnet'|'haiku'|null`（第 128 行），`tier` 经 null 分支后窄化为 `'opus'|'sonnet'|'haiku'`，匹配 `resolveTierModel` 入参类型。

- [ ] **Step 4: 运行现有测试确认 switchTier 测试会失败（预期）**

Run: `cd E:/ClaudeCode/doge-code && bun test src/utils/model/switchModelProfile.test.ts 2>&1 | tail -30`
Expected: `switchTier — does NOT touch any whitelisted env var` 测试 FAIL（其断言 `expect(syncMock).toHaveBeenCalledWith('haiku', true)` 不再成立——新签名是 `syncToDisk(realTierModel, false, activeProfile)`，且现有测试未注入 `resolveTierModel`/`getActiveProfile` 会因 `undefined is not a function` 失败）。**这是预期的**，Task 5 修复测试。`switchTier(null)` 测试（:179-190）也会因缺新 deps 而 FAIL（同 Task 5 修）。`switchModelProfileAtomic` 相关测试应仍 PASS（未改）。

- [ ] **Step 5: Commit**

```bash
git add src/utils/model/switchModelProfile.ts
git commit -m "fix(model): switchTier 持久化真实 tier 模型 ID + 回写凭证

根因修复：switchTier 原把字面 tier 别名持久化为 customApiEndpoint.model
并清空凭证，裸 doge 启动时 getModelProfile('haiku') 命空 → env 恢复链断裂
→ 请求发出字面 'haiku' 致不可用。

改为：解析真实 tier 模型 ID（resolveTierModel）持久化 + 从当前活跃
profile 回写凭证（getActiveProfile, clearCredentials=false）。mainLoopModel/
状态栏/请求模型三者合一为真实 tier 模型。default(null) 路径保持清凭证。"
```

---

### Task 4: `bindings.ts` 注入真实解析依赖

**Files:**
- Modify: `src/utils/model/switchModelProfile.bindings.ts:14-56`

- [ ] **Step 1: 修改 import**

把 `src/utils/model/switchModelProfile.bindings.ts:14-20` 改为：

```typescript
import { applyModelProfile, getModelProfile, type ModelProfile } from '../customApiStorage.js'
import {
  switchModelProfileAtomic as switchModelProfileAtomicCore,
  switchTier as switchTierCore,
  type AppStateSlice,
  type TierAlias,
} from './switchModelProfile.js'
import { parseUserSpecifiedModel } from './model.js'
```

- [ ] **Step 2: 更新 `SyncToDisk` 类型别名**

把 `src/utils/model/switchModelProfile.bindings.ts:22` 改为：

```typescript
type SyncToDisk = (
  model: string,
  clearCredentials: boolean,
  credentialSourceProfile?: ModelProfile,
) => void
```

- [ ] **Step 3: 重写 `switchTierBound` 注入新 deps**

把 `src/utils/model/switchModelProfile.bindings.ts:48-56`（`switchTierBound` 函数）改为：

```typescript
export function switchTierBound(
  tier: TierAlias,
  deps: { syncToDisk: SyncToDisk; setAppState: (f: (prev: any) => any) => void },
): void {
  switchTierCore(tier, {
    syncToDisk: deps.syncToDisk,
    commitAppState: bindCommit(deps.setAppState),
    resolveTierModel: (t) => parseUserSpecifiedModel(t),
    getActiveProfile: () =>
      process.env.ANTHROPIC_MODEL
        ? getModelProfile(process.env.ANTHROPIC_MODEL)
        : undefined,
  })
}
```

`switchModelProfileAtomicBound` 函数（:37-46）**保持不变**（P1 路径不涉及新 deps）。

- [ ] **Step 4: 确认 `parseUserSpecifiedModel` 接受 tier 别名**

`parseUserSpecifiedModel(modelInput: ModelName | ModelAlias)`（model.ts:516-517），`'opus'|'sonnet'|'haiku'` ∈ `ModelAlias`（aliases.ts:1-12），故 `parseUserSpecifiedModel(t)` 类型兼容。`t` 在 `switchTierBound` 经 `TierAlias`（含 null）传入，但 `switchTier` 内 null 分支已提前 return，剩余 `t` 窄化为 `'opus'|'sonnet'|'haiku'`，`resolveTierModel` 入参类型一致。

- [ ] **Step 5: 类型检查**

Run: `cd E:/ClaudeCode/doge-code && bunx tsc --noEmit src/utils/model/switchModelProfile.bindings.ts 2>&1 | head -20`（或 `bun build`）
Expected: 无类型错误。若 `parseUserSpecifiedModel` 返回类型 `ModelName`（含 `string`）赋给 `resolveTierModel: (...) => string` 兼容（`ModelName` 即 `string`）。确认无循环依赖：`bindings.ts` → `model.ts`，而 `model.ts` 不 import `bindings.ts`（已在前期核实）。

- [ ] **Step 6: 操作冒烟（restore-check）**

Run: `cd E:/ClaudeCode/doge-code && bun run dev:restore-check 2>&1 | tail -15`
Expected: 无缺失 import 报错（"All imports resolved" 或类似）。若该脚本不存在则跳过，改用 `bun build src/utils/model/switchModelProfile.bindings.ts --no-bundle 2>&1 | head -10` 确认无解析错误。

- [ ] **Step 7: Commit**

```bash
git add src/utils/model/switchModelProfile.bindings.ts
git commit -m "feat(model): switchTierBound 注入 resolveTierModel + getActiveProfile

把 switchTier 的新注入依赖 wire 到真实实现：
resolveTierModel = parseUserSpecifiedModel(tier)
getActiveProfile = () => getModelProfile(process.env.ANTHROPIC_MODEL ?? '')
保持 switchModelProfile.bindings.ts 不直接耦合 model.ts 解析逻辑的
纯 util 性质——解析作为依赖注入，bindings 是唯一 wiring 点。"
```

---

### Task 5: 更新与扩展 `switchModelProfile.test.ts`

**Files:**
- Modify: `src/utils/model/switchModelProfile.test.ts:161-190`（现有 `switchTier` 两测试）
- Add: 同文件新增 4 个测试

- [ ] **Step 1: 更新现有 `switchTier — does NOT touch any whitelisted env var` 测试**

把 `src/utils/model/switchModelProfile.test.ts:161-177` 改为：

```typescript
test('switchTier(haiku) — persists resolved real tier model, not the alias; does NOT touch whitelisted env', async () => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    process.env[key] = `preset-${key}`
  }

  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})
  const activeProfile = makeProfile({ model: 'deepseek-v4-pro[1m]' })

  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: syncMock,
    commitAppState: setAppStateMock,
    resolveTierModel: () => 'deepseek-v4-flash',
    getActiveProfile: () => activeProfile,
  })

  // 仍不碰白名单 env（不动 env 不变式保留）
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    expect(process.env[key]).toBe(`preset-${key}`)
  }
  // 新语义：持久化真实 tier 模型 ID, clearCredentials=false, 凭证回写
  expect(syncMock).toHaveBeenCalledWith('deepseek-v4-flash', false, activeProfile)
  expect(setAppStateMock).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: 更新现有 `switchTier(null)` 测试**

把 `src/utils/model/switchModelProfile.test.ts:179-190` 改为：

```typescript
test('switchTier(null) — commits mainLoopModel as null, clears credentials (default path)', async () => {
  let committed: any = null
  let synced: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier(null, {
    syncToDisk: (model, clearCreds, _profile) => { synced = { model, clearCreds, _profile } },
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'haiku', mainLoopModelForSession: 'x' })
    },
    resolveTierModel: () => 'unused',
    getActiveProfile: () => undefined,
  })
  expect(committed.mainLoopModel).toBeNull()
  expect(committed.mainLoopModelForSession).toBeNull()
  // default 路径：清凭证 + 清 model + 无凭证来源
  expect(synced.model).toBe('')
  expect(synced.clearCreds).toBe(true)
  expect(synced._profile).toBeUndefined()
})
```

- [ ] **Step 3: 新增测试 — opus tier 解析含 [1m] 后缀**

在 `src/utils/model/switchModelProfile.test.ts` 文件末尾（第 218 行 `switchModelProfileAtomic — apply failure...` 测试**之后**，文件末）追加：

```typescript

test('switchTier(opus) — resolves real opus model ID with [1m] suffix preserved', async () => {
  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})
  const activeProfile = makeProfile({ model: 'deepseek-v4-pro[1m]' })

  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('opus', {
    syncToDisk: syncMock,
    commitAppState: setAppStateMock,
    resolveTierModel: () => 'deepseek-v4-pro[1m]',
    getActiveProfile: () => activeProfile,
  })

  expect(syncMock).toHaveBeenCalledWith('deepseek-v4-pro[1m]', false, activeProfile)
})

test('switchTier(haiku) — no active profile → credentialSourceProfile undefined (preserve on-disk creds, no crash)', async () => {
  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})

  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: syncMock,
    commitAppState: setAppStateMock,
    resolveTierModel: () => 'deepseek-v4-flash',
    getActiveProfile: () => undefined,
  })

  // 无当前 profile：第三参数 undefined，syncModelConfigToDisk 保留磁盘现值凭证
  expect(syncMock).toHaveBeenCalledWith('deepseek-v4-flash', false, undefined)
  expect(setAppStateMock).toHaveBeenCalledTimes(1)
})

test('switchTier(haiku) — commitAppState mainLoopModel === resolved real tier model ID', async () => {
  let committed: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: () => {},
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'old-haiku', mainLoopModelForSession: 'sess' })
    },
    resolveTierModel: () => 'deepseek-v4-flash',
    getActiveProfile: () => undefined,
  })
  // 核心：mainLoopModel 是真实 tier 模型 ID，不是字面 'haiku'
  expect(committed.mainLoopModel).toBe('deepseek-v4-flash')
  expect(committed.mainLoopModelForSession).toBeNull()
})

test('switchTier(haiku) — resolveTierModel returns alias when no tier env (graceful degradation, not literal crash)', async () => {
  // 模拟降级：resolveTierModel 解析不出真实 tier 模型，回落主模型 ID
  const syncMock = mock(() => {})
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', {
    syncToDisk: syncMock,
    commitAppState: () => {},
    resolveTierModel: () => 'main-model-id',
    getActiveProfile: () => undefined,
  })
  // 降级为真实主模型 ID 仍优于现状（不发出字面 'haiku'）
  expect(syncMock).toHaveBeenCalledWith('main-model-id', false, undefined)
})
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `cd E:/ClaudeCode/doge-code && bun test src/utils/model/switchModelProfile.test.ts 2>&1 | tail -25`
Expected: 全部 PASS（原有 `switchModelProfileAtomic` 4 个测试 + `clearProfileEnvVars`/`captureEnvSnapshot`/`ModelSwitchError` 3 个 + 更新的 2 个 `switchTier` + 新增 4 个 = 共 13 个测试通过）。若 `switchModelProfileAtomic — clean path` 测试（:78-107）断言 `expect(syncMock).toHaveBeenCalledWith('deepseek-chat', true)` 仍 PASS（P1 路径 `syncToDisk` 仍是两参调用，第三参 undefined，`toHaveBeenCalledWith` 对未传第三参与传 undefined 兼容——bun:test 的 `toHaveBeenCalledWith` 严格匹配参数数量**需确认**：若失败则该测试改为 `toHaveBeenCalledWith('deepseek-chat', true, undefined)`）。

- [ ] **Step 5: 若 P1 测试因参数数量失败则修正**

仅在 Step 4 报告 `switchModelProfileAtomic — clean path` 或 `switchModelProfileAtomic — syncToDisk throws` 失败时执行。这两测试的 `syncMock` 是两参调用 `deps.syncToDisk(profile.model, true)`（switchModelProfile.ts:171，该行**未改**仍是两参）。bun:test `toHaveBeenCalledWith('deepseek-chat', true)` 对两参调用应 PASS。**若实际因 bun:test 严格匹配失败**，把 :105 改为 `expect(syncMock).toHaveBeenCalledWith('deepseek-chat', true, undefined)`。若 PASS 则跳过此步。

- [ ] **Step 6: 运行 model 命令相关全套测试**

Run: `cd E:/ClaudeCode/doge-code && bun test src/utils/model/ src/commands/model/ 2>&1 | tail -25`
Expected: `switchModelProfile.test.ts` + `handlers.test.ts` + 该目录其他测试全 PASS。`handlers.test.ts` 的 `switchTierBound` 断言（`toHaveBeenCalledWith('haiku', expect.anything())`）仍 PASS——`decideAndSwitch` P2 分支调用 `switchTierBound(input, {syncToDisk, setAppState})` 两参，签名不变。

- [ ] **Step 7: Commit**

```bash
git add src/utils/model/switchModelProfile.test.ts
git commit -m "test(model): switchTier 新语义测试 + 凭证回写/降级覆盖

更新现有 switchTier 测试为新语义（持久化真实 tier 模型 ID, clearCredentials=false,
凭证回写）；新增 4 测试覆盖 opus[1m] 解析、无活跃 profile 降级、mainLoopModel
真实 ID 断言、resolveTierModel 降级场景。"
```

---

### Task 6: 全量回归 + 手动验证

**Files:**
- 无代码改动，仅运行验证

- [ ] **Step 1: 运行受影响模块测试**

Run: `cd E:/ClaudeCode/doge-code && bun test src/utils/model/ src/commands/model/ src/state/ 2>&1 | tail -30`
Expected: 全 PASS。`src/state/` 覆盖 `onChangeAppState` 相关（若有无状态测试）。

- [ ] **Step 2: 运行恢复检查**

Run: `cd E:/ClaudeCode/doge-code && bun run dev:restore-check 2>&1 | tail -15`
Expected: 无缺失 import 报错。

- [ ] **Step 3: 编译冒烟**

Run: `cd E:/ClaudeCode/doge-code && bun build src/commands/model/model.tsx --no-bundle 2>&1 | head -10 && bun build src/utils/model/switchModelProfile.ts --no-bundle 2>&1 | head -10 && bun build src/utils/model/switchModelProfile.bindings.ts --no-bundle 2>&1 | head -10`
Expected: 三个文件均无编译/解析错误。

- [ ] **Step 4: 手动验证 — PS 脚本场景当前会话**

（交互式，需用户执行）启动 `./start_deepseek.ps1` → `bun run dev` → 运行 `/model` → 选 Haiku → 确认状态栏显示 `deepseek-v4-flash`（真实 tier 模型，非字面 "haiku"）→ 发一条消息确认能正常回复。
Expected: 状态栏 = `deepseek-v4-flash`，对话正常。

- [ ] **Step 5: 手动验证 — 裸 doge 启动恢复（核心修复点）**

（交互式，需用户执行）在 Step 4 的会话中确认 Haiku 后，退出 doge。然后**裸启动**：直接 `bun run dev`（不跑 `start_deepseek.ps1`）→ 状态栏应显示 `deepseek-v4-flash`（真实 tier 模型，**非字面 "haiku"**）→ 发一条消息确认请求发出 `deepseek-v4-flash` 且能正常回复。
Expected: 修复前此场景状态栏显示 `haiku` 且无法对话；修复后显示 `deepseek-v4-flash` 且可对话。查 `~/.doge/debug/<sessionId>.txt` 确认 API 请求 model ID = `deepseek-v4-flash` ≡ 状态栏。

- [ ] **Step 6: 手动验证 — Opus/Sonnet tier 同样验证**

（交互式，需用户执行）重复 Step 4-5，但选 Opus 和 Sonnet（自定义 provider 用户两者也走 P2）。退出裸启动后状态栏应分别显示对应真实 tier 模型（如 `deepseek-v4-pro[1m]`），可对话。
Expected: 3 个 tier 退出裸启动后均显示真实 tier 模型、可对话。

- [ ] **Step 7: 手动验证 — default 回归 + PS 场景不回归**

（交互式，需用户执行）(a) `/model default` → 退出 → 裸启动 → 状态栏显示主模型（非字面 "default"），可对话。(b) `start_deepseek.ps1` 启动 → `/model haiku` → 退出 → `start_deepseek.ps1` 重启 → 行为与修复前一致（PS 脚本场景本就健康，确认未被破坏）。
Expected: (a) default 健康；(b) PS 场景行为不变。

- [ ] **Step 8: Commit（无代码改动则跳过；若手动验证发现需微调则提交修复）**

若 Step 4-7 全通过无代码改动，本任务无 commit。若手动验证暴露问题需修复，修复后 commit：

```bash
git add <修改的文件>
git commit -m "test/fix(model): 手动验证发现的问题修复"
```

- [ ] **Step 9: 更新修复历史文档**

在 `E:/ClaudeCode/doge-code/debug_updates_4.md`（或同目录最新修复历史文件）末尾追加一节，记录本次修复：根因（switchTier 清凭证 + 持久化字面 alias）、修复（方案 C 真实 tier 模型 ID + 凭证回写）、影响的文件、手动验证结论。
Commit:

```bash
git add debug_updates_4.md
git commit -m "docs: 记录 tier 切换持久化断裂修复到 debug_updates_4"
```

---

## Self-Review 记录

**Spec 覆盖**：§4 方案 C → Task 1-4；§5 不变性（customApiEndpoint.model 永远真实 ID、tier 不清凭证、三者合一、P1 不变、PS 不变）→ Task 3 实现保证 + Task 6 手动验证；§7.3 顶层凭证对齐（tier 路径主动处理）→ Task 1+3+4 凭证回写；§7.4（已证伪不适用）→ Task 6 Step 6 仍手动验证 Opus/Sonnet 确认 P2 触发；§7.1 降级 → Task 5 降级测试 + Task 6；§8.1 自动测试 → Task 5；§8.2 手动验证 → Task 6 Step 4-7。全覆盖。

**Placeholder 扫描**：无 TBD/TODO；所有代码步骤含完整代码；命令含 expected。

**类型一致性**：`SwitchTierDeps.syncToDisk` = `(model, clearCredentials, credentialSourceProfile?)` 在 Task 2 定义、Task 3 使用、Task 4 bindings 适配、Task 5 测试 mock 一致。`resolveTierModel: (tier) => string` / `getActiveProfile: () => ModelProfile | undefined` 在 Task 2/3/4/5 一致。`SyncToDisk` 别名（bindings.ts）与 `SwitchTierDeps.syncToDisk` 签名一致（Task 4 Step 2）。`syncModelConfigToDisk` 第三参数 `credentialSourceProfile?` 在 Task 1/3/4 一致。
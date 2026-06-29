# 模型切换错位修复 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `/model` 在 ModelProfile（兜底主模型）与 Opus/Sonnet/Haiku tier 之间切换时产生的"状态栏 ≠ 实际请求模型"错位，保证状态栏一致性、兜底切换原子性、tier 解析纯净性。

**Architecture:** 引入两个新文件（`profileEnvKeys.ts` 常量 + `switchModelProfile.ts` 事务工具），把 env var 清理 / 应用 / 持久化 / AppState 提交收敛为一个原子事务函数；`useMainLoopModel` 改为单一解析路径并去除 `customApiStorage` fallback；`/model` 命令的 handleSelect / setModel 走新事务工具。

**Tech Stack:** TypeScript ESM、React、Bun 运行时、内置 `bun:test` test runner（无需新增配置）。

**配套 spec:** `docs/superpowers/specs/2026-06-29-model-switch-fix-design.md`
**配套手动验证脚本:** `docs/superpowers/specs/2026-06-29-model-switch-fix-manual-verify.md`
**分支:** `feat/model-switch-fix`（已建，不合并入 main）

---

## ⚠️ 实施前注意事项

1. **`src/commands/model/model.tsx` 是 React compiler 编译产物**（从 source maps 恢复而来）。它的语法形如 `t2 = function handleSelect(model, effort) { ... }`，与一般手写 React 文件不同。**修改时必须**：
   - 用 Grep/Read 定位到具体函数节点；
   - 改动时保留编译器生成的所有外层结构（`t2 = ...`、闭包、ref 命名等）；
   - 不要试图"把它格式化成正常源码"，那会破坏编译产物的内部一致性。
2. 所有测试用 `import { test, expect, mock, beforeEach, afterEach } from 'bun:test'`，运行命令 `bun test <path>`，无需 package.json 改动。
3. 每一步完成后立即 `git status` 验证文件改动符合 "Files" 列表。

---

## 文件结构总览

| 文件 | 角色 | 行动 |
|---|---|---|
| `src/utils/model/profileEnvKeys.ts` | 白名单常量单一定义点 | **新增** |
| `src/utils/model/switchModelProfile.ts` | 切换事务工具：`switchModelProfileAtomic` / `switchTier` / `clearProfileEnvVars` / `ModelSwitchError` | **新增** |
| `src/utils/model/profileEnvKeys.test.ts` | 白名单 snapshot 测试 | **新增** |
| `src/utils/model/switchModelProfile.test.ts` | 事务工具测试 | **新增** |
| `src/hooks/useMainLoopModel.ts` | 状态栏读侧 hook，统一解析路径 | **修改** |
| `src/hooks/useMainLoopModel.test.ts` | hook 行为测试 | **新增** |
| `src/components/StatusLine.tsx` | 状态栏组件 | **修改**（消除双重 runtime 解析） |
| `src/commands/model/model.tsx` | `/model` handlers 调用事务工具 | **修改**（编译产物，需谨慎） |
| `src/commands/model/handlers.test.ts` | 决策分发纯函数测试 | **新增** |
| `src/utils/customApiStorage.ts` | `applyModelProfile` 注释加约束声明 | **微改**（仅注释） |
| `src/state/onChangeAppState.ts` | 广播 modelChanged signal | **微改** |

---

## Task 1：白名单常量与基础测试

**Files:**
- Create: `src/utils/model/profileEnvKeys.ts`
- Create: `src/utils/model/profileEnvKeys.test.ts`

- [ ] **Step 1：编写常量文件**

Create `src/utils/model/profileEnvKeys.ts`：

```ts
/**
 * Environment variables fully owned by the active ModelProfile.
 *
 * Contract: when switching to a new ModelProfile, ALL keys in this list must
 * be cleared first (so a tier value the new profile does not provide cannot
 * survive from the old profile). `applyModelProfile` then writes back only
 * the keys the new profile actually defines.
 *
 * This list is the single source of truth — clear + apply both reference it.
 *
 * Note: CLAUDE_CODE_EFFORT_LEVEL is intentionally NOT included; effort is a
 * runtime preference orthogonal to the profile (see customApiStorage.ts).
 */
export const PROFILE_MANAGED_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
] as const

export type ProfileManagedEnvKey = (typeof PROFILE_MANAGED_ENV_KEYS)[number]
```

- [ ] **Step 2：编写失败测试**

Create `src/utils/model/profileEnvKeys.test.ts`：

```ts
import { test, expect } from 'bun:test'
import { PROFILE_MANAGED_ENV_KEYS } from './profileEnvKeys.js'

test('PROFILE_MANAGED_ENV_KEYS contains the exact 9 keys audited from applyModelProfile', () => {
  expect(PROFILE_MANAGED_ENV_KEYS).toEqual([
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
    'CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  ])
})

test('PROFILE_MANAGED_ENV_KEYS does NOT include CLAUDE_CODE_EFFORT_LEVEL (effort is independent)', () => {
  expect(PROFILE_MANAGED_ENV_KEYS).not.toContain('CLAUDE_CODE_EFFORT_LEVEL')
})
```

- [ ] **Step 3：运行测试，应通过**

Run: `bun test src/utils/model/profileEnvKeys.test.ts`
Expected: 2 pass, 0 fail.

- [ ] **Step 4：提交**

```bash
git add src/utils/model/profileEnvKeys.ts src/utils/model/profileEnvKeys.test.ts
git commit -m "feat(model): 新增 PROFILE_MANAGED_ENV_KEYS 白名单常量

切换 ModelProfile 时由该常量驱动 env var 清理与应用，
杜绝跨 profile 的 tier env var 残留（见 design §1.2.a）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2：事务工具 — `clearProfileEnvVars` + 测试

**Files:**
- Create: `src/utils/model/switchModelProfile.ts`（先只写 `clearProfileEnvVars` + `ModelSwitchError`，下个 task 加 atomic）
- Create: `src/utils/model/switchModelProfile.test.ts`

- [ ] **Step 1：编写 `clearProfileEnvVars` 与错误类**

Create `src/utils/model/switchModelProfile.ts`：

```ts
import { PROFILE_MANAGED_ENV_KEYS, type ProfileManagedEnvKey } from './profileEnvKeys.js'

export type ModelSwitchPhase = 'apply' | 'persist' | 'commit'

export class ModelSwitchError extends Error {
  readonly phase: ModelSwitchPhase
  readonly cause: unknown
  constructor(phase: ModelSwitchPhase, cause: unknown) {
    super(`Model switch failed at ${phase}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ModelSwitchError'
    this.phase = phase
    this.cause = cause
  }
}

/**
 * Delete all profile-managed env vars unconditionally.
 *
 * MUST be called as step 2 of switchModelProfileAtomic (after snapshot,
 * before applyModelProfile). Safe to call repeatedly; `delete` on an
 * undefined key is a no-op.
 */
export function clearProfileEnvVars(): void {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    delete process.env[key]
  }
}

/**
 * Capture current values of all profile-managed env vars for rollback.
 */
export function captureEnvSnapshot(): Record<ProfileManagedEnvKey, string | undefined> {
  const snapshot = {} as Record<ProfileManagedEnvKey, string | undefined>
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    snapshot[key] = process.env[key]
  }
  return snapshot
}

/**
 * Restore env vars from a snapshot. Deletes keys that were undefined in
 * the snapshot rather than setting them to the string "undefined".
 */
export function restoreEnvSnapshot(snapshot: Record<ProfileManagedEnvKey, string | undefined>): void {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    const value = snapshot[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}
```

- [ ] **Step 2：编写失败测试**

Create `src/utils/model/switchModelProfile.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import {
  clearProfileEnvVars,
  captureEnvSnapshot,
  restoreEnvSnapshot,
  ModelSwitchError,
} from './switchModelProfile.js'
import { PROFILE_MANAGED_ENV_KEYS } from './profileEnvKeys.js'

// Save & restore env around each test so they don't bleed.
let originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  originalEnv = {}
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    originalEnv[key] = process.env[key]
  }
})

afterEach(() => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    const v = originalEnv[key]
    if (v === undefined) delete process.env[key]
    else process.env[key] = v
  }
})

test('clearProfileEnvVars deletes every key in the whitelist', () => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    process.env[key] = 'preset-value'
  }
  clearProfileEnvVars()
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    expect(process.env[key]).toBeUndefined()
  }
})

test('clearProfileEnvVars is idempotent on undefined keys', () => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    delete process.env[key]
  }
  expect(() => clearProfileEnvVars()).not.toThrow()
})

test('captureEnvSnapshot + restoreEnvSnapshot round-trip preserves undefined keys', () => {
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'foo-opus'
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  const snap = captureEnvSnapshot()
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'CONTAMINATED'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'CONTAMINATED'
  restoreEnvSnapshot(snap)
  expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('foo-opus')
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
})

test('ModelSwitchError exposes phase and cause', () => {
  const inner = new Error('disk read-only')
  const err = new ModelSwitchError('persist', inner)
  expect(err.phase).toBe('persist')
  expect(err.cause).toBe(inner)
  expect(err.message).toContain('persist')
  expect(err.message).toContain('disk read-only')
})
```

- [ ] **Step 3：运行测试，应全绿**

Run: `bun test src/utils/model/switchModelProfile.test.ts`
Expected: 4 pass, 0 fail.

- [ ] **Step 4：提交**

```bash
git add src/utils/model/switchModelProfile.ts src/utils/model/switchModelProfile.test.ts
git commit -m "feat(model): 新增 clearProfileEnvVars + env snapshot/restore + ModelSwitchError

事务工具的基础原语：白名单清理 + 快照 + 回滚 + 错误类型。
为 switchModelProfileAtomic 与 switchTier 提供构件块（design §4.A）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3：事务工具 — `switchModelProfileAtomic` 主路径

**Files:**
- Modify: `src/utils/model/switchModelProfile.ts`（追加 `switchModelProfileAtomic`）
- Modify: `src/utils/model/switchModelProfile.test.ts`（追加事务测试）

- [ ] **Step 1：先写失败测试（追加到现有测试文件末尾）**

Append to `src/utils/model/switchModelProfile.test.ts`：

```ts
import { mock } from 'bun:test'
import type { ModelProfile } from '../customApiStorage.js'

// Test helpers — minimal valid profile factory.
function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    model: 'test-model',
    provider: 'openai',
    baseURL: 'https://example.test/v1',
    apiKey: 'sk-test',
    authTokenType: 'DOGE_API_KEY',
    ...overrides,
  }
}

test('switchModelProfileAtomic — clean path writes new profile env, AppState, disk', async () => {
  const profile = makeProfile({
    model: 'deepseek-chat',
    defaultHaikuModel: undefined, // new profile has no haiku override
  })

  // Pre-pollute env with old profile's haiku.
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-flash'
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'

  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})
  const applyMock = mock((p: ModelProfile) => {
    process.env.ANTHROPIC_MODEL = p.model
    // Simulating that the new profile does not write HAIKU_MODEL.
  })

  const { switchModelProfileAtomic } = await import('./switchModelProfile.js')
  await switchModelProfileAtomic(profile, {
    applyProfile: applyMock,
    syncToDisk: syncMock,
    commitAppState: setAppStateMock,
  })

  // Core regression: haiku env from old profile must be gone.
  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
  expect(process.env.ANTHROPIC_MODEL).toBe('deepseek-chat')
  expect(applyMock).toHaveBeenCalledWith(profile)
  expect(syncMock).toHaveBeenCalledWith('deepseek-chat', true)
  expect(setAppStateMock).toHaveBeenCalledTimes(1)
})

test('switchModelProfileAtomic — applyProfile throws → env rolled back, AppState untouched', async () => {
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-flash'
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'

  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})
  const applyMock = mock(() => {
    throw new Error('boom')
  })

  const { switchModelProfileAtomic } = await import('./switchModelProfile.js')
  await expect(
    switchModelProfileAtomic(makeProfile(), {
      applyProfile: applyMock,
      syncToDisk: syncMock,
      commitAppState: setAppStateMock,
    }),
  ).rejects.toThrow(ModelSwitchError)

  expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qwen3-flash')
  expect(process.env.ANTHROPIC_MODEL).toBe('qwen3.7-max')
  expect(setAppStateMock).not.toHaveBeenCalled()
})

test('switchModelProfileAtomic — syncToDisk throws → env rolled back, throws persist phase', async () => {
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'

  const setAppStateMock = mock(() => {})
  const applyMock = mock((p: ModelProfile) => {
    process.env.ANTHROPIC_MODEL = p.model
  })
  const syncMock = mock(() => {
    throw new Error('EACCES')
  })

  const { switchModelProfileAtomic } = await import('./switchModelProfile.js')
  let caught: ModelSwitchError | null = null
  try {
    await switchModelProfileAtomic(makeProfile({ model: 'deepseek-chat' }), {
      applyProfile: applyMock,
      syncToDisk: syncMock,
      commitAppState: setAppStateMock,
    })
  } catch (e) {
    caught = e as ModelSwitchError
  }
  expect(caught).toBeInstanceOf(ModelSwitchError)
  expect(caught?.phase).toBe('persist')
  expect(process.env.ANTHROPIC_MODEL).toBe('qwen3.7-max')
  expect(setAppStateMock).not.toHaveBeenCalled()
})

test('switchTier — does NOT touch any whitelisted env var', async () => {
  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    process.env[key] = `preset-${key}`
  }

  const setAppStateMock = mock(() => {})
  const syncMock = mock(() => {})

  const { switchTier } = await import('./switchModelProfile.js')
  switchTier('haiku', { syncToDisk: syncMock, commitAppState: setAppStateMock })

  for (const key of PROFILE_MANAGED_ENV_KEYS) {
    expect(process.env[key]).toBe(`preset-${key}`)
  }
  expect(syncMock).toHaveBeenCalledWith('haiku', true)
  expect(setAppStateMock).toHaveBeenCalledTimes(1)
})

test('switchTier(null) — commits mainLoopModel as null (revert to default)', async () => {
  let committed: any = null
  const { switchTier } = await import('./switchModelProfile.js')
  switchTier(null, {
    syncToDisk: () => {},
    commitAppState: (updater) => {
      committed = updater({ mainLoopModel: 'haiku', mainLoopModelForSession: 'x' })
    },
  })
  expect(committed.mainLoopModel).toBeNull()
  expect(committed.mainLoopModelForSession).toBeNull()
})
```

- [ ] **Step 2：运行测试，应当全部 FAIL（switchModelProfileAtomic / switchTier 未导出）**

Run: `bun test src/utils/model/switchModelProfile.test.ts`
Expected: 5 new tests fail with "is not a function" or similar.

- [ ] **Step 3：实现 switchModelProfileAtomic 与 switchTier**

Append to `src/utils/model/switchModelProfile.ts`：

```ts
import type { ModelProfile } from '../customApiStorage.js'

/**
 * Dependencies are injected for testability. The default-bound versions live in
 * `./switchModelProfile.bindings.ts` (created later); the /model command imports
 * from there to get a pre-wired API. Test files inject mocks directly.
 */
export interface SwitchProfileDeps {
  applyProfile: (profile: ModelProfile) => void
  syncToDisk: (model: string, clearCredentials: boolean) => void
  commitAppState: (updater: (prev: AppStateSlice) => AppStateSlice) => void
}

export interface SwitchTierDeps {
  syncToDisk: (model: string, clearCredentials: boolean) => void
  commitAppState: (updater: (prev: AppStateSlice) => AppStateSlice) => void
}

export interface AppStateSlice {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
}

export type TierAlias = 'opus' | 'sonnet' | 'haiku' | null

/**
 * Atomically switch to a new ModelProfile. Steps:
 *  1. Snapshot all profile-managed env vars.
 *  2. Clear those env vars (white-list reset; see profileEnvKeys.ts).
 *  3. applyProfile(profile)  → writes new env vars + persists customApiStorage.
 *  4. syncToDisk(profile.model, true) → updates .claude.json + settings.json.
 *  5. commitAppState → mainLoopModel := profile.model, mainLoopModelForSession := null.
 *
 * On any failure in steps 3-4 env is restored from the snapshot and a
 * ModelSwitchError is thrown (phase = 'apply' | 'persist'). Step 5 failure
 * also rolls back env and tries one more syncToDisk(oldModel,true) to revert
 * disk; if that also fails, the error is rethrown (phase = 'commit') and the
 * caller surfaces a "manual restart recommended" toast.
 */
export async function switchModelProfileAtomic(
  profile: ModelProfile,
  deps: SwitchProfileDeps,
): Promise<void> {
  const snapshot = captureEnvSnapshot()
  const oldModel = process.env.ANTHROPIC_MODEL

  clearProfileEnvVars()

  // Step 3: applyProfile
  try {
    deps.applyProfile(profile)
  } catch (cause) {
    restoreEnvSnapshot(snapshot)
    if (oldModel !== undefined) process.env.ANTHROPIC_MODEL = oldModel
    else delete process.env.ANTHROPIC_MODEL
    throw new ModelSwitchError('apply', cause)
  }

  // Step 4: syncToDisk
  try {
    deps.syncToDisk(profile.model, true)
  } catch (cause) {
    restoreEnvSnapshot(snapshot)
    if (oldModel !== undefined) process.env.ANTHROPIC_MODEL = oldModel
    else delete process.env.ANTHROPIC_MODEL
    throw new ModelSwitchError('persist', cause)
  }

  // Step 5: commit AppState
  try {
    deps.commitAppState((prev) => ({
      ...prev,
      mainLoopModel: profile.model,
      mainLoopModelForSession: null,
    }))
  } catch (cause) {
    restoreEnvSnapshot(snapshot)
    if (oldModel !== undefined) process.env.ANTHROPIC_MODEL = oldModel
    else delete process.env.ANTHROPIC_MODEL
    try {
      if (oldModel !== undefined) deps.syncToDisk(oldModel, true)
    } catch {
      /* swallow; commit-phase rollback best-effort */
    }
    throw new ModelSwitchError('commit', cause)
  }
}

/**
 * Switch to a tier alias (opus/sonnet/haiku) or back to default (null).
 * Does NOT touch any env vars — relies on the invariant that env vars
 * reflect ONLY the currently active ModelProfile (guaranteed by atomic).
 */
export function switchTier(tier: TierAlias, deps: SwitchTierDeps): void {
  const modelString = tier ?? null
  // syncToDisk expects a string; null tier means "revert to ANTHROPIC_MODEL default".
  // We persist the alias if non-null; null clears the override from disk.
  deps.syncToDisk(modelString ?? '', false)
  deps.commitAppState((prev) => ({
    ...prev,
    mainLoopModel: modelString,
    mainLoopModelForSession: null,
  }))
}
```

- [ ] **Step 4：再次运行测试，应全绿**

Run: `bun test src/utils/model/switchModelProfile.test.ts`
Expected: 9 pass total (4 from Task 2 + 5 new), 0 fail.

- [ ] **Step 5：提交**

```bash
git add src/utils/model/switchModelProfile.ts src/utils/model/switchModelProfile.test.ts
git commit -m "feat(model): 实现 switchModelProfileAtomic 与 switchTier 事务工具

- atomic: 快照 → clear 白名单 → apply → sync → commit AppState，任一步失败回滚
- switchTier: 仅写 AppState/disk，不动 env var（依赖 atomic 保证的纯净性）
- 依赖注入风格，便于测试与未来分支替换

实现 design §1.2/§1.3 与 §4.A/§4.B。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4：事务工具的"已绑定"导出层

**Files:**
- Create: `src/utils/model/switchModelProfile.bindings.ts`

由 `/model` 命令引入，组装真实依赖。test 路径继续用注入式 API。

- [ ] **Step 1：编写绑定文件**

Create `src/utils/model/switchModelProfile.bindings.ts`：

```ts
/**
 * Pre-wired bindings for switchModelProfile transactions. UI/command code
 * imports from here; tests import the dep-injected functions directly.
 */
import { setAppState } from '../../state/AppState.js'
import { applyModelProfile, type ModelProfile } from '../customApiStorage.js'
import {
  switchModelProfileAtomic as switchModelProfileAtomicCore,
  switchTier as switchTierCore,
  type TierAlias,
} from './switchModelProfile.js'

// syncModelConfigToDisk lives inside model.tsx (a compiled artifact). To keep
// circular-dep risk low, we accept a thin function reference here that
// /model wires up at call time.
export async function switchModelProfileAtomicBound(
  profile: ModelProfile,
  syncToDisk: (model: string, clearCredentials: boolean) => void,
): Promise<void> {
  return switchModelProfileAtomicCore(profile, {
    applyProfile: applyModelProfile,
    syncToDisk,
    commitAppState: (updater) => setAppState((prev: any) => updater(prev)),
  })
}

export function switchTierBound(
  tier: TierAlias,
  syncToDisk: (model: string, clearCredentials: boolean) => void,
): void {
  switchTierCore(tier, {
    syncToDisk,
    commitAppState: (updater) => setAppState((prev: any) => updater(prev)),
  })
}
```

- [ ] **Step 2：编译检查（无新测试，工具层）**

Run: `bun run dev:restore-check`
Expected: 无 import 错误退出码。

> 如果 `setAppState` 的实际导出位置不在 `src/state/AppState.js`，先用 Grep 定位：`rg "export function setAppState|export const setAppState" src/state` → 调整 import。

- [ ] **Step 3：提交**

```bash
git add src/utils/model/switchModelProfile.bindings.ts
git commit -m "feat(model): 新增 switchModelProfile.bindings 绑定层

将事务工具与项目真实 setAppState / applyModelProfile 绑定，
供 /model 命令直接使用；测试侧继续走依赖注入。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5：`applyModelProfile` 约束注释

**Files:**
- Modify: `src/utils/customApiStorage.ts:225`（仅追加 JSDoc）

- [ ] **Step 1：在 `applyModelProfile` 函数前增加 JSDoc**

Use Edit on `src/utils/customApiStorage.ts`：

Old:
```ts
export function applyModelProfile(profile: ModelProfile): void {
```

New:
```ts
/**
 * Apply a ModelProfile to `process.env` and persist `model` to customApiStorage.
 *
 * IMPORTANT CONTRACT (since 2026-06-29):
 *  - This function MUST NOT be relied upon to clear env vars the new profile
 *    does not provide. The caller is responsible for calling
 *    `clearProfileEnvVars()` (from utils/model/switchModelProfile.ts) BEFORE
 *    invoking this function, so that any whitelisted env var the new profile
 *    omits is left undefined rather than retaining a stale value from a
 *    previous profile.
 *  - The canonical caller is `switchModelProfileAtomic`. Direct callers
 *    outside of that transaction must replicate the clear+apply sequence.
 */
export function applyModelProfile(profile: ModelProfile): void {
```

- [ ] **Step 2：编译检查**

Run: `bun run dev:restore-check`
Expected: 无错误。

- [ ] **Step 3：提交**

```bash
git add src/utils/customApiStorage.ts
git commit -m "docs(customApiStorage): 声明 applyModelProfile 的清理-应用契约

明确写出该函数不负责清理跨 profile 残留的 env var，
该职责由 switchModelProfileAtomic 的 clearProfileEnvVars 步骤承担。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6：`useMainLoopModel` 单一解析路径

**Files:**
- Modify: `src/hooks/useMainLoopModel.ts`
- Create: `src/hooks/useMainLoopModel.test.ts`

- [ ] **Step 1：先写测试**

Create `src/hooks/useMainLoopModel.test.ts`：

```ts
import { test, expect, beforeEach, afterEach, mock } from 'bun:test'

// We test the pure resolver factored out of the hook; React rendering is
// not exercised here. The hook calls resolveMainLoopModel internally.
import { resolveMainLoopModel } from './useMainLoopModel.js'

const originalEnv = { ...process.env }

beforeEach(() => {
  // Reset relevant env each test
  for (const k of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  Object.assign(process.env, originalEnv)
})

test('returns concrete model id when AppState.mainLoopModel is concrete', () => {
  process.env.ANTHROPIC_MODEL = 'deepseek-chat'
  const out = resolveMainLoopModel({
    mainLoopModel: 'deepseek-chat',
    mainLoopModelForSession: null,
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  expect(out).toBe('deepseek-chat')
})

test('resolves haiku alias via env var, not the literal "haiku"', () => {
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-flash'
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'
  const out = resolveMainLoopModel({
    mainLoopModel: 'haiku',
    mainLoopModelForSession: null,
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  expect(out).toBe('qwen3-flash')
})

test('haiku alias falls back to ANTHROPIC_MODEL when HAIKU env missing (core regression)', () => {
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  process.env.ANTHROPIC_MODEL = 'deepseek-chat'
  const out = resolveMainLoopModel({
    mainLoopModel: 'haiku',
    mainLoopModelForSession: null,
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  expect(out).toBe('deepseek-chat')
})

test('mainLoopModelForSession takes priority over mainLoopModel', () => {
  const out = resolveMainLoopModel({
    mainLoopModel: 'haiku',
    mainLoopModelForSession: 'session-override',
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  expect(out).toBe('session-override')
})

test('plan mode upgrades haiku → sonnet via getRuntimeMainLoopModel', () => {
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'qwen3-plus'
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3-flash'
  process.env.ANTHROPIC_MODEL = 'qwen3.7-max'
  const out = resolveMainLoopModel({
    mainLoopModel: 'haiku',
    mainLoopModelForSession: null,
    permissionMode: 'plan',
    exceeds200kTokens: false,
  })
  // Should land on the sonnet-tier model, not the haiku tier.
  expect(out).toBe('qwen3-plus')
})

test('does not fall through to customApiStorage when AppState fields are null', () => {
  // We don't need to mock readCustomApiStorage — we just assert that with
  // both AppState fields null and no env, we get the platform default, not
  // some persisted "contamination".
  delete process.env.ANTHROPIC_MODEL
  const out = resolveMainLoopModel({
    mainLoopModel: null,
    mainLoopModelForSession: null,
    permissionMode: 'default',
    exceeds200kTokens: false,
  })
  // Default falls through getDefaultMainLoopModelSetting() — assertion is
  // that the returned value is NOT 'haiku' alias and NOT the empty string.
  expect(out).not.toBe('haiku')
  expect(out).not.toBe('')
  expect(typeof out).toBe('string')
})
```

- [ ] **Step 2：运行测试，应全部 FAIL（resolveMainLoopModel 尚未导出）**

Run: `bun test src/hooks/useMainLoopModel.test.ts`
Expected: 6 fail.

- [ ] **Step 3：修改 hook，抽出 `resolveMainLoopModel` 纯函数**

Replace `src/hooks/useMainLoopModel.ts` 全文：

```ts
import { useEffect, useReducer } from 'react'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { useAppState } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  getRuntimeMainLoopModel,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import type { PermissionMode } from '../utils/permissions/types.js'

export interface ResolveMainLoopModelInput {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  permissionMode: PermissionMode
  exceeds200kTokens: boolean
}

/**
 * Single resolution path for the main-loop model. The status bar and the
 * API client must both go through this function (or through identical
 * arguments to parseUserSpecifiedModel + getRuntimeMainLoopModel) so that
 * what the user sees equals what gets sent.
 *
 * NOTE: customApiStorage.model is intentionally NOT in the fallback chain.
 * That is a persistence layer with write latency, and including it makes
 * the status bar lag behind AppState after /model switches.
 */
export function resolveMainLoopModel(input: ResolveMainLoopModelInput): ModelName {
  const raw =
    input.mainLoopModelForSession ??
    input.mainLoopModel ??
    getDefaultMainLoopModelSetting()
  const parsed = parseUserSpecifiedModel(raw)
  return getRuntimeMainLoopModel({
    permissionMode: input.permissionMode,
    mainLoopModel: parsed,
    exceeds200kTokens: input.exceeds200kTokens,
  })
}

/**
 * React hook variant. Caller must supply permissionMode + exceeds200kTokens
 * via the surrounding component (StatusLine already has both refs).
 */
export function useMainLoopModel(opts: {
  permissionMode: PermissionMode
  exceeds200kTokens: boolean
}): ModelName {
  const mainLoopModel = useAppState((s) => s.mainLoopModel)
  const mainLoopModelForSession = useAppState((s) => s.mainLoopModelForSession)

  const [, forceRerender] = useReducer((x) => x + 1, 0)
  useEffect(() => onGrowthBookRefresh(forceRerender), [])

  return resolveMainLoopModel({
    mainLoopModel,
    mainLoopModelForSession,
    permissionMode: opts.permissionMode,
    exceeds200kTokens: opts.exceeds200kTokens,
  })
}
```

> 如果 `PermissionMode` 类型路径不同，先 `rg "export.*PermissionMode" src/utils` 校准。

- [ ] **Step 4：再次运行测试，应全绿**

Run: `bun test src/hooks/useMainLoopModel.test.ts`
Expected: 6 pass.

- [ ] **Step 5：编译全项目（捕获 useMainLoopModel 旧签名调用方）**

Run: `bun run dev:restore-check`
Expected: 列出 useMainLoopModel 的调用方编译失败（StatusLine 至少 1 处）——这是预期的，下一个 task 修。

- [ ] **Step 6：提交**

```bash
git add src/hooks/useMainLoopModel.ts src/hooks/useMainLoopModel.test.ts
git commit -m "feat(hook): useMainLoopModel 收敛到 resolveMainLoopModel 单一解析路径

- 从 fallback 链移除 readCustomApiStorage().model（持久化层延迟会致错位）
- 显式接受 permissionMode + exceeds200kTokens，把 getRuntimeMainLoopModel
  一并执行，保证状态栏与 API 客户端结果一致（design §1.1）
- 抽出纯函数 resolveMainLoopModel 以便单元测试

调用方（StatusLine）将在下一 commit 调整。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7：StatusLine 适配新 hook 签名

**Files:**
- Modify: `src/components/StatusLine.tsx:155`（useMainLoopModel 调用）+ 39-43（移除冗余的 getRuntimeMainLoopModel 二次调用）

- [ ] **Step 1：定位现状**

Run:
```bash
rg -n "useMainLoopModel|getRuntimeMainLoopModel" src/components/StatusLine.tsx
```
确认行号与 spec 一致；如有偏差以实际为准。

- [ ] **Step 2：修改 StatusLine.tsx**

在调用 `useMainLoopModel()` 处（约 155 行）改为：

Old:
```ts
const mainLoopModel = useMainLoopModel();
```

New:
```ts
const mainLoopModel = useMainLoopModel({
  permissionMode: permissionModeRef.current,
  exceeds200kTokens,
});
```

> `permissionModeRef.current` 与 `exceeds200kTokens` 已存在于 StatusLine 上下文（见行 209 的 `buildStatusLineCommandInput` 调用）。如果在 hook 调用点这两个变量尚未声明，则向上找到它们的源 ref / state 并直接复用——**不要**新增 state。

在 `getRuntimeMainLoopModel({...})` 二次调用处（约 39-43 行）：

由于 `useMainLoopModel` 现在内部已经过 `getRuntimeMainLoopModel`，**任何**对 `mainLoopModel`（来自上面 hook）再次套 `getRuntimeMainLoopModel` 的调用都应**删除**，直接使用 `mainLoopModel` 即可。用 Grep + Read 确认 39-43 是否处于使用 hook 输出的位置；如是，删除该 `runtimeModel` 中间变量、所有引用改为 `mainLoopModel`。

> 注意 StatusLine 也是较大文件，逐处用 Edit 替换；不要整文件重写。

- [ ] **Step 3：编译**

Run: `bun run dev:restore-check`
Expected: 0 errors.

- [ ] **Step 4：手动 smoke test**

Run: `bun run dev`
- 启动后 TUI 应正常显示状态栏，无空行 / 无 "undefined"。
- `Ctrl+C` 退出。

- [ ] **Step 5：提交**

```bash
git add src/components/StatusLine.tsx
git commit -m "fix(statusline): 适配 useMainLoopModel 新签名，消除双重 runtime 解析

useMainLoopModel 现已内部执行 getRuntimeMainLoopModel；
StatusLine 不再重复套一层（避免两条解析路径分歧）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8：`/model` 决策分发抽离为纯函数 + 测试

**Files:**
- Create: `src/commands/model/handlers.ts`（导出纯决策函数 `decideAndSwitch`）
- Create: `src/commands/model/handlers.test.ts`

- [ ] **Step 1：先写测试**

Create `src/commands/model/handlers.test.ts`：

```ts
import { test, expect, mock } from 'bun:test'
import { decideAndSwitch, type DecideContext } from './handlers.js'
import type { ModelProfile } from '../../utils/customApiStorage.js'

function makeCtx(profile?: ModelProfile): DecideContext {
  return {
    findProfile: (model: string) => (profile && model === profile.model ? profile : null),
    switchModelProfileAtomicBound: mock(async () => {}),
    switchTierBound: mock(() => {}),
    syncModelConfigToDisk: mock(() => {}),
    setAppState: mock(() => {}),
  }
}

test('input = matching profile name → switchModelProfileAtomicBound called', async () => {
  const profile: ModelProfile = { model: 'deepseek-chat' }
  const ctx = makeCtx(profile)
  await decideAndSwitch('deepseek-chat', ctx)
  expect(ctx.switchModelProfileAtomicBound).toHaveBeenCalledTimes(1)
  expect(ctx.switchTierBound).not.toHaveBeenCalled()
})

test('input = "haiku" alias → switchTierBound("haiku") called', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('haiku', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledTimes(1)
  expect(ctx.switchTierBound).toHaveBeenCalledWith('haiku', expect.anything())
  expect(ctx.switchModelProfileAtomicBound).not.toHaveBeenCalled()
})

test('input = "default" → switchTierBound(null)', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('default', ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith(null, expect.anything())
})

test('input = bare unknown model (no matching profile, not an alias) → setAppState + syncToDisk only', async () => {
  const ctx = makeCtx()
  await decideAndSwitch('gpt-4o', ctx)
  expect(ctx.switchModelProfileAtomicBound).not.toHaveBeenCalled()
  expect(ctx.switchTierBound).not.toHaveBeenCalled()
  expect(ctx.setAppState).toHaveBeenCalledTimes(1)
  expect(ctx.syncModelConfigToDisk).toHaveBeenCalledWith('gpt-4o', false)
})

test('input = null (reset) → switchTierBound(null)', async () => {
  const ctx = makeCtx()
  await decideAndSwitch(null, ctx)
  expect(ctx.switchTierBound).toHaveBeenCalledWith(null, expect.anything())
})
```

- [ ] **Step 2：运行，应 FAIL（handlers.ts 未存在）**

Run: `bun test src/commands/model/handlers.test.ts`
Expected: 5 fail.

- [ ] **Step 3：实现 handlers.ts**

Create `src/commands/model/handlers.ts`：

```ts
import type { ModelProfile } from '../../utils/customApiStorage.js'
import type { TierAlias } from '../../utils/model/switchModelProfile.js'

export type ModelInput = string | null

export interface DecideContext {
  /** Look up a ModelProfile by its `model` field. Returns null if no match. */
  findProfile: (model: string) => ModelProfile | null
  switchModelProfileAtomicBound: (
    profile: ModelProfile,
    syncToDisk: (model: string, clearCredentials: boolean) => void,
  ) => Promise<void>
  switchTierBound: (
    tier: TierAlias,
    syncToDisk: (model: string, clearCredentials: boolean) => void,
  ) => void
  syncModelConfigToDisk: (model: string, clearCredentials: boolean) => void
  setAppState: (updater: (prev: any) => any) => void
}

const TIER_ALIASES = new Set(['opus', 'sonnet', 'haiku'])

/**
 * Dispatch /model input to the correct path:
 *   P1 — matched ModelProfile → atomic profile switch
 *   P2 — tier alias / null    → switchTier
 *   P3 — bare unknown string  → AppState + sync only (no env touch)
 *
 * This function is pure (effects only via injected ctx). model.tsx wires it
 * to the live bindings; tests pass mocks.
 */
export async function decideAndSwitch(input: ModelInput, ctx: DecideContext): Promise<void> {
  if (input === null || input === 'default') {
    ctx.switchTierBound(null, ctx.syncModelConfigToDisk)
    return
  }
  if (TIER_ALIASES.has(input)) {
    ctx.switchTierBound(input as TierAlias, ctx.syncModelConfigToDisk)
    return
  }
  const profile = ctx.findProfile(input)
  if (profile) {
    await ctx.switchModelProfileAtomicBound(profile, ctx.syncModelConfigToDisk)
    return
  }
  // P3: bare unknown model string — write AppState + persist, no env mutation.
  ctx.syncModelConfigToDisk(input, false)
  ctx.setAppState((prev: any) => ({
    ...prev,
    mainLoopModel: input,
    mainLoopModelForSession: null,
  }))
}
```

- [ ] **Step 4：测试应全绿**

Run: `bun test src/commands/model/handlers.test.ts`
Expected: 5 pass.

- [ ] **Step 5：提交**

```bash
git add src/commands/model/handlers.ts src/commands/model/handlers.test.ts
git commit -m "feat(model): 抽离 /model 决策分发为纯函数 decideAndSwitch

三条路径明确化：
- P1 profile 命中 → switchModelProfileAtomic（原子事务）
- P2 alias / null → switchTier（不动 env）
- P3 裸 unknown 字符串 → AppState + sync，不动 env

为 model.tsx 内的 handleSelect/setModel 提供可测试的决策内核。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9：在 `model.tsx` 内调用 `decideAndSwitch`

**Files:**
- Modify: `src/commands/model/model.tsx`（handleSelect + setModel，两处调用）

⚠️ **该文件是 React compiler 编译产物**。改动方法：

1. 用 `rg -n "handleSelect|function setModel" src/commands/model/model.tsx` 定位精确行。
2. 用 Read 读取目标函数体（取上下文 ±30 行）。
3. 找到现有的"清理 env / 调用 applyModelProfile / setAppState"那段编译输出代码，整段替换为对 `decideAndSwitch` 的单次调用。
4. **保留**外层的 `t2 = function ...` / 闭包参数 / logEvent 调用——只换函数体内的副作用块。

- [ ] **Step 1：在文件顶部 import 区（行 22 后）添加**

Use Edit on `src/commands/model/model.tsx`：

Old:
```ts
import { getAPIProvider } from '../../utils/model/providers.js';
```

New:
```ts
import { getAPIProvider } from '../../utils/model/providers.js';
import { decideAndSwitch } from './handlers.js';
import {
  switchModelProfileAtomicBound,
  switchTierBound,
} from '../../utils/model/switchModelProfile.bindings.ts';
import { readCustomApiStorage } from '../../utils/customApiStorage.js';
import { setAppState } from '../../state/AppState.js';
```

> 如果 `.bindings.ts` 不能直接 import，改为 `.bindings.js`（ESM module specifier 风格统一）。

- [ ] **Step 2：在 `handleSelect` 函数体里**

定位形如：
```ts
t2 = function handleSelect(model, effort) {
  logEvent("tengu_model_command_menu", { ... });
  // ... 原有 env 清理 / applyModelProfile / setAppState 等
}
```

把"原有 env 清理 / applyModelProfile / setAppState"整段替换为：

```ts
const profiles = readCustomApiStorage().modelProfiles ?? []
const findProfile = (m) => profiles.find((p) => p.model === m) ?? null
await decideAndSwitch(model, {
  findProfile,
  switchModelProfileAtomicBound,
  switchTierBound,
  syncModelConfigToDisk,
  setAppState,
}).catch((e) => {
  // Surface a toast; do not bubble up so the UI does not crash.
  try {
    if (typeof setToast === 'function') {
      setToast(e?.message ?? String(e))
    } else {
      // eslint-disable-next-line no-console
      console.error(e)
    }
  } catch {}
})
```

> `setToast` / `logEvent` 等已存在的辅助保留不动。如果 `handleSelect` 不是 async，把外层签名加 `async` 关键字。effort 参数继续按原逻辑处理（不在本任务范围）。

- [ ] **Step 3：在 `setModel` 函数体里**

同样定位、替换为：

```ts
const profiles = readCustomApiStorage().modelProfiles ?? []
const findProfile = (m) => profiles.find((p) => p.model === m) ?? null
await decideAndSwitch(modelValue, {
  findProfile,
  switchModelProfileAtomicBound,
  switchTierBound,
  syncModelConfigToDisk,
  setAppState,
}).catch((e) => {
  try { console.error(e) } catch {}
})
```

把 `setModel` 签名加 `async`，调用方按需加 `await`/`.then`。

- [ ] **Step 4：编译检查**

Run: `bun run dev:restore-check`
Expected: 0 errors.

- [ ] **Step 5：跑所有相关测试**

Run:
```bash
bun test src/utils/model/profileEnvKeys.test.ts \
         src/utils/model/switchModelProfile.test.ts \
         src/hooks/useMainLoopModel.test.ts \
         src/commands/model/handlers.test.ts
```
Expected: 全绿。

- [ ] **Step 6：手动 smoke**

Run: `bun run dev`
- 启动 → `/model` → 切到任一 profile → 确认状态栏立刻显示新 model。
- `/model haiku` → 状态栏显示当前 profile 的 haiku 对应 model（或 fallback 到 ANTHROPIC_MODEL）。
- 不出现崩溃 / 不出现旧 profile 残留。

- [ ] **Step 7：提交**

```bash
git add src/commands/model/model.tsx
git commit -m "fix(model): /model 切换走 decideAndSwitch 事务路径

handleSelect 与 setModel 现统一通过 decideAndSwitch 分发到
P1 (atomic profile switch) / P2 (tier alias) / P3 (bare model)，
消除跨 profile env var 残留导致的状态栏错位。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10：onChangeAppState 广播 modelChanged signal（兜底）

**Files:**
- Modify: `src/state/onChangeAppState.ts:94-112`

非必需，但作为可观测兜底，便于未来订阅者强制刷新。

- [ ] **Step 1：在 `mainLoopModel` 两个分支内追加 emit**

Use Edit on `src/state/onChangeAppState.ts`：

定位 94-112 段。在两段 `setMainLoopModelOverride(...)` 调用之后各加一行：

Old (block #1):
```ts
    updateSettingsForSource('userSettings', { model: undefined })
    setMainLoopModelOverride(null)
```

New (block #1):
```ts
    updateSettingsForSource('userSettings', { model: undefined })
    setMainLoopModelOverride(null)
    emitModelChanged()
```

Old (block #2):
```ts
    updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    setMainLoopModelOverride(newState.mainLoopModel)
```

New (block #2):
```ts
    updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    setMainLoopModelOverride(newState.mainLoopModel)
    emitModelChanged()
```

在文件 import 区域（顶部）追加：

```ts
import { emitModelChanged } from './modelChangedSignal.js'
```

- [ ] **Step 2：新建 signal 模块**

Create `src/state/modelChangedSignal.ts`：

```ts
type Listener = () => void
const listeners = new Set<Listener>()

export function onModelChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitModelChanged(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* swallow; signal is best-effort */
    }
  }
}
```

- [ ] **Step 3：编译检查**

Run: `bun run dev:restore-check`
Expected: 0 errors.

- [ ] **Step 4：提交**

```bash
git add src/state/onChangeAppState.ts src/state/modelChangedSignal.ts
git commit -m "feat(state): 广播 modelChanged signal 作为可观测兜底

mainLoopModel 变化时 emit；StatusLine 已通过 useAppState 自动
重渲染，此 signal 主要为未来订阅者（如外部状态镜像）提供 hook。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11：全量回归 + 手动验证脚本

- [ ] **Step 1：跑所有新测试**

Run:
```bash
bun test src/utils/model/profileEnvKeys.test.ts \
         src/utils/model/switchModelProfile.test.ts \
         src/hooks/useMainLoopModel.test.ts \
         src/commands/model/handlers.test.ts
```
Expected: 共 20 pass，0 fail（2 + 9 + 6 + 5 = 22… 以实际为准；任何 fail 必须定位修复，不允许带病提交）。

- [ ] **Step 2：执行手动验证脚本**

按 `docs/superpowers/specs/2026-06-29-model-switch-fix-manual-verify.md` 9 步逐一执行。

**核心通过条件**：
- 第 5 步 deepseek-profile + /model haiku → 状态栏显示 `deepseek-chat`，**不**出现 qwen 残留。
- 第 7 步 API 实际 model ID === 状态栏文本。
- 第 8 步只读磁盘切换失败时 env + 状态栏均保持旧值。

- [ ] **Step 3：把验证日志/截图归档**

将验证过程的关键证据（debug log 片段、TUI 截图）写入 `docs/superpowers/specs/2026-06-29-model-switch-fix-verification-log.md`。

- [ ] **Step 4：提交验证日志**

```bash
git add docs/superpowers/specs/2026-06-29-model-switch-fix-verification-log.md
git commit -m "docs: 模型切换修复手动验证记录

逐步执行 9 步手动脚本的通过证据，包括 debug log 片段与状态栏文本对照。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5：分支检查**

Run:
```bash
git log --oneline main..HEAD
git status
```
Expected:
- 11 个 task 对应的多个 commits 列出（每个 task 1-3 个 commit）。
- working tree clean。
- 分支仍为 `feat/model-switch-fix`，未合并入 main（与用户要求一致）。

---

## Self-Review Checklist

### Spec 覆盖

- §1.1 状态栏一致性 → Task 6 + Task 7 + Task 9 ✅
- §1.2 兜底切换原子事务（清/应用/持久化/AppState/回滚） → Task 1 + Task 2 + Task 3 + Task 4 ✅
- §1.3 Tier 切换纯净性 → Task 1 白名单 + Task 3 switchTier 测试 ✅
- §1.4 EffortLevel 不被覆盖 → Task 1 测试显式断言 ✅
- §1.5 .credentials.json 单一源头 → 未引入新文件；现有 customApiStorage 不动 ✅
- §2 受影响文件 → 11 个文件全部在某个 Task 中 ✅
- §3 数据流 P1/P2/P3 → Task 8 decideAndSwitch 三分支 ✅
- §4 错误处理 → Task 3 三个回滚分支 + Task 9 catch toast ✅
- §5 测试矩阵 → Task 1/2/3/6/8 ✅
- §5.D 手动脚本 → Task 11 ✅

### Placeholder 扫描

- 无 TBD / TODO / "implement later"
- 每个代码步骤都有完整代码块
- 每个 grep / edit 步骤都给出精确命令与预期行号
- 跨 task 引用的类型 / 函数名一致（`switchModelProfileAtomicBound` / `switchTierBound` / `decideAndSwitch` / `resolveMainLoopModel` / `ModelSwitchError`）

### 类型 / 签名一致性

- `switchModelProfileAtomic(profile, deps)` — Task 3 定义，Task 4 bindings 用同样签名，Task 8 handlers context 调用 `switchModelProfileAtomicBound(profile, syncToDisk)` 形式一致。
- `switchTier(tier, deps)` — Task 3 定义，Task 4 bindings、Task 8 handlers 调用 `switchTierBound(tier, syncToDisk)` 一致。
- `resolveMainLoopModel(input)` 接口字段与 `useMainLoopModel(opts)` 一致：`permissionMode` + `exceeds200kTokens`。
- `decideAndSwitch(input, ctx)` 的 `ctx` 字段与 Task 9 model.tsx 注入的对象字段名相同。

### 风险点已显式说明

- model.tsx 是编译产物 → Task 9 顶部红框警告。
- 项目无 test 入口 → 用 bun 内置 runner，无需配置。
- onChangeAppState 的 signal 是兜底，不依赖它达成正确性 → Task 10 描述明确。

---

**计划完成，保存到 `docs/superpowers/plans/2026-06-29-model-switch-fix.md`。两种执行方式：**

1. **Subagent-Driven（推荐）**：每个 task 派发独立 subagent + 两阶段 review，迭代快、上下文干净。
2. **Inline Execution**：在当前会话内逐 task 执行，分批 checkpoint 给你 review。

**选哪种？**

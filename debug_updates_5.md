# DOGE-CODE 调试修改日志

## 2026-07-14 TUI 卡顿修复（/clear 与 /model）

用户在 `E:\python_project`（非 git 仓库，19 万文件）等目录下执行 `/clear` 或 `/model` 时，TUI 出现数秒级卡顿。经两轮排查，根因分布在两个独立层面：**skills 配置目录扫描** 与 **文件索引重建触发 Windows Defender IO 饱和**。

---

### 问题现象

- 在文件数较多的目录（尤其是非 git 大目录）启动 `doge` 后，执行 `/clear` 或 `/model` 出现明显卡顿，基本到数秒级别。
- 在 `~/.doge/skills` 下因 `claude-to-im` / `claude-to-im-core` 两个 skill 各自带 `node_modules`（合计 1 万+文件），`/clear` 后冷重扫这些目录耗时显著。

### 根因（两层）

#### 层一：skills 目录扫描未跳过 node_modules

`loadMarkdownFiles` 使用 ripgrep 以 `--no-ignore` 全量递归扫描配置目录（commands / agents / output-styles / skills 等），不跳过 `node_modules`。当 `dir = ~/.doge/skills` 时，遍历 `claude-to-im*` 的 `node_modules`（1 万+文件），找到并读取数百个无关 `.md`。

`/clear` 经 `clearSessionCaches` -> `clearCommandsCache` -> `clearSkillCaches` 清空 `loadMarkdownFilesForSubdir` 的 memoize 缓存，导致下一次系统提示构建/typeahead 挂载时冷重扫。

#### 层二：/clear 复用了为 resume 设计的 fileIndex 全清

`clearFileSuggestionCaches` 原本是为 resume/--continue 设计（可能切换 cwd，需全量重新发现文件）。`/clear` 复用了它，把 `fileIndex` 置空、`lastRefreshMs` 重置为 0，导致 typeahead 重挂载时节流失效、立即触发 `getPathsForSuggestions`：

- 非 git 仓库 -> `getFilesUsingGit` 返回 null -> 走 ripgrep 兜底**全量扫描整个 cwd**（`E:\python_project` = 19 万文件）。
- ripgrep 读取 19 万文件触发 **Windows Defender 实时扫描所有文件**，磁盘 IO 饱和持续数秒。
- 同期主线程的同步文件操作（`getProjectDirsUpToHome` 的 `statSync`、`getMemoryFiles` 的 `realpathSync`/`readdir`）在 IO 饱和下每个 10-100ms（`loadSkillsDir.ts:647` 注释自承），累积数秒卡顿。

`/model` 命令本身不清缓存、不触发扫描（已确认 `src/commands/model/` 与 `ModelPicker.tsx` 均无相关调用），卡顿来自 `/clear` 触发的 Defender 扫描仍在后台跑时，`/model` 的文件操作被 IO 拖慢——**与 `/clear` 同源**。

---

### 修改 1: skills 扫描跳过 node_modules（ripgrep 路径）

**文件**: `src/utils/markdownConfigLoader.ts`
**行号**: L587-594
**内容**: ripgrep 参数追加 `--glob '!node_modules/'`，剪枝 `node_modules` 子树。尾斜杠表示目录，ripgrep 在遍历剪枝阶段直接跳过整棵子树，不进入子目录再过滤。语法与 `src/hooks/fileSuggestions.ts` 已有的 `'!.git/'` 排除写法一致。

```diff
       ? await findMarkdownFilesNative(dir, signal)
       : await ripGrep(
-          ['--files', '--hidden', '--follow', '--no-ignore', '--glob', '*.md'],
+          [
+            '--files',
+            '--hidden',
+            '--follow',
+            '--no-ignore',
+            '--glob',
+            '*.md',
+            // Skip dependency trees: claude-to-im skills ship node_modules with
+            // 5K+ files each (~10K total under ~/.doge/skills), and --no-ignore
+            // would otherwise traverse every file. The trailing slash matches a
+            // directory, so ripgrep prunes the whole subtree without entering it.
+            '--glob',
+            '!node_modules/',
+          ],
           dir,
           signal,
         )
```

实测（`~/.doge/skills`）：命中 md 文件 663 -> 88，ripgrep 单次耗时 73ms -> 17ms。

---

### 修改 2: native fallback 同步跳过 node_modules

**文件**: `src/utils/markdownConfigLoader.ts`
**行号**: L517-521
**内容**: `CLAUDE_CODE_USE_NATIVE_FILE_SEARCH=1` 或 rg 不可用时的兜底 `findMarkdownFilesNative` 递归遍历同样跳过 `node_modules`，与 ripgrep 路径保持一致，避免兜底时同样卡顿。

```diff
           } else if (entry.isDirectory()) {
+            // Skip dependency directories (e.g. claude-to-im skills ship
+            // node_modules with 5K+ files). Mirrors ripgrep's !node_modules/ glob
+            // so the native fallback stays fast when rg is unavailable.
+            if (entry.name === 'node_modules') continue
             await walk(fullPath)
           } else if (entry.isFile() && entry.name.endsWith('.md')) {
```

---

### 修改 3: loadMarkdownFilesForSubdir 补 setImmediate 延迟

**文件**: `src/utils/markdownConfigLoader.ts`
**行号**: L305-313
**内容**: `getProjectDirsUpToHome` 用同步 `statSync` 循环上行遍历，Windows + 杀软下每个 10-100ms。`getSkillDirCommands`（`loadSkillsDir.ts:643-652`）已用 `setImmediate` 延迟该调用避免 TUI 冻结，但 `loadMarkdownFilesForSubdir` 直接同步调用未延迟。补上对齐已有缓解。

```diff
     const userDir = join(getClaudeConfigHomeDir(), subdir)
     const managedDir = join(getManagedFilePath(), '.claude', subdir)
-    const projectDirs = getProjectDirsUpToHome(subdir, cwd)
+    // Yield before the sync statSync walk: getProjectDirsUpToHome calls statSync
+    // in a loop walking up from cwd, and resolveStopBoundary can trigger
+    // findGitRoot which does a sync statSync walk to the filesystem root when
+    // outside a git repo. On Windows each statSync can take 10-100ms with
+    // antivirus, freezing the TUI after /clear (which clears this memoize cache).
+    // Aligns with the setImmediate mitigation already used in getSkillDirCommands
+    // (loadSkillsDir.ts:643-652).
+    const projectDirs = await new Promise<string[]>(resolve =>
+      setImmediate(() => resolve(getProjectDirsUpToHome(subdir, cwd))),
+    )
```

---

### 修改 4: clearFileSuggestionCaches 软清（保留 fileIndex）

**文件**: `src/hooks/fileSuggestions.ts`
**行号**: L80-108
**内容**: `clearFileSuggestionCaches` 加 `soft` 参数。`soft=true`（`/clear`）保留 `fileIndex` / `lastRefreshMs` / `lastGitIndexMtime` / `loadedTrackedSignature` / `loadedMergedSignature` / `cachedTrackedFiles` / `cachedConfigFiles` / `cachedTrackedDirs`，让 `startBackgroundCacheRefresh` 的节流命中并跳过重建。`soft=false`（resume/--continue，cwd 可能变）保持全清。

```diff
-export function clearFileSuggestionCaches(): void {
-  fileIndex = null
-  fileListRefreshPromise = null
-  cacheGeneration++
-  untrackedFetchPromise = null
-  cachedTrackedFiles = []
-  cachedConfigFiles = []
-  cachedTrackedDirs = []
-  indexBuildComplete.clear()
-  ignorePatternsCache = null
-  ignorePatternsCacheKey = null
-  lastRefreshMs = 0
-  lastGitIndexMtime = null
-  loadedTrackedSignature = null
-  loadedMergedSignature = null
-}
+export function clearFileSuggestionCaches(soft = false): void {
+  // Always abort any in-flight refresh and bump generation so stale results
+  // don't overwrite a future rebuild. ignorePatternsCache is cheap to recompute.
+  fileListRefreshPromise = null
+  cacheGeneration++
+  untrackedFetchPromise = null
+  indexBuildComplete.clear()
+  ignorePatternsCache = null
+  ignorePatternsCacheKey = null
+
+  if (soft) {
+    return
+  }
+
+  fileIndex = null
+  cachedTrackedFiles = []
+  cachedConfigFiles = []
+  cachedTrackedDirs = []
+  lastRefreshMs = 0
+  lastGitIndexMtime = null
+  loadedTrackedSignature = null
+  loadedMergedSignature = null
+}
```

---

### 修改 5: clearSessionCaches 传递 softFileIndex 选项

**文件**: `src/commands/clear/caches.ts`
**行号**: L47-49, L58-61
**内容**: `clearSessionCaches` 加 `options.softFileIndex`，仅在 `/clear` 传 `true`。`main.tsx` 两处 resume 调用不传参，默认 `false`，行为不变。

```diff
 export function clearSessionCaches(
   preservedAgentIds: ReadonlySet<string> = new Set(),
+  options: { softFileIndex?: boolean } = {},
 ): void {
   ...
-  // Clear file suggestion caches (for @ mentions)
-  clearFileSuggestionCaches()
+  // Clear file suggestion caches (for @ mentions). soft=true keeps the file
+  // index so /clear doesn't force a rescan on the next typeahead mount.
+  clearFileSuggestionCaches(options.softFileIndex === true)
```

---

### 修改 6: /clear 传 softFileIndex

**文件**: `src/commands/clear/conversation.ts`
**行号**: L128
**内容**: `/clear` 调用处传 `softFileIndex: true`。`/clear` 不改 cwd（`conversation.ts:131` 用 `getOriginalCwd()`），fileIndex 本可保留。

```diff
-  clearSessionCaches(preservedAgentIds)
+  clearSessionCaches(preservedAgentIds, { softFileIndex: true })
```

---

### 修改 7: 非 git 兜底 ripgrep 加 --max-depth

**文件**: `src/hooks/fileSuggestions.ts`
**行号**: L502-514
**内容**: `getProjectFiles` 在非 git 仓库走 ripgrep 兜底时（`getFilesUsingGit` 返回 null），追加 `--max-depth`。默认 3，可通过 `CLAUDE_CODE_FILE_INDEX_MAX_DEPTH` 调整（设 `0` 关闭限制）。仅影响非 git 兜底；git 仓库走 `git ls-files` 不受影响。

```diff
   if (!respectGitignore) {
     rgArgs.push('--no-ignore-vcs')
   }

+  // Cap recursion depth for non-git dirs. This fallback only runs when there's
+  // no git index, so it otherwise walks the entire cwd - catastrophic for
+  // large non-git dirs (e.g. 190k-file dataset dirs) where it also kicks off
+  // antivirus realtime scans that saturate disk IO and freeze the TUI for
+  // seconds. 3 covers typical source trees; set
+  // CLAUDE_CODE_FILE_INDEX_MAX_DEPTH=0 to disable the cap.
+  const envDepth = process.env.CLAUDE_CODE_FILE_INDEX_MAX_DEPTH
+  const maxDepth =
+    envDepth !== undefined && envDepth !== '' ? Number(envDepth) : 3
+  if (Number.isFinite(maxDepth) && maxDepth > 0) {
+    rgArgs.push('--max-depth', String(Math.floor(maxDepth)))
+  }
+
   const files = await ripGrep(rgArgs, '.', abortSignal)
```

实测（`E:\python_project`，19 万文件）：扫描文件 193110 -> 658（`--max-depth 3`），ripgrep 耗时 820ms -> 40ms。

---

### 卡顿链路完整说明

```
/clear (E:\python_project, 非 git, 19 万文件)
    │
    ├─ 修改前：
    │   clearSessionCaches -> clearFileSuggestionCaches
    │   ├─ fileIndex = null
    │   ├─ lastRefreshMs = 0（节流失效）
    │   └─ TUI 重渲染 -> typeahead 重挂载 -> startBackgroundCacheRefresh
    │       └─ fileIndex 不存在 -> getPathsForSuggestions
    │           └─ getProjectFiles: 非 git -> ripgrep 扫 19 万文件 (820ms)
    │               └─ Windows Defender 实时扫描 19 万文件 -> IO 饱和数秒
    │                   └─ 主线程 statSync/readdir/realpathSync 每个 10-100ms
    │                       └─ 累积数秒卡顿（/clear 和 /model 同源）
    │
    └─ 修改后：
        clearSessionCaches({ softFileIndex: true })
        ├─ 保留 fileIndex + lastRefreshMs + 签名
        └─ typeahead 重挂载 -> startBackgroundCacheRefresh
            └─ fileIndex 存在 + 距上次 <5s + git 状态未变 -> 跳过重建
                └─ 不 ripgrep -> Defender 不扫 -> 主线程文件操作不被拖慢

        （距上次 >5s 仍会 ripgrep，由修改 7 兜底：--max-depth 3 限制为 658 文件）
```

---

### 验证

#### 修改 1-3（skills 跳过 node_modules）

```text
实测 ripgrep 扫描 ~/.doge/skills：
  改动前: 663 个 md, 73ms
  改动后:  88 个 md, 17ms
```

`~/.doge/skills` 顶层 20 个 skill 中仅 `claude-to-im` / `claude-to-im-core` 带 `node_modules`，排除不影响其余 18 个正常 skill。

#### 修改 4-7（/clear 软清 + 大目录限深）

```text
实测 ripgrep 扫描 E:\python_project（非 git, 193110 文件）：
  改动前: 193110 文件, 820ms
  改动后:    658 文件,  40ms  (--max-depth 3)

文件深度分布：
  max-depth 1:   30 文件,  18ms
  max-depth 2:   74 文件,  17ms
  max-depth 3:  658 文件,  27ms
  max-depth 5: 182090 文件, 737ms  ← 暴增点（object_detection_datasets 占 156127 文件）
```

#### 类型检查

```text
bunx tsc --noEmit -p tsconfig.json
-> markdownConfigLoader.ts / fileSuggestions.ts / caches.ts / conversation.ts 均无类型错误
```

#### 交互式手动验证

用户在 `E:\python_project` 下 `bun run dev` 启动后实测：`/clear` 与 `/model` 卡顿消失。

可复现的验证步骤（真实终端）：

1. 在 `E:\python_project`（或任意非 git 大目录）下 `bun run dev` 启动。
2. 连续执行 `/clear` 多次（5 秒内），确认不再卡顿（修改 4-6：节流命中跳过重建）。
3. 开 `--debug`，查 `~/.doge/debug/<sessionId>.txt` 中 `[FileIndex] ripgrep:` 日志行，确认 `658 files in ~40ms` 而非 `193110 files in ~820ms`（修改 7）。
4. `/clear` 后立即 `/model`，确认不再卡顿（同源 IO 拖慢已消除）。

---

### 环境变量

| 变量 | 用途 | 默认 |
|------|------|------|
| `CLAUDE_CODE_FILE_INDEX_MAX_DEPTH` | 非 git 目录 @ 提示索引的最大递归深度。设 `0` 关闭限制（全量扫描）。仅影响非 git 兜底，git 仓库走 `git ls-files` 不受影响 | `3` |

---

### 功能权衡

- **修改 1-3**：无功能损失。`node_modules` 内容本就不应作为 skill/command/agent 加载。
- **修改 4-6**：`/clear` 后文件索引最多过时 5 秒，之后节流刷新 + `pathListSignature` 检测变化才重建。@ 提及准确性要求不高，可接受。
- **修改 7**：非 git 大目录下 `@` 提及深层文件（>3 层）找不到。但 19 万文件目录下全量索引本不实用（大头是数据集文件，非代码）。用户可用 `CLAUDE_CODE_FILE_INDEX_MAX_DEPTH` 调整深度。

---

### 涉及文件

| 文件 | 修改 |
|------|------|
| `src/utils/markdownConfigLoader.ts` | 修改 1-3：ripgrep/native 跳过 node_modules + setImmediate 延迟 |
| `src/hooks/fileSuggestions.ts` | 修改 4、7：clearFileSuggestionCaches 软清 + getProjectFiles max-depth |
| `src/commands/clear/caches.ts` | 修改 5：clearSessionCaches 传递 softFileIndex |
| `src/commands/clear/conversation.ts` | 修改 6：/clear 传 softFileIndex: true |

### 提交

- `3f2f2b3` perf(tui): 扫描 skills 跳过 node_modules 修复 /clear 卡顿
- `a35b827` perf(tui): /clear 软清 fileIndex + 非 git 大目录限深扫描

两提交已合并入 `main`（合并提交 `b1fe50d`）。`start_coding_plan.ps1` 合并冲突取 main 的 `glm-latest`；`start_glm.ps1` 取本分支的 `glm-5.2` 升级。

---

## 2026-07-14 新增 xhigh 思考档位（high 与 max 之间）

### 背景

Anthropic 与 OpenAI 兼容 API 现均已原生支持 `low/medium/high/xhigh/max` 五档 effort。经调研三种接口格式的 effort 传递路径，确认 doge-code 的发送层对 effort 字符串是**纯透传**（无白名单校验），故新增 `xhigh` 为纯客户端枚举扩展，无需任何协议转换。

### 三种接口格式下 effort 的传递路径

| 格式 | effort 位置 | beta header | 调用代码 |
|------|------------|-------------|---------|
| Anthropic `/v1/messages` | `output_config.effort` | ✅ `anthropic-beta: effort-2025-11-24` | `claude.ts:1517` SDK create |
| OpenAI `/v1/chat/completions` | 顶层 `effort` | ❌ 无 | `claude.ts:1901` `createOpenAICompatStream` |
| Responses `/v1/responses` | 顶层 `effort` | ❌ 无 | `claude.ts:1935` `createResponsesCompatStream` |

三处透传点均无枚举过滤，`low/medium/high/xhigh/max` 在三种格式下都能完整发出。OpenAI/Responses 兼容路径只发 `content-type` + `authorization` 头，`betas` 数组在此路径被丢弃--第三方服务从 body 顶层 `effort` 读取，不依赖 beta 开关。

### 决策

1. **Gate 策略 = 与 max 绑定**：xhigh 复用 `modelSupportsMaxEffort`，只有支持 max 的模型（Opus / ant / 配置了 tier capabilities 的第三方模型）才能切到 xhigh 和 max。`ModelPicker` 的 `includeMax` 参数同时控制两者，无需新增参数。
2. **持久化 = 仅当前会话**：xhigh 不写 `settings.json`，`toPersistableEffort('xhigh')` 返回 `undefined`（走默认 case，无需改 Zod schema），自动走 `(this session only)` 分支。

### 改动（7 文件）

| 文件 | 改动 |
|------|------|
| `src/utils/effort.ts` | `EFFORT_LEVELS` 加 `xhigh`；`resolveAppliedEffort` 降级条件含 xhigh（与 max 绑定）；`convertEffortValueToLevel` 加 `<=150` 区间；`getEffortLevelDescription` 加 case |
| `src/entrypoints/sdk/runtimeTypes.ts` | `EffortLevel` 加 `'xhigh'` 字面量 |
| `src/constants/figures.ts` | 新增 `EFFORT_XHIGH = '◎'`（梯度 `○◐●◎◉`） |
| `src/components/EffortIndicator.ts` | import + switch case |
| `src/components/ModelPicker.tsx` | `cycleEffortLevel` 数组加 xhigh；`displayEffort` 降级含 xhigh |
| `src/cli/print.ts` | `supportedEffortLevels` 对不支持 max 的模型同时排除 xhigh |
| `src/commands/effort/effort.tsx` | `/effort` 错误提示与 help 文案加 xhigh |

### 严格未动（符合计划）

Zod schema（`settings/types.ts`）、`toPersistableEffort`、`configureEffortParams`（`claude.ts`）、`openaiCompat.ts`、`responsesCompat.ts`、`EffortCallout.tsx`、`modelSupportsMaxEffort`。xhigh 原样透传给 API，复用 `modelSupportsMaxEffort` 作为 gate。

### 验证

- 7 文件全部 `bun build --noEmit` transpile 通过
- 运行时行为脚本 10/10 通过：`isEffortLevel('xhigh')`=true、`toPersistableEffort('xhigh')`=undefined（session-only）、`resolveAppliedEffort('claude-3-haiku','xhigh')`='high'（gate 降级）、ant-only 数值 `120->xhigh`/`100->high`/`151->max`

### 提交

- `9615a59` feat(effort): 新增 xhigh 思考档位（high 与 max 之间）
- 已合并入 `main`（合并提交 `e71d45c`）

---

## 2026-07-14 原生模型 ID 升级 Opus 4.6->4.8、Sonnet 4.6->5

### 背景

将 doge-code 硬编码的原生（first-party）模型 ID 升级到最新：Opus 4.6 -> **Opus 4.8**，Sonnet 4.6 -> **Sonnet 5**，Haiku 保持 **4.5**。旧 ID 散布在 src/ 数十处（configs/canonical/betas/effort/thinking/context/prompts/migrations 等），需系统替换避免遗漏。

### 覆盖的字段类型

| 类型 | 示例 |
|------|------|
| 模型 ID 字符串 | `claude-opus-4-6` -> `claude-opus-4-8`，短形式 `opus-4-6` -> `opus-4-8`，下划线 `opus_4_6` -> `opus_4_8` |
| bedrock/vertex/foundry ID | `us.anthropic.claude-opus-4-6-v1` -> `us.anthropic.claude-opus-4-8-v1` |
| 常量名 | `CLAUDE_OPUS_4_6_CONFIG` -> `CLAUDE_OPUS_4_8_CONFIG`，`CLAUDE_4_5_OR_4_6_MODEL_IDS` -> `CLAUDE_LATEST_MODEL_IDS` |
| configs key | `opus46` -> `opus48`、`sonnet46` -> `sonnet5`（`getModelStrings().opus48` 全链路同步） |
| 函数/变量名 | `getOpus46PricingSuffix` -> `getOpus48PricingSuffix`、`isOpus46` -> `isOpus48`、`isSonnet46` -> `isSonnet5` |
| env var | `VERTEX_REGION_CLAUDE_4_6_SONNET` -> `VERTEX_REGION_CLAUDE_SONNET_5` |
| UI 文案 | `Opus 4.6` -> `Opus 4.8`、`Sonnet 4.6` -> `Sonnet 5`（大小写均覆盖） |
| migration | `migrateSonnet45ToSonnet46` 重命名为 `migrateSonnet45ToSonnet5`（文件 + 函数 + main.tsx import） |

### 语义修正（非机械替换）

- **canonical 顺序**（`model.ts:276-296`）：替换后 `claude-opus-4-8` 仍在 `claude-opus-4` 前、`claude-sonnet-5` 在 `claude-sonnet-4-5` 前，匹配顺序天然正确
- **modelSupports1M**（`context.ts:62`）：sonnet-5 不被 `claude-sonnet-4` 子串匹配，手动补 `|| includes('claude-sonnet-5')` 分支
- **prompts.ts 文案**：原"The most recent Claude model family is Claude 4.5/4.6"重写为"The most recent Claude models are Opus 4.8, Sonnet 5, and Haiku 4.5"

### 保留未改（有意为之）

- analytics 事件名 `tengu_sonnet45_to_46_migration`、config key `sonnet45To46MigrationTimestamp`：数据 schema 标识，改名会断历史数据连续性
- `docs/superpowers/` 设计文档、`debug_updates_*.md`：历史记录
- 部分编译后 .tsx 末尾的 base64 sourcemap：source-map 恢复项目无 build 流程，无法可靠重生成（仅影响调试行号映射，不影响运行时）

### 涉及范围

- src/ 55 文件（PowerShell 脚本批量替换 + 手动补语义点）
- needs/skills/claude-api/ 19 个文档（API 示例同步升级）
- 1 个文件重命名：`migrateSonnet45ToSonnet46.ts` -> `migrateSonnet45ToSonnet5.ts`

### 验证

- 55 个 .ts/.tsx 全部 `bun build --no-bundle` transpile 通过
- 运行时验证 14/14 通过：configs key 存在（opus48/sonnet5）旧 key 消失（opus46/sonnet46）、canonical 正确识别新 ID 及 bedrock 变体（`us.anthropic.claude-opus-4-8-v1`）、`modelSupports1M` 对 sonnet-5/opus-4-8 返回 true、haiku-4-5 返回 false

### 提交

- `3a0838d` feat(model): 原生模型 ID 升级 Opus 4.6->4.8、Sonnet 4.6->5
- 已合并入 `main`（合并提交 `fd43129`）

### 合并冲突处理

模型升级分支与 xhigh 分支都改动了 effort 相关文件，merge 时 3 处冲突：

| 文件 | 冲突 | 解决 |
|------|------|------|
| `figures.ts` | EFFORT_XHIGH 行（xhigh）vs EFFORT_MAX 注释 4.6->4.8（model） | 保留 XHIGH 行 + MAX 注释用 4.8 |
| `effort.tsx` | help 文案 xhigh 行（xhigh）vs "Opus 4.6 only"->"4.8 only"（model） | 合并：xhigh 行 + "Opus 4.8 only" |
| `effort.ts` | 两分支改相邻行 | auto-merge 正确，xhigh 逻辑与 4.8 文案共存 |

冲突解决后三个文件 transpile 通过，src/ 无冲突标记残留。

## 2026-09-05 OpenAI/Responses 转接层多模态图片修复

### 现象

经 `openai` / `responses` 转接层使用多模态模型时，Read 工具读图片后模型"看不到"图片，自述收到的是"一大段 base64 编码的像素数据以及附加的元数据"。

### 根因

`src/services/api/openaiCompat.ts` 与 `responsesCompat.ts` 的请求转换从未处理 image 块：

1. **tool_result 图片被 JSON.stringify 成文本**：FileReadTool 读图片返回 `content: [{type:'image', source:{type:'base64',...}}]` 数组，两个转换函数对非字符串 content 一律 `JSON.stringify`，模型收到的正是 base64 数据 + `type`/`source`/`media_type` 元数据的 JSON 文本——与现象描述完全吻合。
2. **user 消息 image 块被静默丢弃**：`contentToText` 对 image 块返回空串，用户直接粘贴的图片经转接层后消失。

### 修复

协议约束：Chat Completions 的 `role:'tool'` 消息与 Responses API 的 `function_call_output.output` 都只接受字符串，图片不能放在 tool 消息内。两个协议的标准做法是把图片作为紧随 tool 消息之后的 `user` 消息携带。

- `openaiCompat.ts` 新增导出 `imageBlockToImageURL`（base64→data URL、url→透传）与 `splitToolResultContent`（拆分 tool_result 文本与图片）：
  - tool_result：文本进 tool 消息（无文本且有图时给 `(tool returned image content)` 占位），图片转为 `{type:'image_url', image_url:{url:'data:...'}}` 紧随其后放 user 多部分消息
  - user 消息：含图时 content 变为 `[text?, ...image_url]` 多部分数组；纯文本请求保持原字符串形状（网关兼容）
- `responsesCompat.ts` 复用上述辅助，图片转 `{type:'input_image', image_url:'data:...'}`（Responses 的 `image_url` 是裸字符串，与 Chat Completions 的对象包装不同）
- 无图/纯文本请求的形状与修复前逐字节一致（有回归测试保护）

### 测试

- 新增 9 个用例：tool_result 纯图 / 文本+图混合、user 文本+图、url 图透传、纯文本形状回归（两协议各一套）
- `bun test src/services/api/ src/commands/model/ src/utils/model/ src/hooks/` 77 pass / 0 fail
- `bun run version` 冒烟通过；tsc 对改动文件无新错误（仓库既有的 bun types / baseUrl 配置报错与本次无关）

## 2026-09-05 Computer Use 永久开启与 Windows zoom 修复

参考 [niejiaqiang/claude-code-haha](https://github.com/niejiaqiang/claude-code-haha) 的 Computer Use 架构文档（其核心是"保留官方 MCP 工具定义与安全关卡、替换底层执行、绕过灰度门控"）逐层核对后发现，doge 的 CU 门控只放开了表层，真正的挡板在后面；另有一个让包彻底 import 失败的坏 shim 和一个 Windows zoom 静默失败 bug。

### 问题（四层）

1. **MCP server 默认禁用（"默认关闭"的根因）**：`gates.ts` 的 `getChicagoEnabled()` 已硬编码 `true`、`main.tsx` 也注入了 server 配置，但 `src/services/mcp/config.ts` 的 `isDefaultDisabledBuiltin` 把 `computer-use` 列为"默认禁用的内置 server"——`client.ts:2239` 连接时因 `isMcpServerDisabled` 默认返回 true 直接标记 `disabled` 不连接，工具从不进模型列表，必须去 `/mcp` 手动启用。即 haha 文档所述"第 9 层判决 Gate"。
2. **`@ant/computer-use-mcp` 包 import 必挂**：`shims/ant-computer-use-mcp/index.ts` 用 `export * from '../../../packages/...'`（三级上跳出仓库），Bun 按真实路径解析时指向仓库外 → `client.ts` 动态 import 静默失败。`ant-computer-use-input` 同病。
3. **第三方端点无 CU 提示**：官方 Anthropic 后端检测 `mcp__computer-use__*` 工具名会注入 CU 可用性提示（在服务端），openai/responses 转接层没有——模型不知道这些工具的存在与用法，更不会 screenshot→act→verify 循环。
4. **Windows zoom 静默返回空图**：`handleZoom` 的 image-px→logical 比率转换产生非整数坐标（如 1106.0266），`platforms/win32.ts` 的 `captureRegion` 把非整数直接插进 PowerShell 的 `.NET Bitmap(int,int)` 构造，脚本挂掉后 catch 分支返回 `{base64:''}`——模型收到空图且无任何错误信息。

### 修复

- `src/services/mcp/config.ts`：`isDefaultDisabledBuiltin` 恒 `return false`（haha 同款绕过），删除 dead require。`computer-use` 变为普通 server 语义：默认启用，仍可经 `/mcp` 禁用（`disabledMcpServers`）；历史 `enabledMcpServers` 残留条目无害。
- `package.json`：`@ant/computer-use-mcp` / `@ant/computer-use-input` 的 `file:` 依赖从 shims 改指 `packages/@ant/` 真包（两者本就自足），删除两个坏 shim；`bun install` 后 node_modules 为硬拷贝，彻底消除 symlink 解析歧义。
- `src/utils/computerUse/setup.ts`：新增导出 `COMPUTER_USE_MCP_PROMPT_HINT`（request_access 先行、screenshot→观察→操作→verify 循环、坐标取自截图图像像素、zoom 放大、computer_batch 批量）；`src/main.tsx` 在注入 CU MCP 时无条件 append 进 system prompt（官方直连重复注入无害）。
- `src/utils/computerUse/platforms/win32.ts`：`captureRegion`/`captureScreen` 对所有插值坐标与尺寸 `Math.round()`；`captureRegion` 失败改为 throw（带 PS 输出摘要）而非静默空图。

### 测试

- 新增 `src/services/mcp/config.test.ts` 6 用例：默认启用（always-on 核心断言）、显式禁用/恢复、普通 server 语义不变、遗留 `enabledMcpServers` 兼容、`setupComputerUseMCP` 输出完整工具集（stdio/dynamic + 全部 `mcp__computer-use__` 前缀 + 核心工具在列）、本地 hint 覆盖工作流要点。
- 新增 `test/computer-use-e2e.ts`（可复用实机验证脚本，只读操作）：MCP 协议层 ListTools（in-process server + linked transport，24 个工具）、`bindSessionContext` 真实 dispatch 链的 screenshot（1389×868 JPEG 落盘验证）/ zoom（修复前 0 字符，修复后有图）/ cursor_position / 跨会话锁获取与释放。锁与临时产物隔离在 `test/tmp-cu-e2e-config`，结束即清。
- `bun test src/services/api/ src/utils/model/ src/commands/model/ src/hooks/ src/services/mcp/` 103 pass / 0 fail；`bun run version` 冒烟通过。

## 2026-09-09 auto 会话全放行：plan 模式放行 + CU 自动授权 + plan 审批恢复 auto

用户四点需求：① auto 会话 CU request_access 仍弹授权框；② auto 会话模型切到 plan 模式后 list/grep/bash 等又逐个问权限；③ plan 审批框（用户审核计划）必须保留，auto 也不许放行；④ auto 会话 plan 审批后应直接以 auto 权限继续（旧版静默降级 acceptEdits），普通会话则缺一个"以 auto 权限执行"的选项。

### 修复（单一共享判定 + 三个接缝）

- **共享判定** `src/utils/permissions/autoBypass.ts`（新增）：`isAutoBypassActive(ctx)` = mode==='bypassPermissions'，或 mode==='plan' 且（prePlanMode==='bypassPermissions' || isBypassPermissionsModeAvailable）。信号选 `prePlanMode`（EnterPlanModeTool/`prepareContextForPlanMode` 在 auto 会话进入 plan 时 stash 为 'bypassPermissions'），不设 `isBypassPermissionsModeAvailable`（避免旗标会话的 bypass 继承等副作用泄漏进 /auto）。退出 plan 后残留的 prePlanMode 无害：判定仅在 mode==='plan' 时读它。
- **②中央管道**（`permissions.ts` 2a 步）：内联的 shouldBypassPermissions 换成 isAutoBypassActive —— auto 会话进 plan 后工具全放行。管道顺序天然保住 ③：deny 规则（1a）、显式 ask 规则（1b/1f）、safetyCheck（1g）与 requiresUserInteraction（1e，ExitPlanMode 审批框）都先于 2a 返回。
- **①CU 接缝**（`wrapper.tsx` runPermissionDialog 入口）：auto 会话短路掉 ComputerUseApproval 对话框，`src/utils/computerUse/autoGrant.ts`（新增）按对话框 "Allow for this session" 的精确语义构造响应（resolved 应用全授权、不带 tier 由包内 getDefaultTierForApp 回填、未安装 → not_installed、truthy requestedFlags 授予、sentinel 只警告所以照授）；`req.tccState`（macOS OS 级权限缺失）仍弹窗——auto 授不了 OS 权限。授权合并/持久化仍由包侧 wrappedPermissionHandler 完成。
- **④plan 审批框**（`ExitPlanModePermissionRequest.tsx`）：新增 `autoSession`（prePlanMode==='bypassPermissions' 且未禁用）与 `canBypass`（!isBypassPermissionsModeDisabled）参数进 `buildPlanApprovalOptions`。**最终语义（用户实测后修订：审批框必须罗列全部执行模式供用户选择，auto 不代选不放行）**——auto 会话选项依次为 "Yes, and stay in auto mode"（值 yes-auto-mode-keep-context → bypassPermissions）、"Yes, and auto-accept edits"（值 yes-accept-edits-keep-context → acceptEdits，**用户选了就落 acceptEdits，不因 prePlanMode 自动改映射**）、"Yes, manually approve edits"；普通会话默认首选项保持 auto-accept edits，canBypass 且非旗标会话时追加 "Yes, and use auto mode"（同值 yes-auto-mode-keep-context）与 clear-context 变体（yes-bypass-permissions）。clear-context 的 yes-accept-edits 恒落 acceptEdits；空计划路径（无模式列表）审批后按 autoSession 恢复 bypass 防降级；Shift+Tab 选 options[0]（auto 会话首项即"保持 auto"，仍是用户主动按键）。onAllow 的 setMode 更新先于 tool.call() 应用（PermissionContext.handleUserAllow→persistPermissions），对话框映射即最终模式，ExitPlanModeV2Tool.call() 的 prePlanMode 恢复退居 hook 直通时的兜底（两者语义一致）。模式解析集中导出 `resolvePlanApprovalMode`（旗标会话的 bypass 选项沿用上游 yes-accept-edits-keep-context 映射，受 isBypassPermissionsModeDisabled() 约束）。

### 不改的（有意）

- 桥接/SDK 的 set_permission_mode('bypassPermissions') 仍要求旗标会话（useReplBridge/print.ts）——远程端可用 /auto 命令达成同样效果。
- Shift+Tab 轮播从 auto 进 plan 需经过 acceptEdits（prePlanMode='acceptEdits'，plan 内照常问权限）：那是用户显式离开 auto 后再进 plan，与"模型在 auto 会话里自动进 plan"（prePlanMode='bypassPermissions'）刻意区分。

### 测试

- 新增 22 用例：`autoBypass.test.ts`（判定矩阵 5）、`permissions.autoBypass.test.ts`（管道集成 4：plan+prePlanMode 放行 / 纯 plan 仍 ask / 直接 bypass 放行 / requiresUserInteraction 工具在 auto+plan 仍 ask）、`autoGrant.test.ts`（授权构造 5）、`ExitPlanModePermissionRequest.test.tsx`（选项罗列与模式解析 8：auto 会话 stay-auto 首选且 accept-edits 并列可选、clear-context 同、普通会话追加 auto 选项、禁用时不出现、旗标会话保持上游、keep-planning 常在、解析矩阵含「auto 会话选 accept-edits 不被改映射」）
- `bun test src/` 412+ pass / 0 fail；改动模块 import 检查通过；`bun run version` 冒烟通过

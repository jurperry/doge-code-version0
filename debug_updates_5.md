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

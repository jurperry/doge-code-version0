/**
 * Portable session storage utilities.
 *
 * Pure Node.js — no internal dependencies on logging, experiments, or feature
 * flags. Shared between the CLI (src/utils/sessionStorage.ts) and the VS Code
 * extension (packages/claude-vscode/src/common-host/sessionStorage.ts).
 */

import type { UUID } from 'crypto'
import {
  mkdir,
  open as fsOpen,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import { djb2Hash } from './hash.js'

/** Size of the head/tail buffer for lite metadata reads. */
export const LITE_READ_BUF_SIZE = 65536

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

// ---------------------------------------------------------------------------
// JSON string field extraction — no full parse, works on truncated lines
// ---------------------------------------------------------------------------

/**
 * Unescape a JSON string value extracted as raw text.
 * Only allocates a new string when escape sequences are present.
 */
export function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw
  try {
    return JSON.parse(`"${raw}"`)
  } catch {
    return raw
  }
}

/**
 * Extracts a simple JSON string field value from raw text without full parsing.
 * Looks for `"key":"value"` or `"key": "value"` patterns.
 * Returns the first match, or undefined if not found.
 */
export function extractJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    const valueStart = idx + pattern.length
    let i = valueStart
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i))
      }
      i++
    }
  }
  return undefined
}

/**
 * Like extractJsonStringField but finds the LAST occurrence.
 * Useful for fields that are appended (customTitle, tag, etc.).
 */
export function extractLastJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  let lastValue: string | undefined
  for (const pattern of patterns) {
    let searchFrom = 0
    while (true) {
      const idx = text.indexOf(pattern, searchFrom)
      if (idx < 0) break

      const valueStart = idx + pattern.length
      let i = valueStart
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === '"') {
          lastValue = unescapeJsonString(text.slice(valueStart, i))
          break
        }
        i++
      }
      searchFrom = i + 1
    }
  }
  return lastValue
}

// ---------------------------------------------------------------------------
// First prompt extraction from head chunk
// ---------------------------------------------------------------------------

/**
 * Pattern matching auto-generated or system messages that should be skipped
 * when looking for the first meaningful user prompt. Matches anything that
 * starts with a lowercase XML-like tag (IDE context, hook output, task
 * notifications, channel messages, etc.) or a synthetic interrupt marker.
 */
const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/

/**
 * Extracts the first meaningful user prompt from a JSONL head chunk.
 *
 * Skips tool_result messages, isMeta, isCompactSummary, command-name messages,
 * and auto-generated patterns (session hooks, tick, IDE metadata, etc.).
 * Truncates to 200 chars.
 */
export function extractFirstPromptFromHead(head: string): string {
  let start = 0
  let commandFallback = ''
  while (start < head.length) {
    const newlineIdx = head.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? head.slice(start, newlineIdx) : head.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : head.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"'))
      continue
    if (line.includes('"tool_result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue
    if (
      line.includes('"isCompactSummary":true') ||
      line.includes('"isCompactSummary": true')
    )
      continue

    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type !== 'user') continue

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) continue

      const content = message.content
      const texts: string[] = []
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text as string)
          }
        }
      }

      for (const raw of texts) {
        let result = raw.replace(/\n/g, ' ').trim()
        if (!result) continue

        // Skip slash-command messages but remember first as fallback
        const cmdMatch = COMMAND_NAME_RE.exec(result)
        if (cmdMatch) {
          if (!commandFallback) commandFallback = cmdMatch[1]!
          continue
        }

        // Format bash input with ! prefix before the generic XML skip
        const bashMatch = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(result)
        if (bashMatch) return `! ${bashMatch[1]!.trim()}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) continue

        if (result.length > 200) {
          result = result.slice(0, 200).trim() + '\u2026'
        }
        return result
      }
    } catch {
      continue
    }
  }
  if (commandFallback) return commandFallback
  return ''
}

// ---------------------------------------------------------------------------
// File I/O — read head and tail of a file
// ---------------------------------------------------------------------------

/**
 * Reads the first and last LITE_READ_BUF_SIZE bytes of a file.
 *
 * For small files where head covers tail, `tail === head`.
 * Accepts a shared Buffer to avoid per-file allocation overhead.
 * Returns `{ head: '', tail: '' }` on any error.
 */
export async function readHeadAndTail(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<{ head: string; tail: string }> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return { head: '', tail: '' }

      const head = buf.toString('utf8', 0, headResult.bytesRead)

      const tailOffset = Math.max(0, fileSize - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      return { head, tail }
    } finally {
      await fh.close()
    }
  } catch {
    return { head: '', tail: '' }
  }
}

export type LiteSessionFile = {
  mtime: number
  size: number
  head: string
  tail: string
}

/**
 * Opens a single session file, stats it, and reads head + tail in one fd.
 * Allocates its own buffer — safe for concurrent use with Promise.all.
 * Returns null on any error.
 */
export async function readSessionLite(
  filePath: string,
): Promise<LiteSessionFile | null> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      const stat = await fh.stat()
      const buf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return null

      const head = buf.toString('utf8', 0, headResult.bytesRead)
      const tailOffset = Math.max(0, stat.size - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      return { mtime: stat.mtime.getTime(), size: stat.size, head, tail }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

/**
 * Maximum length for a single filesystem path component (directory or file name).
 * Most filesystems (ext4, APFS, NTFS) limit individual components to 255 bytes.
 * We use 200 to leave room for the hash suffix and separator.
 */
export const MAX_SANITIZED_LENGTH = 200

function simpleHash(str: string): string {
  return Math.abs(djb2Hash(str)).toString(36)
}

// Append `-<hash>` when the encoded name would exceed filesystem component
// limits. Hash is computed over the *source* path so it is stable across
// encode variants. Shared by sanitizePath (v2) and legacySanitizePath (v1).
function withTruncationHash(encoded: string, source: string): string {
  if (encoded.length <= MAX_SANITIZED_LENGTH) {
    return encoded
  }
  const hash =
    typeof Bun !== 'undefined' ? Bun.hash(source).toString(36) : simpleHash(source)
  return `${encoded.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

const plainCharRegex = /[a-zA-Z0-9-]/

function percentEscape(ch: string): string {
  const hex = Buffer.from(ch, 'utf8').toString('hex')
  let out = ''
  for (let i = 0; i < hex.length; i += 2) {
    out += '%' + hex.slice(i, i + 2)
  }
  return out
}

/**
 * Encodes a project path as a filesystem-safe directory name (v2, 2026-09-06).
 *
 * v1 replaced every non-alphanumeric character with '-', which made the
 * result ambiguous: `E:\a-b` and `E:\a\b` both encoded to `E--a-b`, so the
 * real path could not be recovered from the directory name alone (hyphens in
 * folder names vs. path separators). v2 is injective and reversible:
 *
 *   - path separators (`\` and `/`) encode to `~`
 *   - `~` itself encodes as `%7e`, so `~` always means "separator"
 *   - every other non-alphanumeric character percent-escapes its UTF-8 bytes
 *     as `%xx` (multi-byte characters become consecutive escapes)
 *   - `[a-zA-Z0-9]` and `-` stay literal
 *
 * Example: `E:\ClaudeCode\doge-code` → `E%3a~ClaudeCode~doge-code`
 * (the hyphen inside `doge-code` survives, unlike v1).
 *
 * Deeply nested paths that would exceed filesystem limits (255 bytes per
 * component) truncate and append a hash suffix for uniqueness, mirroring v1.
 * decodeProjectDirName reverses this encoding.
 *
 * Writes always use v2. Directories named with v1 remain readable through
 * the legacySanitizePath fallback in findProjectDir.
 *
 * @param name - The string to encode (e.g., '/Users/foo/my-project')
 * @returns An encoded name (e.g., '~Users~foo~my-project')
 */
export function sanitizePath(name: string): string {
  let encoded = ''
  for (const ch of name) {
    if (ch === '\\' || ch === '/') {
      encoded += '~'
    } else if (plainCharRegex.test(ch)) {
      encoded += ch
    } else {
      encoded += percentEscape(ch)
    }
  }
  return withTruncationHash(encoded, name)
}

/**
 * v1 encoding (pre-2026-09-06): every non-alphanumeric character → '-'.
 * Preserved verbatim so directories created before the v2 switch stay
 * discoverable — see findProjectDir / sanitizePathCandidates.
 */
export function legacySanitizePath(name: string): string {
  return withTruncationHash(name.replace(/[^a-zA-Z0-9]/g, '-'), name)
}

/**
 * Candidate directory names for a project path, in preference order:
 * the v2 encoding first (current writes), then v1 (legacy reads).
 * A single entry when both variants coincide.
 */
export function sanitizePathCandidates(name: string): string[] {
  const v2 = sanitizePath(name)
  const v1 = legacySanitizePath(name)
  return v1 === v2 ? [v2] : [v2, v1]
}

/**
 * Inverse of sanitizePath. Joins segments with `sep` (`\\` by default —
 * pass `path.sep` on POSIX). Returns undefined for malformed input (a `%`
 * not followed by two hex digits). Names that were truncated with a hash
 * suffix decode with a literal `-<hash>` tail, so treat the result as a
 * strong hint, not a guarantee (verify with existsSync where it matters).
 */
export function decodeProjectDirName(
  name: string,
  sep: string = '\\',
): string | undefined {
  const sepChar = sep === '/' ? '/' : '\\'
  const bytes: number[] = []
  let out = ''
  const flushBytes = () => {
    if (bytes.length > 0) {
      out += Buffer.from(bytes).toString('utf8')
      bytes.length = 0
    }
  }
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!
    if (ch === '~') {
      flushBytes()
      out += sepChar
    } else if (ch === '%') {
      const hex = name.slice(i + 1, i + 3)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined
      bytes.push(parseInt(hex, 16))
      i += 2
    } else {
      flushBytes()
      out += ch
    }
  }
  flushBytes()
  return out
}

// ---------------------------------------------------------------------------
// One-time migration: v1-named project dirs → v2 encoding
// ---------------------------------------------------------------------------

export type ProjectDirMigrationResult = {
  renamed: number
  merged: number
  skipped: number
}

/**
 * Rename legacy v1-named project directories (~/.doge/projects/<v1>) to
 * their v2-encoded names, so existing data converges on the unambiguous
 * naming instead of living forever in the read-compat fallback.
 *
 * A v1 name cannot be reversed (that is the flaw v2 fixes), so the real
 * path is recovered from the `cwd` field of the jsonl files inside the
 * directory — newest session wins and decides the target for the whole
 * dir. Two distinct real paths that already collide into one v1 name (a
 * pre-existing v1 flaw) migrate together, preserving current behavior.
 *
 *   target missing → atomic dir rename (everything inside moves with it:
 *                    sessions, <uuid>/ sidecars, archived/, memory/, casts)
 *   target exists  → merge contents file-by-file; newest mtime wins on a
 *                    name collision; source rmdir'd when empty
 *   no cwd recoverable (no jsonl), or dir locked by a live session
 *   (EPERM/EBUSY on Windows) → skip, the next startup retries
 *
 * Idempotent and cheap to re-run: v2 names always contain `~` and are
 * rejected by the name check alone; v1 dirs without sessions never read
 * a single jsonl byte.
 */
export async function migrateLegacyProjectDirs(): Promise<ProjectDirMigrationResult> {
  const result: ProjectDirMigrationResult = {
    renamed: 0,
    merged: 0,
    skipped: 0,
  }
  const projectsDir = getProjectsDir()
  let dirents
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return result // no projects dir yet — nothing to migrate
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const name = dirent.name
    // v1 names are [a-zA-Z0-9-] only; every v2 name contains a `~`
    // (absolute paths have at least one separator). Skip dot-dirs too.
    if (name.startsWith('.') || name.includes('~') || name.includes('%')) {
      continue
    }
    const src = join(projectsDir, name)
    try {
      const cwd = await recoverProjectCwdFromDir(src)
      if (!cwd) {
        result.skipped++
        continue
      }
      const target = join(projectsDir, sanitizePath(cwd))
      if (target === src) continue // already encoded (v1 === v2 form)
      let targetExists = false
      try {
        await readdir(target)
        targetExists = true
      } catch {
        // target absent — rename path below
      }
      if (!targetExists) {
        try {
          await rename(src, target)
          result.renamed++
          continue
        } catch (err) {
          if (!isRacedOrTargetAppeared(err)) throw err
          // raced: another concurrent CLI migrated (ENOENT) or created the
          // target between our check and rename — fall through to merge
        }
      }
      await mergeProjectDirInto(src, target)
      result.merged++
    } catch {
      // locked by a live session / permission error — retry next startup
      result.skipped++
    }
  }
  return result
}

function isRacedOrTargetAppeared(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY'
}

/** Newest-first scan for a `cwd` field in the dir's session jsonls. */
async function recoverProjectCwdFromDir(
  pdir: string,
): Promise<string | undefined> {
  const candidates: { path: string; mtime: number }[] = []
  for (const base of [pdir, join(pdir, 'archived')]) {
    try {
      const files = await readdir(base)
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        try {
          const st = await stat(join(base, f))
          candidates.push({ path: join(base, f), mtime: st.mtimeMs })
        } catch {
          // raced deletion
        }
      }
    } catch {
      // no such subdir (e.g. archived/)
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const c of candidates) {
    const lite = await readSessionLite(c.path)
    if (!lite) continue
    const cwd = extractJsonStringField(lite.head, 'cwd')
    if (cwd) return cwd
  }
  return undefined
}

/** Move every entry of `src` into `dest`; newest mtime wins on collision. */
async function mergeProjectDirInto(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      let exists = false
      try {
        await readdir(to)
        exists = true
      } catch {
        // dest subdir absent — plain rename below
      }
      if (exists) await mergeProjectDirInto(from, to)
      else await rename(from, to)
    } else {
      let destNewerOrEqual = false
      try {
        const [fromStat, toStat] = await Promise.all([stat(from), stat(to)])
        destNewerOrEqual = toStat.mtimeMs >= fromStat.mtimeMs
      } catch {
        // dest file absent — overwrite by rename below
      }
      if (destNewerOrEqual) {
        // dest wins the collision — drop the superseded copy so the source
        // dir can be removed and the migration converges
        try {
          await unlink(from)
        } catch {
          // raced away — nothing to clean
        }
        continue
      }
      try {
        await rename(from, to)
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
          throw err
        }
      }
    }
  }
  try {
    await rmdir(src)
  } catch {
    // leftover entries (locked) — next migration run continues the merge
  }
}

// ---------------------------------------------------------------------------
// Project directory discovery (shared by listSessions & getSessionMessages)
// ---------------------------------------------------------------------------

export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

export function getProjectDir(projectDir: string): string {
  return join(getProjectsDir(), sanitizePath(projectDir))
}

/**
 * Resolves a directory path to its canonical form using realpath + NFC
 * normalization. Falls back to NFC-only if realpath fails (e.g., the
 * directory doesn't exist yet). Ensures symlinked paths (e.g.,
 * /tmp → /private/tmp on macOS) resolve to the same project directory.
 */
export async function canonicalizePath(dir: string): Promise<string> {
  try {
    return (await realpath(dir)).normalize('NFC')
  } catch {
    return dir.normalize('NFC')
  }
}

/**
 * Finds the project directory for a given path. Tries the v2 encoding
 * first (current writes), then the v1 encoding for directories created
 * before the 2026-09-06 switch. For each variant, tolerates hash-suffix
 * mismatches on long paths (>200 chars): the CLI uses Bun.hash while the
 * SDK under Node.js uses simpleHash, which produce different suffixes for
 * paths exceeding MAX_SANITIZED_LENGTH — prefix-based scanning covers both.
 */
export async function findProjectDir(
  projectPath: string,
): Promise<string | undefined> {
  const projectsDir = getProjectsDir()
  for (const sanitized of sanitizePathCandidates(projectPath)) {
    const found = await findProjectDirByEncodedName(projectsDir, sanitized)
    if (found) return found
  }
  return undefined
}

async function findProjectDirByEncodedName(
  projectsDir: string,
  sanitized: string,
): Promise<string | undefined> {
  const exact = join(projectsDir, sanitized)
  try {
    await readdir(exact)
    return exact
  } catch {
    // Exact match failed — for short names this means no sessions exist.
    // For long names, try prefix matching to handle hash mismatches.
    if (sanitized.length <= MAX_SANITIZED_LENGTH) {
      return undefined
    }
    const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH)
    try {
      const dirents = await readdir(projectsDir, { withFileTypes: true })
      const match = dirents.find(
        d => d.isDirectory() && d.name.startsWith(prefix + '-'),
      )
      return match ? join(projectsDir, match.name) : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Resolve a sessionId to its on-disk JSONL file path.
 *
 * When `dir` is provided: canonicalize it, look in that project's directory
 * (with findProjectDir fallback for Bun/Node hash mismatches), then fall back
 * to sibling git worktrees. `projectPath` in the result is the canonical
 * user-facing directory the file was found under.
 *
 * When `dir` is omitted: scan all project directories under ~/.claude/projects/.
 * `projectPath` is undefined in this case (no meaningful project path to report).
 *
 * Existence is checked by stat (operate-then-catch-ENOENT, no existsSync).
 * Zero-byte files are treated as not-found so callers continue searching past
 * a truncated copy to find a valid one in a sibling directory.
 *
 * `fileSize` is returned so callers (loadSessionBuffer) don't need to re-stat.
 *
 * Shared by getSessionInfoImpl and getSessionMessagesImpl — the caller
 * invokes its own reader (readSessionLite / loadSessionBuffer) on the
 * resolved path.
 */
export async function resolveSessionFilePath(
  sessionId: string,
  dir?: string,
): Promise<
  | { filePath: string; projectPath: string | undefined; fileSize: number }
  | undefined
> {
  const fileName = `${sessionId}.jsonl`

  if (dir) {
    const canonical = await canonicalizePath(dir)
    const projectDir = await findProjectDir(canonical)
    if (projectDir) {
      const filePath = join(projectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0)
          return { filePath, projectPath: canonical, fileSize: s.size }
      } catch {
        // ENOENT/EACCES — keep searching
      }
    }
    // Worktree fallback — sessions may live under a different worktree root
    let worktreePaths: string[]
    try {
      worktreePaths = await getWorktreePathsPortable(canonical)
    } catch {
      worktreePaths = []
    }
    for (const wt of worktreePaths) {
      if (wt === canonical) continue
      const wtProjectDir = await findProjectDir(wt)
      if (!wtProjectDir) continue
      const filePath = join(wtProjectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0) return { filePath, projectPath: wt, fileSize: s.size }
      } catch {
        // ENOENT/EACCES — keep searching
      }
    }
    return undefined
  }

  // No dir — scan all project directories
  const projectsDir = getProjectsDir()
  let dirents: string[]
  try {
    dirents = await readdir(projectsDir)
  } catch {
    return undefined
  }
  for (const name of dirents) {
    const filePath = join(projectsDir, name, fileName)
    try {
      const s = await stat(filePath)
      if (s.size > 0)
        return { filePath, projectPath: undefined, fileSize: s.size }
    } catch {
      // ENOENT/ENOTDIR — not in this project, keep scanning
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Compact-boundary chunked read (shared by loadTranscriptFile & SDK getSessionMessages)
// ---------------------------------------------------------------------------

/** Chunk size for the forward transcript reader. 1 MB balances I/O calls vs buffer growth. */
const TRANSCRIPT_READ_CHUNK_SIZE = 1024 * 1024

/**
 * File size below which precompact filtering is skipped.
 * Large sessions (>5 MB) almost always have compact boundaries — they got big
 * because of many turns triggering auto-compact.
 */
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024

/** Marker bytes searched for when locating the boundary. Lazy: allocated on
 * first use, not at module load. Most sessions never resume. */
let _compactBoundaryMarker: Buffer | undefined
function compactBoundaryMarker(): Buffer {
  return (_compactBoundaryMarker ??= Buffer.from('"compact_boundary"'))
}

/**
 * Confirm a byte-matched line is a real compact_boundary (marker can appear
 * inside user content) and check for preservedSegment.
 */
function parseBoundaryLine(
  line: string,
): { hasPreservedSegment: boolean } | null {
  try {
    const parsed = JSON.parse(line) as {
      type?: string
      subtype?: string
      compactMetadata?: { preservedSegment?: unknown }
    }
    if (parsed.type !== 'system' || parsed.subtype !== 'compact_boundary') {
      return null
    }
    return {
      hasPreservedSegment: Boolean(parsed.compactMetadata?.preservedSegment),
    }
  } catch {
    return null
  }
}

/**
 * Single forward chunked read for the --resume load path. Attr-snap lines
 * are skipped at the fd level; compact boundaries truncate in-stream. Peak
 * is the output size, not the file size.
 *
 * The surviving (last) attr-snap is appended at EOF instead of in-place;
 * restoreAttributionStateFromSnapshots only reads [length-1] so position
 * doesn't matter.
 */

type Sink = { buf: Buffer; len: number; cap: number }

function sinkWrite(s: Sink, src: Buffer, start: number, end: number): void {
  const n = end - start
  if (n <= 0) return
  if (s.len + n > s.buf.length) {
    const grown = Buffer.allocUnsafe(
      Math.min(Math.max(s.buf.length * 2, s.len + n), s.cap),
    )
    s.buf.copy(grown, 0, 0, s.len)
    s.buf = grown
  }
  src.copy(s.buf, s.len, start, end)
  s.len += n
}

function hasPrefix(
  src: Buffer,
  prefix: Buffer,
  at: number,
  end: number,
): boolean {
  return (
    end - at >= prefix.length &&
    src.compare(prefix, 0, prefix.length, at, at + prefix.length) === 0
  )
}

const ATTR_SNAP_PREFIX = Buffer.from('{"type":"attribution-snapshot"')
const SYSTEM_PREFIX = Buffer.from('{"type":"system"')
const LF = 0x0a
const LF_BYTE = Buffer.from([LF])
const BOUNDARY_SEARCH_BOUND = 256 // marker sits ~28 bytes in; 256 is slack

type LoadState = {
  out: Sink
  boundaryStartOffset: number
  hasPreservedSegment: boolean
  lastSnapSrc: Buffer | null // most-recent attr-snap, appended at EOF
  lastSnapLen: number
  lastSnapBuf: Buffer | undefined
  bufFileOff: number // file offset of buf[0]
  carryLen: number
  carryBuf: Buffer | undefined
  straddleSnapCarryLen: number // per-chunk; reset by processStraddle
  straddleSnapTailEnd: number
}

// Line spanning the chunk seam. 0 = fall through to concat.
function processStraddle(
  s: LoadState,
  chunk: Buffer,
  bytesRead: number,
): number {
  s.straddleSnapCarryLen = 0
  s.straddleSnapTailEnd = 0
  if (s.carryLen === 0) return 0
  const cb = s.carryBuf!
  const firstNl = chunk.indexOf(LF)
  if (firstNl === -1 || firstNl >= bytesRead) return 0
  const tailEnd = firstNl + 1
  if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
    s.straddleSnapCarryLen = s.carryLen
    s.straddleSnapTailEnd = tailEnd
    s.lastSnapSrc = null
  } else if (s.carryLen < ATTR_SNAP_PREFIX.length) {
    return 0 // too short to rule out attr-snap
  } else {
    if (hasPrefix(cb, SYSTEM_PREFIX, 0, s.carryLen)) {
      const hit = parseBoundaryLine(
        cb.toString('utf-8', 0, s.carryLen) +
          chunk.toString('utf-8', 0, firstNl),
      )
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true
      } else if (hit) {
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
      }
    }
    sinkWrite(s.out, cb, 0, s.carryLen)
    sinkWrite(s.out, chunk, 0, tailEnd)
  }
  s.bufFileOff += s.carryLen + tailEnd
  s.carryLen = 0
  return tailEnd
}

// Strip attr-snaps, truncate on boundaries. Kept lines write as runs.
function scanChunkLines(
  s: LoadState,
  buf: Buffer,
  boundaryMarker: Buffer,
): { lastSnapStart: number; lastSnapEnd: number; trailStart: number } {
  let boundaryAt = buf.indexOf(boundaryMarker)
  let runStart = 0
  let lineStart = 0
  let lastSnapStart = -1
  let lastSnapEnd = -1
  let nl = buf.indexOf(LF)
  while (nl !== -1) {
    const lineEnd = nl + 1
    if (boundaryAt !== -1 && boundaryAt < lineStart) {
      boundaryAt = buf.indexOf(boundaryMarker, lineStart)
    }
    if (hasPrefix(buf, ATTR_SNAP_PREFIX, lineStart, lineEnd)) {
      sinkWrite(s.out, buf, runStart, lineStart)
      lastSnapStart = lineStart
      lastSnapEnd = lineEnd
      runStart = lineEnd
    } else if (
      boundaryAt >= lineStart &&
      boundaryAt < Math.min(lineStart + BOUNDARY_SEARCH_BOUND, lineEnd)
    ) {
      const hit = parseBoundaryLine(buf.toString('utf-8', lineStart, nl))
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true // don't truncate; preserved msgs already in output
      } else if (hit) {
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff + lineStart
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
        lastSnapStart = -1
        s.straddleSnapCarryLen = 0
        runStart = lineStart
      }
      boundaryAt = buf.indexOf(
        boundaryMarker,
        boundaryAt + boundaryMarker.length,
      )
    }
    lineStart = lineEnd
    nl = buf.indexOf(LF, lineStart)
  }
  sinkWrite(s.out, buf, runStart, lineStart)
  return { lastSnapStart, lastSnapEnd, trailStart: lineStart }
}

// In-buf snap wins over straddle (later in file). carryBuf still valid here.
function captureSnap(
  s: LoadState,
  buf: Buffer,
  chunk: Buffer,
  lastSnapStart: number,
  lastSnapEnd: number,
): void {
  if (lastSnapStart !== -1) {
    s.lastSnapLen = lastSnapEnd - lastSnapStart
    if (s.lastSnapBuf === undefined || s.lastSnapLen > s.lastSnapBuf.length) {
      s.lastSnapBuf = Buffer.allocUnsafe(s.lastSnapLen)
    }
    buf.copy(s.lastSnapBuf, 0, lastSnapStart, lastSnapEnd)
    s.lastSnapSrc = s.lastSnapBuf
  } else if (s.straddleSnapCarryLen > 0) {
    s.lastSnapLen = s.straddleSnapCarryLen + s.straddleSnapTailEnd
    if (s.lastSnapBuf === undefined || s.lastSnapLen > s.lastSnapBuf.length) {
      s.lastSnapBuf = Buffer.allocUnsafe(s.lastSnapLen)
    }
    s.carryBuf!.copy(s.lastSnapBuf, 0, 0, s.straddleSnapCarryLen)
    chunk.copy(s.lastSnapBuf, s.straddleSnapCarryLen, 0, s.straddleSnapTailEnd)
    s.lastSnapSrc = s.lastSnapBuf
  }
}

function captureCarry(s: LoadState, buf: Buffer, trailStart: number): void {
  s.carryLen = buf.length - trailStart
  if (s.carryLen > 0) {
    if (s.carryBuf === undefined || s.carryLen > s.carryBuf.length) {
      s.carryBuf = Buffer.allocUnsafe(s.carryLen)
    }
    buf.copy(s.carryBuf, 0, trailStart, buf.length)
  }
}

function finalizeOutput(s: LoadState): void {
  if (s.carryLen > 0) {
    const cb = s.carryBuf!
    if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
      s.lastSnapSrc = cb
      s.lastSnapLen = s.carryLen
    } else {
      sinkWrite(s.out, cb, 0, s.carryLen)
    }
  }
  if (s.lastSnapSrc) {
    if (s.out.len > 0 && s.out.buf[s.out.len - 1] !== LF) {
      sinkWrite(s.out, LF_BYTE, 0, 1)
    }
    sinkWrite(s.out, s.lastSnapSrc, 0, s.lastSnapLen)
  }
}

export async function readTranscriptForLoad(
  filePath: string,
  fileSize: number,
): Promise<{
  boundaryStartOffset: number
  postBoundaryBuf: Buffer
  hasPreservedSegment: boolean
}> {
  const boundaryMarker = compactBoundaryMarker()
  const CHUNK_SIZE = TRANSCRIPT_READ_CHUNK_SIZE

  const s: LoadState = {
    out: {
      // Gated callers enter with fileSize > 5MB, so min(fileSize, 8MB) lands
      // in [5, 8]MB; large boundaryless sessions (24-31MB output) take 2
      // grows. Ungated callers (attribution.ts) pass small files too — the
      // min just right-sizes the initial buf, no grows.
      buf: Buffer.allocUnsafe(Math.min(fileSize, 8 * 1024 * 1024)),
      len: 0,
      // +1: finalizeOutput may insert one LF between a non-LF-terminated
      // carry and the reordered last attr-snap (crash-truncated file).
      cap: fileSize + 1,
    },
    boundaryStartOffset: 0,
    hasPreservedSegment: false,
    lastSnapSrc: null,
    lastSnapLen: 0,
    lastSnapBuf: undefined,
    bufFileOff: 0,
    carryLen: 0,
    carryBuf: undefined,
    straddleSnapCarryLen: 0,
    straddleSnapTailEnd: 0,
  }

  const chunk = Buffer.allocUnsafe(CHUNK_SIZE)
  const fd = await fsOpen(filePath, 'r')
  try {
    let filePos = 0
    while (filePos < fileSize) {
      const { bytesRead } = await fd.read(
        chunk,
        0,
        Math.min(CHUNK_SIZE, fileSize - filePos),
        filePos,
      )
      if (bytesRead === 0) break
      filePos += bytesRead

      const chunkOff = processStraddle(s, chunk, bytesRead)

      let buf: Buffer
      if (s.carryLen > 0) {
        const bufLen = s.carryLen + (bytesRead - chunkOff)
        buf = Buffer.allocUnsafe(bufLen)
        s.carryBuf!.copy(buf, 0, 0, s.carryLen)
        chunk.copy(buf, s.carryLen, chunkOff, bytesRead)
      } else {
        buf = chunk.subarray(chunkOff, bytesRead)
      }

      const r = scanChunkLines(s, buf, boundaryMarker)
      captureSnap(s, buf, chunk, r.lastSnapStart, r.lastSnapEnd)
      captureCarry(s, buf, r.trailStart)
      s.bufFileOff += r.trailStart
    }
    finalizeOutput(s)
  } finally {
    await fd.close()
  }

  return {
    boundaryStartOffset: s.boundaryStartOffset,
    postBoundaryBuf: s.out.buf.subarray(0, s.out.len),
    hasPreservedSegment: s.hasPreservedSegment,
  }
}

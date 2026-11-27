/**
 * Regenerate `doge-code-install/`: the minimal install source that can be copied to
 * another computer on its own (`bun install --frozen-lockfile && bun link`).
 *
 * Everything in it is mirrored byte-for-byte from the tracked tree, so the manifest
 * below is the single source of truth for what ships. Run it on a committed tree:
 * the README header then names the last commit the sources came from.
 *
 *   bun tools/sync-install-source.ts            rewrite doge-code-install/
 *   bun tools/sync-install-source.ts --check    fail if it is stale, ignored or uncommitted
 *   bun tools/sync-install-source.ts --verify   also install a copy outside the repo and run it
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dir, '..')
const target = join(root, 'doge-code-install')
const tool = 'bun tools/sync-install-source.ts'

/** Tracked trees shipped whole, minus test files. */
const TREES = [
  'src',
  'packages/@ant/computer-use-input',
  'packages/@ant/computer-use-mcp',
  'shims',
  'vendor/modifiers-napi-src',
  'vendor/url-handler-src',
] as const
/** Tracked root files copied as they are. */
const ROOT_FILES = ['package.json', 'bun.lock', 'tsconfig.json'] as const
/** Tracked root files that ship only in a rewritten form (see `rewrite`). */
const REWRITTEN: readonly string[] = ['bunfig.toml', '.gitattributes']
/** Tests never ship; kept out of every pathspec so a test-only commit never moves the baseline. */
const NOT_SHIPPED = [
  ':(exclude,glob)**/*.test.ts', ':(exclude,glob)**/*.test.tsx',
  ':(exclude,glob)**/*.spec.ts', ':(exclude,glob)**/*.spec.tsx',
] as const
const TEST_FILE = /\.(?:test|spec)\.tsx?$/
/** Hand-maintained prose; only the block between its markers is generated. */
const README = 'README.md'
const START = '<!-- sync:start -->'
const END = '<!-- sync:end -->'
/** Never part of the snapshot, even when someone installed dependencies in place. */
const SKIPPED_DIRS = new Set(['node_modules', '.git'])
const SANDBOX_PREFIX = 'doge-code-install-'
const USAGE = '用法：bun tools/sync-install-source.ts [--check] [--verify] [--allow-dirty]'

interface Command { code: number | null; stdout: Buffer; stderr: Buffer }
interface Info { version: string; commit: string; date: string; files: number; dirty: boolean }
interface Snapshot { files: Map<string, Buffer>; info: Info }
interface Drift { missing: string[]; changed: string[]; stale: string[] }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const tail = (command: Command): string => `${command.stdout.toString()}${command.stderr.toString()}`.trim().slice(-2000)
const local = (...parts: string[]) => join(root, ...parts)
const targetFile = (relative: string) => join(target, ...relative.split('/'))
const toPosix = (path: string) => path.split('\\').join('/')

function git(input?: Uint8Array, ...args: string[]): Command {
  const proc = Bun.spawnSync(['git', ...args], { cwd: root, stdin: input, stdout: 'pipe', stderr: 'pipe' })
  return { code: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr }
}
function gitText(...args: string[]): string {
  const proc = git(undefined, ...args)
  if (proc.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${proc.stderr.toString().trim()}`)
  return proc.stdout.toString()
}
/** Paths (relative to the repo) that .gitignore really keeps out. */
function ignored(paths: string[]): Set<string> {
  const proc = git(Buffer.from(`${paths.join('\0')}\0`), 'check-ignore', '-v', '-z', '--no-index', '--stdin')
  if (proc.code !== 0 && proc.code !== 1) throw new Error(`git check-ignore 失败：${proc.stderr.toString().trim()}`)
  const fields = proc.stdout.toString().split('\0')
  const result = new Set<string>()
  // 每条记录是「来源、行号、规则、路径」；被否定规则（!…）命中的是重新纳入的文件，不算
  for (let index = 0; index + 3 < fields.length; index += 4) {
    if (!fields[index + 2].startsWith('!')) result.add(fields[index + 3])
  }
  return result
}

function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, base, out)
    else out.push(toPosix(relative(base, full)))
  }
  return out
}

/**
 * Two root files ship in a rewritten form: the distribution has no tests to preload,
 * and as a byte-for-byte mirror it must not be flagged for whitespace that lives in
 * the sources themselves. A checkout may turn either into CRLF (core.autocrlf), so
 * rewrite on LF and put the original line endings back.
 */
function rewrite(relative: string, text: string): string {
  const crlf = text.includes('\r\n')
  const lines = crlf ? text.replaceAll('\r\n', '\n') : text
  const body = relative === '.gitattributes'
    ? `${lines.replace(/\s*$/, '')}\n# 本目录是已跟踪源码的逐字节镜像，空白问题随源码走，不在镜像里修\n* -whitespace\n`
    : withoutTestSection(lines)
  return crlf ? body.replaceAll('\n', '\r\n') : body
}

function withoutTestSection(text: string): string {
  const kept: string[] = []
  let skipping = false
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) skipping = /^\s*\[test\]\s*$/.test(line)
    if (!skipping) kept.push(line)
  }
  return `${kept.join('\n').replace(/\s*$/, '')}\n\n# 注：本分发不含测试与 tools/，故不配置 [test] preload；测试请使用完整仓库 doge-code。\n`
}

function withSyncBlock(readme: string, info: Info): string {
  const start = readme.indexOf(START)
  const end = readme.indexOf(END)
  if (start === -1 || end < start) throw new Error(`${README} 缺少 ${START} / ${END} 标记`)
  const eol = readme.includes('\r\n') ? '\r\n' : '\n'
  const block = [
    START,
    `> **当前版本** \`${info.version}\` · 源码等同 \`doge-code\` 提交 \`${info.commit}\`${info.dirty ? '（另有未提交改动）' : ''}（${info.date}）· ${info.files} 个文件`,
    `> 本目录由 \`${tool}\` 按清单生成；除本文件的说明正文外请勿手改。`,
    END,
  ].join(eol)
  return readme.slice(0, start) + block + readme.slice(end + END.length)
}

function build(allowDirty: boolean): Snapshot {
  const shipped = [...TREES, ...ROOT_FILES, ...REWRITTEN, ...NOT_SHIPPED]
  const dirty = gitText('status', '--porcelain', '-z', '--untracked-files=all', '--', ...shipped)
  if (dirty && !allowDirty) {
    const changed = dirty.split('\0').filter(Boolean).map(entry => entry.slice(3))
    throw new Error(`清单内的源码有未提交改动，先提交再同步（或加 --allow-dirty）：\n${changed.slice(0, 10).join('\n')}`)
  }
  // 被忽略的文件进不了清单，也没有别的报错：逐个点名，免得运行时需要的资源悄悄缺席
  const hidden = gitText('ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...shipped).split('\0').filter(Boolean)
  if (hidden.length) throw new Error(`清单内的这些文件被 .gitignore 忽略，不会分发；运行时需要的话先在 .gitignore 放行并入库：\n${hidden.slice(0, 10).join('\n')}`)
  // 源码等同的提交 = 最后一次改动清单内路径的那一个；同步结果自己入库不会让它变化
  const [commit, date] = gitText('log', '-1', '--abbrev=12', '--format=%h%x09%cs', '--', ...shipped).trim().split('\t')
  const files = new Map<string, Buffer>()
  for (const relative of gitText('ls-files', '-z', '--', ...shipped).split('\0').filter(Boolean)) {
    if (TEST_FILE.test(relative)) continue
    const source = readFileSync(local(...relative.split('/')))
    files.set(relative, REWRITTEN.includes(relative) ? Buffer.from(rewrite(relative, source.toString('utf8'))) : source)
  }
  if (!existsSync(targetFile(README))) throw new Error(`${README} 不存在：说明正文是手工维护的，工具只刷新它的同步块，不会创建它`)
  const info: Info = {
    version: JSON.parse(readFileSync(local('package.json'), 'utf8')).version as string,
    commit, date, files: files.size + 1, dirty: Boolean(dirty),
  }
  files.set(README, Buffer.from(withSyncBlock(readFileSync(targetFile(README), 'utf8'), info)))
  // 分发文件若被 .gitignore 挡住就会悄悄留在库外：入库前逐个核对
  const blocked = [...ignored([...files.keys()].map(relative => `doge-code-install/${relative}`))]
  if (blocked.length) throw new Error(`这些分发文件被 .gitignore 忽略，入库会缺失：\n${blocked.slice(0, 10).join('\n')}`)
  return { files, info }
}

/** Files missing or different in the target, and files present there but not in the manifest. */
function drift(files: Map<string, Buffer>): Drift {
  const result: Drift = { missing: [], changed: [], stale: [] }
  for (const [relative, content] of files) {
    if (!existsSync(targetFile(relative))) result.missing.push(relative)
    else if (!readFileSync(targetFile(relative)).equals(content)) result.changed.push(relative)
  }
  const extra = existsSync(target) ? listFiles(target).filter(relative => !files.has(relative)) : []
  // 仓库里的垃圾（IDE 元数据、系统文件）被 .gitignore 忽略，不算分发的一部分
  const junk = extra.length ? ignored(extra.map(relative => `doge-code-install/${relative}`)) : new Set<string>()
  result.stale = extra.filter(relative => !junk.has(`doge-code-install/${relative}`))
  return result
}

function write(files: Map<string, Buffer>, changes: Drift): void {
  for (const relative of changes.stale) {
    rmSync(targetFile(relative))
    // 文件删掉后把因此变空的目录一路撤到分发根
    for (let dir = dirname(targetFile(relative)); dir.length > target.length; dir = dirname(dir)) {
      try {
        if (readdirSync(dir).length) break
        rmSync(dir)
      } catch {
        break
      }
    }
  }
  for (const relative of [...changes.missing, ...changes.changed]) {
    mkdirSync(dirname(targetFile(relative)), { recursive: true })
    writeFileSync(targetFile(relative), files.get(relative)!)
  }
}

/** An interrupted earlier run can leave its copy behind; nothing else ever sweeps it. */
function removeSandbox(sandbox: string): boolean {
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    return true
  } catch {
    return false
  }
}

/**
 * Install a lone copy outside the repo. Inside it Bun would walk up to the parent
 * node_modules and mask a missing dependency, so the sandbox must have none above it.
 */
function verify(version: string): void {
  const base = resolve(tmpdir())
  const inside = relative(root, base)
  if (!inside.startsWith('..') && !isAbsolute(inside)) throw new Error(`系统临时目录在仓库之内，验证不独立：${base}`)
  for (let dir = base; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules'))) throw new Error(`临时目录的上级有 node_modules，会掩盖缺失的依赖：${dir}`)
    if (dirname(dir) === dir) break
  }
  for (const name of readdirSync(base)) {
    if (name.startsWith(SANDBOX_PREFIX) && !removeSandbox(join(base, name))) console.error(`早先残留的临时目录删不掉，请手动清理：${join(base, name)}`)
  }
  const sandbox = mkdtempSync(join(base, SANDBOX_PREFIX))
  console.log(`VERIFY 在仓库外安装独立副本：${sandbox}`)
  const onSignal = (): void => {
    removeSandbox(sandbox)
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const copy = join(sandbox, 'doge-code-install')
    cpSync(target, copy, { recursive: true, filter: source => !SKIPPED_DIRS.has(basename(source)) })
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(sandbox, '.doge') }
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, ...args], { cwd: copy, env, stdout: 'pipe', stderr: 'pipe' })
    const installed = run('install', '--frozen-lockfile')
    if (installed.exitCode !== 0) throw new Error(`独立副本里 bun install --frozen-lockfile 失败：\n${tail(installed)}`)
    const started = run('run', 'version')
    if (started.exitCode !== 0 || !started.stdout.toString().includes(`${version} (Claude Code)`)) {
      throw new Error(`独立副本里 bun run version 没有输出 ${version} (Claude Code)：\n${tail(started)}`)
    }
    console.log(`VERIFY PASS 独立副本可安装并运行：${started.stdout.toString().trim().split('\n').at(-1)}`)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (!removeSandbox(sandbox)) console.error(`临时目录未能删除，请手动清理：${sandbox}`)
  }
}

const args = new Set(process.argv.slice(2))
if ([...args].some(arg => !['--check', '--verify', '--allow-dirty'].includes(arg)) || (args.has('--check') && args.has('--verify'))) {
  console.error(USAGE)
  process.exit(2)
}

try {
  const { files, info } = build(args.has('--allow-dirty'))
  const changes = drift(files)
  if (args.has('--check')) {
    if (changes.missing.length || changes.changed.length || changes.stale.length) {
      console.error(`CHECK FAIL doge-code-install 与提交 ${info.commit} 不一致：缺 ${changes.missing.length}、变 ${changes.changed.length}、多 ${changes.stale.length}`)
      for (const [label, list] of [['缺失', changes.missing], ['内容不同', changes.changed], ['多出', changes.stale]] as const) {
        for (const relative of list.slice(0, 8)) console.error(`  ${label}  ${relative}`)
      }
      process.exit(1)
    }
    const pending = gitText('status', '--porcelain', '-z', '--untracked-files=all', '--', 'doge-code-install').split('\0').filter(Boolean).length
    if (pending) {
      console.error(`CHECK FAIL doge-code-install 有 ${pending} 处改动尚未提交：同步结果要单独提交一笔`)
      process.exit(1)
    }
    console.log(`CHECK PASS doge-code-install 与提交 ${info.commit} 一致并已提交（${info.files} 个文件）`)
  } else {
    write(files, changes)
    console.log(`SYNC ${info.version} 已同步，源码等同提交 ${info.commit}（${info.date}）：${info.files} 个文件，写入 ${changes.missing.length + changes.changed.length}、移除 ${changes.stale.length}`)
    if (args.has('--verify')) {
      try {
        verify(info.version)
      } catch (error) {
        console.error(`VERIFY FAIL ${message(error)}`)
        process.exit(1)
      }
    }
  }
} catch (error) {
  console.error(`SYNC FAIL ${message(error)}`)
  process.exit(1)
}

/**
 * Regenerate `doge-code-install/`: the minimal install source that can be copied to
 * another computer on its own (`bun install --frozen-lockfile && bun link`).
 *
 * Everything in it is mirrored byte-for-byte from the tracked tree, so the manifest
 * below is the single source of truth for what ships. Run it on a committed tree:
 * the README header then names the last commit the sources came from.
 *
 *   bun tools/sync-install-source.ts            rewrite doge-code-install/
 *   bun tools/sync-install-source.ts --check    fail if it is stale or git-ignored
 *   bun tools/sync-install-source.ts --verify   also install a copy outside the repo and run it
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dir, '..')
const target = join(root, 'doge-code-install')

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
const TEST_FILE = /\.(?:test|spec)\.tsx?$/
/** Hand-maintained prose; only the block between its markers is generated. */
const README = 'README.md'
const START = '<!-- sync:start -->'
const END = '<!-- sync:end -->'
/** Never part of the snapshot, even when someone installed dependencies in place. */
const SKIPPED_DIRS = new Set(['node_modules', '.git'])
const USAGE = '用法：bun tools/sync-install-source.ts [--check] [--verify] [--allow-dirty]'

interface Command { code: number | null; stdout: Buffer; stderr: Buffer }
interface Snapshot {
  files: Map<string, Buffer>
  info: { version: string; commit: string; date: string; files: number }
}
interface Drift { missing: string[]; changed: string[]; stale: string[] }

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
 * the sources themselves.
 */
function rewrite(relative: string, text: string): string {
  if (relative === '.gitattributes') {
    return `${text.replace(/\s*$/, '')}\n# 本目录是已跟踪源码的逐字节镜像，空白问题随源码走，不在镜像里修\n* -whitespace\n`
  }
  const kept: string[] = []
  let skipping = false
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) skipping = /^\s*\[test\]\s*$/.test(line)
    if (!skipping) kept.push(line)
  }
  return `${kept.join('\n').replace(/\s*$/, '')}\n\n# 注：本分发不含测试与 tools/，故不配置 [test] preload；测试请使用完整仓库 doge-code。\n`
}

function withSyncBlock(readme: string, info: Snapshot['info']): string {
  const start = readme.indexOf(START)
  const end = readme.indexOf(END)
  if (start === -1 || end < start) throw new Error(`${README} 缺少 ${START} / ${END} 标记`)
  const eol = readme.includes('\r\n') ? '\r\n' : '\n'
  const block = [
    START,
    `> **当前版本** \`${info.version}\` · 源码等同 \`doge-code\` 提交 \`${info.commit}\`（${info.date}）· ${info.files} 个文件`,
    '> 本目录由 `bun tools/sync-install-source.ts` 按清单生成；除本文件的说明正文外请勿手改。',
    END,
  ].join(eol)
  return readme.slice(0, start) + block + readme.slice(end + END.length)
}

function build(allowDirty: boolean): Snapshot {
  const pathspecs = [...TREES, ...ROOT_FILES, ...REWRITTEN]
  const dirty = gitText('status', '--porcelain', '-z', '--untracked-files=all', '--', ...pathspecs)
  if (dirty && !allowDirty) {
    const changed = dirty.split('\0').filter(Boolean).map(entry => entry.slice(3))
    throw new Error(`清单内的源码有未提交改动，先提交再同步（或加 --allow-dirty）：\n${changed.slice(0, 10).join('\n')}`)
  }
  // 源码等同的提交 = 最后一次改动清单内路径的那一个；同步结果自己入库不会让它变化
  const [commit, date] = gitText('log', '-1', '--format=%h%x09%cs', '--', ...pathspecs).trim().split('\t')
  const files = new Map<string, Buffer>()
  for (const relative of gitText('ls-files', '-z', '--', ...pathspecs).split('\0').filter(Boolean)) {
    if (TEST_FILE.test(relative)) continue
    const source = readFileSync(local(...relative.split('/')))
    files.set(relative, REWRITTEN.includes(relative) ? Buffer.from(rewrite(relative, source.toString('utf8'))) : source)
  }
  if (!existsSync(targetFile(README))) throw new Error(`${README} 不存在：说明正文是手工维护的，工具只刷新它的同步块，不会创建它`)
  const info = { version: JSON.parse(readFileSync(local('package.json'), 'utf8')).version as string, commit, date, files: files.size + 1 }
  files.set(README, Buffer.from(withSyncBlock(readFileSync(targetFile(README), 'utf8'), info)))
  // 分发文件若被 .gitignore 挡住就会悄悄留在库外：入库前逐个核对
  const ignored = git(Buffer.from([...files.keys()].map(relative => `doge-code-install/${relative}`).join('\0') + '\0'), 'check-ignore', '-v', '-z', '--no-index', '--stdin')
  if (ignored.code !== 0 && ignored.code !== 1) throw new Error(`git check-ignore 失败：${ignored.stderr.toString().trim()}`)
  const fields = ignored.stdout.toString().split('\0')
  const blocked: string[] = []
  for (let index = 0; index + 3 < fields.length; index += 4) {
    // 每条记录是「来源、行号、规则、路径」；被否定规则（!…）命中的是重新纳入的文件
    if (!fields[index + 2].startsWith('!')) blocked.push(fields[index + 3])
  }
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
  if (existsSync(target)) result.stale = listFiles(target).filter(relative => !files.has(relative))
  return result
}

function write(files: Map<string, Buffer>, changes: Drift): void {
  for (const relative of changes.stale) rmSync(targetFile(relative))
  for (const relative of [...changes.missing, ...changes.changed]) {
    mkdirSync(dirname(targetFile(relative)), { recursive: true })
    writeFileSync(targetFile(relative), files.get(relative)!)
  }
}

/** Install a lone copy outside the repo: a parent node_modules must never mask a missing dependency. */
function verify(version: string): void {
  const sandbox = mkdtempSync(join(tmpdir(), 'doge-code-install-'))
  console.log(`VERIFY 在仓库外安装独立副本：${sandbox}`)
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
    rmSync(sandbox, { recursive: true, force: true })
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
    console.log(`CHECK PASS doge-code-install 与提交 ${info.commit} 一致（${info.files} 个文件）`)
  } else {
    write(files, changes)
    console.log(`SYNC ${info.version} 已同步，源码等同提交 ${info.commit}（${info.date}）：${info.files} 个文件，写入 ${changes.missing.length + changes.changed.length}、移除 ${changes.stale.length}`)
    if (args.has('--verify')) verify(info.version)
  }
} catch (error) {
  console.error(`SYNC FAIL ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

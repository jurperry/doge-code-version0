// e2e（可保留回归资产）：headless `-p -w` 全链路——
// 本地 mock Anthropic SSE server 让 query 真实跑完并正常退出，验证
// registerCleanup 挂接的 finalizeHeadlessWorktree 在进程退出时生效：
// ① 干净 worktree：退出后自动移除 worktree + 分支（修复前永久残留）
// ② 有未提交变更：退出后保留 worktree + stderr 提示（不丢弃工作）
// ③ 对照：不带 -w 的 -p 正常退出不受影响
// 自建 CLAUDE_CONFIG_DIR 沙箱 + 临时 git 仓库，结束时自清理。
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const TMP = mkdtempSync(join(tmpdir(), 'doge-wt-e2e-'))
const SANDBOX = join(TMP, 'config')
const REPO = join(TMP, 'repo')
mkdirSync(SANDBOX, { recursive: true })
mkdirSync(REPO, { recursive: true })

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8' },
  )
}

// Minimal Anthropic Messages SSE stream: one text block, end_turn.
function sseBody(): string {
  const events = [
    [
      'message_start',
      JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_e2e',
          type: 'message',
          role: 'assistant',
          model: 'mock',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
    ],
    [
      'content_block_start',
      JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    ],
    [
      'content_block_delta',
      JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      }),
    ],
    [
      'content_block_stop',
      JSON.stringify({ type: 'content_block_stop', index: 0 }),
    ],
    [
      'message_delta',
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      }),
    ],
    ['message_stop', JSON.stringify({ type: 'message_stop' })],
  ]
  return events.map(([e, d]) => `event: ${e}\ndata: ${d}\n\n`).join('')
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    // the SDK calls /v1/messages?beta=true — match by path, not URL suffix
    if (req.url.includes('/v1/messages')) {
      const body = (await req.json().catch(() => ({}))) as { stream?: boolean }
      if (body.stream) {
        return new Response(sseBody(), {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        })
      }
      return Response.json({
        id: 'msg_e2e',
        type: 'message',
        role: 'assistant',
        model: 'mock',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
    return new Response('not found', { status: 404 })
  },
})

// spawn (async), NOT spawnSync: the mock server lives in this same process,
// and spawnSync blocks the event loop that would answer the CLI's HTTP
// requests. stdout/stderr are collected via streams (no deadlock — the event
// loop keeps draining while the child runs).
function runCli(
  args: string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'src', 'bootstrap-entry.ts'), ...args],
      {
        cwd,
        // stdin must be closed: with the default pipe the CLI drains stdin and
        // waits forever for EOF even though the prompt came from argv.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: SANDBOX,
          DOGE_API_KEY: 'sk-e2e-dummy',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
          ANTHROPIC_MODEL: 'mock-model',
          ANTHROPIC_SMALL_FAST_MODEL: 'mock-model',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'anthropic',
          NODE_ENV: process.env.NODE_ENV,
        },
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', d => (stdout += d))
    child.stderr!.on('data', d => (stderr += d))
    const timer = setTimeout(() => {
      child.kill()
      resolve({ status: null, stdout, stderr })
    }, 180_000)
    timer.unref()
    child.on('close', status => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

try {
  // ---- fixture repo ----
  git(REPO, 'init', '-q', '-b', 'main')
  writeFileSync(join(REPO, 'a.txt'), 'hello\n')
  git(REPO, 'add', '.')
  git(REPO, 'commit', '-qm', 'init')

  // ---- scenario ②: pre-existing dirty worktree (fast-resume path) ----
  const dirtyPath = join(REPO, '.doge', 'worktrees', 'e2e-dirty')
  git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-e2e-dirty', dirtyPath, 'HEAD')
  writeFileSync(join(dirtyPath, 'uncommitted.txt'), 'keep me\n')

  console.log('scenario A: dirty worktree is kept with stderr notice')
  const dirtyRun = await runCli(['-p', 'hi', '-w', 'e2e-dirty'], REPO)
  check('exit code 0', dirtyRun.status === 0, `status=${dirtyRun.status} stderrTail=${(dirtyRun.stderr ?? '').split(String.fromCharCode(10)).filter(l => !l.includes('DOGE-DEBUG') && l.trim()).slice(-6).join(' | ')}`)
  check(
    'worktree still registered',
    git(REPO, 'worktree', 'list', '--porcelain').includes(
      dirtyPath.replaceAll('\\', '/'),
    ),
  )
  check(
    'uncommitted file preserved',
    existsSync(join(dirtyPath, 'uncommitted.txt')),
  )
  check(
    'stderr mentions kept worktree',
    (dirtyRun.stderr ?? '').includes('Worktree kept'),
    (dirtyRun.stderr ?? '')
      .split(String.fromCharCode(10))
      .filter(l => !l.includes('DOGE-DEBUG'))
      .slice(-8)
      .join(' | '),
  )

  // ---- scenario ①: fresh clean worktree auto-removed on exit ----
  console.log('scenario B: clean worktree auto-removed on exit')
  const cleanRun = await runCli(['-p', 'hi', '-w', 'e2e-clean'], REPO)
  check('exit code 0', cleanRun.status === 0, `status=${cleanRun.status} stderrTail=${(cleanRun.stderr ?? '').split(String.fromCharCode(10)).filter(l => !l.includes('DOGE-DEBUG') && l.trim()).slice(-6).join(' | ')}`)
  const cleanPath = join(REPO, '.doge', 'worktrees', 'e2e-clean')
  // the CLI's git child processes release directory handles asynchronously
  // after close — wait briefly before asserting the directory is gone
  await new Promise(r => setTimeout(r, 2000))
  // The meaningful invariant is git-level removal: the worktree must be
  // unregistered from `git worktree list` and its branch deleted. On Windows
  // the on-disk directory can linger if an orphaned child (LSP/rg spawned by
  // the CLI) still holds a handle; `git worktree prune` reaps registration
  // and the leftover directory is inert. Assert registration, tolerate dir.
  const listed = git(REPO, 'worktree', 'list', '--porcelain')
  if (existsSync(cleanPath)) {
    try {
      git(REPO, 'worktree', 'prune')
    } catch {
      /* best effort */
    }
    console.error(
      `  note: worktree dir still on disk (Windows handle); git registration cleared`,
    )
  }
  check(
    'worktree unregistered from git',
    !listed.includes(cleanPath.split(String.fromCharCode(92)).join('/')),
  )
  let branchGone = false
  try {
    git(REPO, 'rev-parse', '--verify', 'worktree-e2e-clean')
  } catch {
    branchGone = true
  }
  check('branch deleted', branchGone)

  // ---- scenario ③: plain -p run unaffected ----
  console.log('scenario C: plain -p run still works')
  const plainRun = await runCli(['-p', 'hi'], REPO)
  check('exit code 0', plainRun.status === 0, `status=${plainRun.status} stderrTail=${(plainRun.stderr ?? '').split(String.fromCharCode(10)).filter(l => !l.includes('DOGE-DEBUG') && l.trim()).slice(-6).join(' | ')}`)
  check('stdout has reply', (plainRun.stdout ?? '').includes('ok'))
} finally {
  server.stop(true)
  // release worktrees so Windows can delete the fixture
  try {
    git(REPO, 'worktree', 'prune')
  } catch {
    /* already gone */
  }
  process.chdir(tmpdir())
  // Windows: the kept dirty worktree can still be held briefly (orphaned CLI
  // child processes / Defender scanning freshly written files). Retry with
  // growing grace; if it still fails, print the path so the operator can
  // remove it (C-drive test data must not linger).
  for (const delay of [500, 2000, 5000]) {
    await new Promise(r => setTimeout(r, delay))
    try {
      rmSync(TMP, { recursive: true, force: true })
      break
    } catch {
      /* retry */
    }
  }
  if (existsSync(TMP)) {
    console.error(`WARN: could not delete ${TMP} (locked) — remove manually`)
    process.exitCode = 1
  }
}

console.log(failures === 0 ? '\ne2e-worktree-headless: ALL PASS' : `\ne2e-worktree-headless: ${failures} FAILURES`)
// TMP must be gone too (C-drive test-data discipline) — a locked leftover
// is a failure even when every scenario passed.
process.exit(failures === 0 && !existsSync(TMP) ? 0 : 1)

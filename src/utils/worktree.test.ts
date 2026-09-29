import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

// Isolate config reads/writes (getInitialSettings, saveCurrentProjectConfig)
// away from the developer's real ~/.doge.
const TMP = mkdtempSync(join(tmpdir(), 'doge-worktree-'))
process.env.CLAUDE_CONFIG_DIR = TMP

const {
  countWorktreeChanges,
  createWorktreeForSession,
  finalizeHeadlessWorktree,
  getCurrentWorktreeSession,
  parsePRReference,
  validateWorktreeSlug,
  worktreeBranchName,
} = await import('./worktree.js')
const { setCwd } = await import('./Shell.js')

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf8' },
  )
}

function worktreeList(): string {
  return git(REPO, 'worktree', 'list', '--porcelain')
}

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/')
}

const REPO = join(TMP, 'repo')

// One commit history shared by the suites below.
function initRepoWithCommit(): string {
  mkdirSync(REPO, { recursive: true })
  git(REPO, 'init', '-q', '-b', 'main')
  writeFileSync(join(REPO, 'a.txt'), 'hello\n')
  git(REPO, 'add', '.')
  git(REPO, 'commit', '-qm', 'init')
  return git(REPO, 'rev-parse', 'HEAD').trim()
}

afterAll(async () => {
  // finalizeHeadlessWorktree → keepWorktree/cleanupWorktree chdir's the
  // process into the fixture (originalCwd) — a process cwd inside TMP keeps
  // the directory locked on Windows. Step out before deleting.
  process.chdir(tmpdir())
  try {
    git(REPO, 'worktree', 'prune')
  } catch {
    /* fixture may already be gone */
  }
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('validateWorktreeSlug — path traversal guard', () => {
  test('accepts plain and nested slugs', () => {
    expect(() => validateWorktreeSlug('foo')).not.toThrow()
    expect(() => validateWorktreeSlug('user/feature-1.2_x')).not.toThrow()
  })

  test('rejects dot segments, absolute paths, and empty segments', () => {
    expect(() => validateWorktreeSlug('..')).toThrow()
    expect(() => validateWorktreeSlug('a/../b')).toThrow()
    expect(() => validateWorktreeSlug('/abs')).toThrow()
    expect(() => validateWorktreeSlug('a//b')).toThrow()
  })

  test('rejects characters outside the allowlist (space, backslash, colon)', () => {
    expect(() => validateWorktreeSlug('a b')).toThrow()
    expect(() => validateWorktreeSlug('a\\b')).toThrow()
    expect(() => validateWorktreeSlug('C:drive')).toThrow()
  })

  test('rejects slugs over 64 characters', () => {
    expect(() => validateWorktreeSlug('a'.repeat(65))).toThrow()
    expect(() => validateWorktreeSlug('a'.repeat(64))).not.toThrow()
  })
})

describe('parsePRReference', () => {
  test('parses #N', () => {
    expect(parsePRReference('#123')).toBe(123)
  })

  test('parses GitHub PR URLs with trailing slash/query/hash', () => {
    expect(parsePRReference('https://github.com/o/r/pull/45')).toBe(45)
    expect(
      parsePRReference('https://github.com/o/r/pull/45#issuecomment-1'),
    ).toBe(45)
  })

  test('returns null for non-PR strings', () => {
    expect(parsePRReference('feature-x')).toBeNull()
    expect(parsePRReference('#abc')).toBeNull()
    expect(parsePRReference('')).toBeNull()
  })
})

describe('worktreeBranchName — nested slug flattening', () => {
  test('prefixes and flattens slashes to plus', () => {
    expect(worktreeBranchName('foo')).toBe('worktree-foo')
    expect(worktreeBranchName('user/feature')).toBe('worktree-user+feature')
  })
})

describe('countWorktreeChanges — fail-closed change detection', () => {
  const WT = join(TMP, 'wt-clean')
  let base: string

  beforeAll(() => {
    base = initRepoWithCommit()
    git(REPO, 'worktree', 'add', '-q', '-b', 'wt', WT, 'HEAD')
  })

  test('clean worktree against baseline → 0/0', async () => {
    expect(await countWorktreeChanges(WT, base)).toEqual({
      changedFiles: 0,
      commits: 0,
    })
  })

  test('uncommitted file is counted regardless of baseline', async () => {
    writeFileSync(join(WT, 'b.txt'), 'dirty\n')
    expect(await countWorktreeChanges(WT, base)).toEqual({
      changedFiles: 1,
      commits: 0,
    })
    rmSync(join(WT, 'b.txt'))
  })

  test('commits past the baseline are counted', async () => {
    writeFileSync(join(WT, 'c.txt'), 'committed\n')
    git(WT, 'add', '.')
    git(WT, 'commit', '-qm', 'work')
    expect(await countWorktreeChanges(WT, base)).toEqual({
      changedFiles: 0,
      commits: 1,
    })
  })

  test('missing baseline (hook-based worktree) → null, never a silent 0', async () => {
    expect(await countWorktreeChanges(WT, undefined)).toBeNull()
  })

  test('path that is not a git repo → null', async () => {
    expect(await countWorktreeChanges(join(TMP, 'not-a-repo'), base)).toBeNull()
  })
})

describe('finalizeHeadlessWorktree — headless -p -w exit settlement', () => {
  beforeAll(() => {
    // createWorktreeForSession resolves the repo from tracked cwd state.
    setCwd(REPO)
  })

  test('no active session → null, no side effects', async () => {
    expect(await finalizeHeadlessWorktree()).toBeNull()
  })

  test('clean worktree is removed with its branch, state cleared', async () => {
    const session = await createWorktreeForSession('session-1', 'wt-headless')
    expect(session.worktreeBranch).toBe('worktree-wt-headless')
    expect(worktreeList()).toContain(normalizePath(session.worktreePath))

    const outcome = await finalizeHeadlessWorktree()

    expect(outcome?.kept).toBe(false)
    expect(worktreeList()).not.toContain(normalizePath(session.worktreePath))
    expect(() =>
      git(REPO, 'rev-parse', '--verify', 'worktree-wt-headless'),
    ).toThrow()
    expect(getCurrentWorktreeSession()).toBeNull()
  })

  test('dirty worktree is kept and reported, never auto-discarded', async () => {
    const session = await createWorktreeForSession(
      'session-2',
      'wt-headless-dirty',
    )
    writeFileSync(join(session.worktreePath, 'uncommitted.txt'), 'keep me\n')

    const outcome = await finalizeHeadlessWorktree()

    expect(outcome?.kept).toBe(true)
    expect(outcome?.worktreePath).toBe(session.worktreePath)
    expect(worktreeList()).toContain(normalizePath(session.worktreePath))
    expect(
      readFileSyncSafe(join(session.worktreePath, 'uncommitted.txt')),
    ).toBe('keep me\n')
    expect(getCurrentWorktreeSession()).toBeNull()

    // release the kept fixture so afterAll can delete TMP on Windows
    git(REPO, 'worktree', 'remove', '--force', session.worktreePath)
    git(REPO, 'branch', '-D', 'worktree-wt-headless-dirty')
  })

  test('resumed worktree with prior commits is kept (baseline drift guard)', async () => {
    // Session 1: create, commit real work, exit (kept — as the dirty path
    // would). Session 2 resumes the same slug: fast-resume records the
    // CURRENT head as baseline, so commits from session 1 are invisible to
    // countWorktreeChanges. Finalize must not treat that as "clean".
    const first = await createWorktreeForSession('s-a', 'wt-resume')
    writeFileSync(join(first.worktreePath, 'committed.txt'), 'work\n')
    git(first.worktreePath, 'add', '.')
    git(first.worktreePath, 'commit', '-qm', 'prior session work')
    const { restoreWorktreeSession } = await import('./worktree.js')
    restoreWorktreeSession(null) // simulate session 1 ending without removal

    const resumed = await createWorktreeForSession('s-b', 'wt-resume')
    expect(resumed.creationDurationMs).toBeUndefined() // fast-resume path

    const outcome = await finalizeHeadlessWorktree()

    expect(outcome?.kept).toBe(true)
    expect(worktreeList()).toContain(normalizePath(resumed.worktreePath))
    expect(() =>
      git(REPO, 'rev-parse', '--verify', 'worktree-wt-resume'),
    ).not.toThrow()
    expect(getCurrentWorktreeSession()).toBeNull()

    // release the kept fixture so afterAll can delete TMP on Windows
    git(REPO, 'worktree', 'remove', '--force', resumed.worktreePath)
    git(REPO, 'branch', '-D', 'worktree-wt-resume')
  })
})

function readFileSyncSafe(path: string): string | null {
  try {
    return require('fs').readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

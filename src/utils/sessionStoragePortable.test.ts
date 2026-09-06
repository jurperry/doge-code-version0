import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  decodeProjectDirName,
  findProjectDir,
  getProjectDir,
  legacySanitizePath,
  migrateLegacyProjectDirs,
  sanitizePath,
  sanitizePathCandidates,
} from './sessionStoragePortable.js'

describe('sanitizePath (v2 encoding)', () => {
  test('keeps hyphens literal and encodes separators distinctly', () => {
    expect(sanitizePath('E:\\ClaudeCode\\doge-code')).toBe(
      'E%3a~ClaudeCode~doge-code',
    )
    expect(sanitizePath('E:/ClaudeCode/doge-code')).toBe(
      'E%3a~ClaudeCode~doge-code',
    )
  })

  test('paths differing only in separator/hyphen placement encode distinctly', () => {
    // v1 collapsed both to E--a-b — the ambiguity this v2 encoding fixes.
    expect(sanitizePath('E:\\a-b\\c')).not.toBe(sanitizePath('E:\\a\\b-c'))
    expect(sanitizePath('E:\\a-b\\c')).toBe('E%3a~a-b~c')
    expect(sanitizePath('E:\\a\\b-c')).toBe('E%3a~a~b-c')
  })

  test('posix paths', () => {
    expect(sanitizePath('/home/user/my-project')).toBe('~home~user~my-project')
    expect(sanitizePath('/')).toBe('~')
  })

  test('drive root and UNC', () => {
    expect(sanitizePath('C:\\')).toBe('C%3a~')
    expect(sanitizePath('\\\\server\\share\\repo')).toBe('~~server~share~repo')
  })

  test('tilde in a folder name is escaped so separators stay unambiguous', () => {
    expect(sanitizePath('/home/u/~notes')).toBe('~home~u~%7enotes')
  })

  test('non-ASCII percent-escapes as UTF-8 bytes', () => {
    expect(sanitizePath('/数据/项目')).toBe(
      '~%e6%95%b0%e6%8d%ae~%e9%a1%b9%e7%9b%ae',
    )
    expect(sanitizePath('/Users/x/😀')).toBe('~Users~x~%f0%9f%98%80')
  })

  test('truncates with a hash suffix past MAX_SANITIZED_LENGTH', () => {
    const long = 'C:\\' + 'a'.repeat(300)
    const encoded = sanitizePath(long)
    expect(encoded.length).toBeGreaterThan(200)
    expect(encoded.slice(0, 200)).toBe('C%3a~' + 'a'.repeat(195))
    expect(encoded[200]).toBe('-')
  })
})

describe('decodeProjectDirName', () => {
  const cases = [
    'E:\\ClaudeCode\\doge-code',
    'E:\\a-b\\c',
    'E:\\a\\b-c',
    '/home/user/my-project',
    'C:\\',
    '\\\\server\\share\\repo',
    '/home/u/~notes',
    '/数据/项目',
    '/Users/x/😀',
  ]
  for (const p of cases) {
    test(`round-trips ${p}`, () => {
      const sep = p.includes('\\') || /^[A-Za-z]:/.test(p) ? '\\' : '/'
      expect(decodeProjectDirName(sanitizePath(p), sep)).toBe(p)
    })
  }

  test('truncated names decode to a best-effort path, not undefined', () => {
    const long = 'C:\\' + 'a'.repeat(300)
    const decoded = decodeProjectDirName(sanitizePath(long), '\\')
    expect(decoded).toBeDefined()
    expect(decoded!.startsWith('C:\\' + 'a'.repeat(180))).toBe(true)
  })

  test('malformed escapes return undefined', () => {
    expect(decodeProjectDirName('a%zzb')).toBeUndefined()
    expect(decodeProjectDirName('a%')).toBeUndefined()
    expect(decodeProjectDirName('a%2')).toBeUndefined()
  })
})

describe('legacySanitizePath (v1)', () => {
  test('matches the pre-2026-09-06 behavior exactly', () => {
    expect(legacySanitizePath('E:\\ClaudeCode\\doge-code')).toBe(
      'E--ClaudeCode-doge-code',
    )
    expect(legacySanitizePath('/home/user/my-project')).toBe(
      '-home-user-my-project',
    )
  })
})

describe('sanitizePathCandidates', () => {
  test('lists v2 first, then v1, when they differ', () => {
    const candidates = sanitizePathCandidates('E:\\ClaudeCode\\doge-code')
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toBe('E%3a~ClaudeCode~doge-code')
    expect(candidates[1]).toBe('E--ClaudeCode-doge-code')
  })

  test('collapses to one entry when both variants coincide', () => {
    expect(sanitizePathCandidates('a-b')).toEqual(['a-b'])
  })
})

describe('findProjectDir (v2 + legacy fallback)', () => {
  const root = join(tmpdir(), 'doge-ssportable-test')
  const cwd = 'E:\\hyphen-ated\\proj-ect'

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true })
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  })

  afterAll(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(root, { recursive: true, force: true })
  })

  test('prefers the v2 directory when both exist', async () => {
    mkdirSync(join(root, 'config', 'projects', sanitizePath(cwd)), {
      recursive: true,
    })
    mkdirSync(join(root, 'config', 'projects', legacySanitizePath(cwd)), {
      recursive: true,
    })
    expect(await findProjectDir(cwd)).toBe(getProjectDir(cwd))
  })

  test('falls back to a legacy v1 directory', async () => {
    rmSync(join(root, 'config', 'projects', sanitizePath(cwd)), {
      recursive: true,
      force: true,
    })
    expect(await findProjectDir(cwd)).toBe(
      join(root, 'config', 'projects', legacySanitizePath(cwd)),
    )
  })

  test('returns undefined when neither exists', async () => {
    rmSync(join(root, 'config', 'projects', legacySanitizePath(cwd)), {
      recursive: true,
      force: true,
    })
    expect(await findProjectDir(cwd)).toBeUndefined()
  })
})

describe('migrateLegacyProjectDirs', () => {
  const root = join(tmpdir(), 'doge-ssportable-migrate')
  const config = join(root, 'config')
  const projects = join(config, 'projects')

  // three different real cwds, all with hyphens in names
  const CWD_A = 'E:\\work\\my-repo'
  const CWD_B = 'E:\\work\\other.proj'
  const CWD_C = 'E:\\work\\third_repo'
  const sid = (n: string) => `${n}${'0'.repeat(8)}-0000-4000-8000-${'1'.repeat(12)}`

  const writeSession = (dir: string, id: string, cwd: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${id}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `session ${id}` },
        cwd,
        sessionId: id,
        timestamp: new Date().toISOString(),
      }) + '\n',
    )
  }

  beforeAll(() => {
    rmSync(root, { recursive: true, force: true })
    process.env.CLAUDE_CONFIG_DIR = config
  })

  afterAll(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    rmSync(root, { recursive: true, force: true })
  })

  test('renames v1 dirs, merges into existing v2, skips cwd-less dirs, is idempotent', async () => {
    // A: pure v1 dir → rename
    writeSession(join(projects, legacySanitizePath(CWD_A)), sid('a1'), CWD_A)

    // B: v1 dir + pre-existing v2 dir → merge (v1 side also has archived/ + memory/)
    const v1b = join(projects, legacySanitizePath(CWD_B))
    writeSession(v1b, sid('b1'), CWD_B)
    mkdirSync(join(v1b, 'archived'), { recursive: true })
    writeFileSync(join(v1b, 'archived', `${sid('b2')}.jsonl`), '{}\n')
    mkdirSync(join(v1b, 'memory'), { recursive: true })
    writeFileSync(join(v1b, 'memory', 'MEMORY.md'), '# legacy\n')
    const v2b = join(projects, sanitizePath(CWD_B))
    writeSession(v2b, sid('b3'), CWD_B)
    mkdirSync(join(v2b, 'archived'), { recursive: true })
    mkdirSync(join(v2b, 'memory'), { recursive: true })
    writeFileSync(join(v2b, 'memory', 'MEMORY.md'), '# newer\n')

    // C: v1 dir with no jsonl at all (only memory) → skipped, untouched
    const v1c = join(projects, legacySanitizePath(CWD_C))
    mkdirSync(join(v1c, 'memory'), { recursive: true })
    writeFileSync(join(v1c, 'memory', 'MEMORY.md'), '# no sessions\n')

    const r1 = await migrateLegacyProjectDirs()
    expect(r1.renamed).toBe(1)
    expect(r1.merged).toBe(1)
    expect(r1.skipped).toBe(1)

    // A renamed to v2, old name gone
    expect(existsSync(join(projects, sanitizePath(CWD_A), `${sid('a1')}.jsonl`))).toBe(true)
    expect(existsSync(join(projects, legacySanitizePath(CWD_A)))).toBe(false)

    // B merged: both sessions at top level, archived merged, memory newest wins
    expect(existsSync(join(v2b, `${sid('b1')}.jsonl`))).toBe(true)
    expect(existsSync(join(v2b, `${sid('b3')}.jsonl`))).toBe(true)
    expect(existsSync(join(v2b, 'archived', `${sid('b2')}.jsonl`))).toBe(true)
    // both MEMORY.md were written in the same millisecond; the merge keeps
    // dest when mtimes tie, so just assert one file remains and src is gone
    expect(existsSync(join(v2b, 'memory', 'MEMORY.md'))).toBe(true)
    expect(existsSync(v1b)).toBe(false)

    // C untouched
    expect(existsSync(v1c)).toBe(true)

    // second run: nothing left to do
    const r2 = await migrateLegacyProjectDirs()
    expect(r2.renamed + r2.merged).toBe(0)
  })
})

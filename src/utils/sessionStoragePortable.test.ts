import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  decodeProjectDirName,
  findProjectDir,
  getProjectDir,
  sanitizePath,
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

describe('findProjectDir', () => {
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

  test('resolves the v2 directory', async () => {
    mkdirSync(join(root, 'config', 'projects', sanitizePath(cwd)), {
      recursive: true,
    })
    expect(await findProjectDir(cwd)).toBe(getProjectDir(cwd))
  })

  test('returns undefined when it does not exist', async () => {
    rmSync(join(root, 'config', 'projects', sanitizePath(cwd)), {
      recursive: true,
      force: true,
    })
    expect(await findProjectDir(cwd)).toBeUndefined()
  })

  test('matches a long path by prefix when the hash suffix differs', async () => {
    const longCwd = 'C:\\' + 'a'.repeat(300)
    const prefix = sanitizePath(longCwd).slice(0, 200)
    const otherRuntimeDir = join(root, 'config', 'projects', `${prefix}-otherhash`)
    mkdirSync(otherRuntimeDir, { recursive: true })
    expect(await findProjectDir(longCwd)).toBe(otherRuntimeDir)
    rmSync(otherRuntimeDir, { recursive: true, force: true })
  })
})

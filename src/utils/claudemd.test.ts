import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, test } from 'bun:test'

const TMP = mkdtempSync(join(tmpdir(), 'doge-claudemd-'))
process.env.CLAUDE_CONFIG_DIR = TMP

const { isMemoryFilePath, processProjectMemoryFileWithFallback } = await import(
  './claudemd.js'
)

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('isMemoryFilePath — instruction-file detection', () => {
  test('matches .doge/rules/*.md (loader reads .doge, not .claude)', () => {
    expect(isMemoryFilePath(join(TMP, '.doge', 'rules', 'style.md'))).toBe(
      true,
    )
  })

  test('no longer matches .claude/rules/*.md (fork rename remnant fix)', () => {
    expect(isMemoryFilePath(join(TMP, '.claude', 'rules', 'style.md'))).toBe(
      false,
    )
  })

  test('matches CLAUDE.md, CLAUDE.local.md, and AGENTS.md by basename', () => {
    expect(isMemoryFilePath(join(TMP, 'CLAUDE.md'))).toBe(true)
    expect(isMemoryFilePath(join(TMP, 'CLAUDE.local.md'))).toBe(true)
    expect(isMemoryFilePath(join(TMP, 'AGENTS.md'))).toBe(true)
    expect(isMemoryFilePath(join(TMP, 'nested', 'AGENTS.md'))).toBe(true)
  })

  test('does not match unrelated markdown', () => {
    expect(isMemoryFilePath(join(TMP, 'README.md'))).toBe(false)
    expect(isMemoryFilePath(join(TMP, 'docs', 'AGENTS-guide.md'))).toBe(false)
  })
})

describe('processProjectMemoryFileWithFallback — AGENTS.md fallback', () => {
  function fixture(name: string): string {
    const dir = join(TMP, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  test('loads only CLAUDE.md when both CLAUDE.md and AGENTS.md exist', async () => {
    const dir = fixture('both')
    writeFileSync(join(dir, 'CLAUDE.md'), 'Primary instructions\n')
    writeFileSync(join(dir, 'AGENTS.md'), 'Fallback instructions\n')

    const files = await processProjectMemoryFileWithFallback(
      join(dir, 'CLAUDE.md'),
      join(dir, 'AGENTS.md'),
      new Set(),
      false,
    )

    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe(join(dir, 'CLAUDE.md'))
    expect(files[0]!.type).toBe('Project')
    expect(files[0]!.content).toContain('Primary instructions')
  })

  test('falls back to AGENTS.md when CLAUDE.md is absent', async () => {
    const dir = fixture('agents-only')
    writeFileSync(join(dir, 'AGENTS.md'), 'Fallback instructions\n')

    const files = await processProjectMemoryFileWithFallback(
      join(dir, 'CLAUDE.md'),
      join(dir, 'AGENTS.md'),
      new Set(),
      false,
    )

    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe(join(dir, 'AGENTS.md'))
    expect(files[0]!.type).toBe('Project')
    expect(files[0]!.content).toContain('Fallback instructions')
  })

  test('falls back to AGENTS.md when CLAUDE.md exists but has no loadable content', async () => {
    const dir = fixture('empty-claude')
    writeFileSync(join(dir, 'CLAUDE.md'), '')
    writeFileSync(join(dir, 'AGENTS.md'), 'Fallback instructions\n')

    const files = await processProjectMemoryFileWithFallback(
      join(dir, 'CLAUDE.md'),
      join(dir, 'AGENTS.md'),
      new Set(),
      false,
    )

    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe(join(dir, 'AGENTS.md'))
  })

  test('returns empty when neither file exists', async () => {
    const dir = fixture('neither')
    const files = await processProjectMemoryFileWithFallback(
      join(dir, 'CLAUDE.md'),
      join(dir, 'AGENTS.md'),
      new Set(),
      false,
    )
    expect(files).toHaveLength(0)
  })
})

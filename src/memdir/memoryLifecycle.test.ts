import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureMemoryDirExists,
  ensureMemoryEntrypointExists,
  loadMemoryPrompt,
} from './memdir.js'
import { isAutoMemoryEnabled, isExtractModeActive, getAutoMemPath } from './paths.js'

const TMP = mkdtempSync(join(tmpdir(), 'doge-memory-lifecycle-'))
const previousOverride = process.env.DOGE_HEADLESS_AUTO_MEMORY
const previousDisable = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
const previousPath = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE

beforeEach(() => {
  getAutoMemPath.cache.clear()
})

afterEach(() => {
  if (previousOverride === undefined) delete process.env.DOGE_HEADLESS_AUTO_MEMORY
  else process.env.DOGE_HEADLESS_AUTO_MEMORY = previousOverride
  if (previousDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = previousDisable
  if (previousPath === undefined) delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  else process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = previousPath
  getAutoMemPath.cache.clear()
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('headless memory extraction opt-in', () => {
  test('keeps upstream gates closed without an explicit App opt-in', () => {
    delete process.env.DOGE_HEADLESS_AUTO_MEMORY
    expect(isExtractModeActive()).toBe(false)
  })

  test('allows a long-lived App headless session to extract after a turn', () => {
    process.env.DOGE_HEADLESS_AUTO_MEMORY = '1'
    expect(isExtractModeActive()).toBe(true)
  })
})

describe('memory entrypoint initialization', () => {
  test('creates MEMORY.md once and never overwrites existing content', async () => {
    const dir = join(TMP, 'memory')
    await ensureMemoryDirExists(dir)
    await ensureMemoryEntrypointExists(dir)
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('')

    writeFileSync(join(dir, 'MEMORY.md'), '- [Keep](keep.md) — existing memory\n')
    await Promise.all(Array.from({ length: 8 }, () => ensureMemoryEntrypointExists(dir)))
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe(
      '- [Keep](keep.md) — existing memory\n',
    )
  })

  test('initializes the index without injecting memory while disabled', async () => {
    const dir = join(TMP, 'disabled-memory')
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = dir
    process.env.DOGE_HEADLESS_AUTO_MEMORY = '1'

    expect(isAutoMemoryEnabled()).toBe(false)
    await expect(loadMemoryPrompt()).resolves.toBeNull()
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('')
  })
})

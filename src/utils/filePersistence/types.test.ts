import { describe, expect, test } from 'bun:test'

// filePersistence.ts imports runtime constants (not just types) from
// ./types.js. When they went missing (reverse-engineered snapshot shipped a
// types-only file), the ESM link error made every dynamic import of
// print.ts — which pulls this module — reject, and headless -p hung on
// Windows. These tests pin the module link so that cannot regress silently.
describe('filePersistence module link', () => {
  test('filePersistence.js is importable (named exports resolve)', async () => {
    const mod = await import('./filePersistence.js')
    expect(typeof mod.runFilePersistence).toBe('function')
    expect(typeof mod.executeFilePersistence).toBe('function')
    expect(typeof mod.isFilePersistenceEnabled).toBe('function')
  })

  test('runtime constants exist in types.js with sane values', async () => {
    const types = await import('./types.js')
    expect(types.DEFAULT_UPLOAD_CONCURRENCY).toBeGreaterThan(0)
    expect(types.FILE_COUNT_LIMIT).toBeGreaterThan(0)
    expect(typeof types.OUTPUTS_SUBDIR).toBe('string')
    expect(types.OUTPUTS_SUBDIR.length).toBeGreaterThan(0)
  })
})

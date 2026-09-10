import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as path from 'path'
import { builtinRipgrepCandidates } from './ripgrepPaths.js'

const archDir =
  process.platform === 'win32'
    ? `${process.arch}-win32`
    : `${process.arch}-${process.platform}`
const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'

// Save & restore env around each test so they don't bleed.
let originalOverride: string | undefined

beforeEach(() => {
  originalOverride = process.env.DOGE_RIPGREP_PATH
  delete process.env.DOGE_RIPGREP_PATH
})

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.DOGE_RIPGREP_PATH
  } else {
    process.env.DOGE_RIPGREP_PATH = originalOverride
  }
})

describe('builtinRipgrepCandidates', () => {
  test('exe-dir candidate sits in vendor/ripgrep next to the executable', () => {
    const exePath = path.join(path.sep, 'opt', 'app', 'doge.exe')
    const candidates = builtinRipgrepCandidates({
      exePath,
      moduleDir: path.join(path.sep, 'src', 'utils'),
    })
    expect(candidates[0]).toBe(
      path.resolve(
        path.join(
          path.sep,
          'opt',
          'app',
          'vendor',
          'ripgrep',
          archDir,
          binary,
        ),
      ),
    )
  })

  test('module-dir candidate keeps the checkout layout (src/utils/vendor)', () => {
    const moduleDir = path.join(path.sep, 'checkout', 'src', 'utils')
    const candidates = builtinRipgrepCandidates({
      exePath: path.join(path.sep, 'opt', 'doge.exe'),
      moduleDir,
    })
    expect(candidates[1]).toBe(
      path.resolve(path.join(moduleDir, 'vendor', 'ripgrep', archDir, binary)),
    )
  })

  test('explicit override comes first and is resolved to an absolute path', () => {
    const candidates = builtinRipgrepCandidates({
      exePath: path.join(path.sep, 'opt', 'doge.exe'),
      moduleDir: path.join(path.sep, 'src', 'utils'),
      override: path.join('tools', 'rg.exe'),
    })
    expect(candidates[0]).toBe(path.resolve(path.join('tools', 'rg.exe')))
    expect(candidates).toHaveLength(3)
  })

  test('DOGE_RIPGREP_PATH env var is honored when no explicit override', () => {
    process.env.DOGE_RIPGREP_PATH = path.join(path.sep, 'custom', 'rg.exe')
    const candidates = builtinRipgrepCandidates({
      exePath: path.join(path.sep, 'opt', 'doge.exe'),
      moduleDir: path.join(path.sep, 'src', 'utils'),
    })
    expect(candidates[0]).toBe(
      path.resolve(path.join(path.sep, 'custom', 'rg.exe')),
    )
  })

  test('without override, exactly two real-disk candidates in order', () => {
    const candidates = builtinRipgrepCandidates({
      exePath: path.join(path.sep, 'opt', 'doge.exe'),
      moduleDir: path.join(path.sep, 'src', 'utils'),
    })
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).not.toBe(candidates[1])
  })
})

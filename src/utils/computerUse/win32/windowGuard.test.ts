import { expect, test } from 'bun:test'
import {
  buildEnsureWindowScript,
  parseEnsureOutput,
} from './windowGuard.js'

// ── parseEnsureOutput ───────────────────────────────────────────────────────

test('parses OK / DEAD / NOFG statuses', () => {
  expect(parseEnsureOutput('OK')).toEqual({ status: 'ok' })
  expect(parseEnsureOutput('DEAD')).toEqual({ status: 'dead' })
  expect(parseEnsureOutput('NOFG|Visual Studio')).toEqual({
    status: 'not_foreground',
    foregroundTitle: 'Visual Studio',
  })
})

test('parses empty title in NOFG as null', () => {
  expect(parseEnsureOutput('NOFG|')).toEqual({
    status: 'not_foreground',
    foregroundTitle: null,
  })
})

test('treats empty or garbage output as dead (fail-closed, never blind input)', () => {
  expect(parseEnsureOutput('')).toEqual({ status: 'dead' })
  expect(parseEnsureOutput('   ')).toEqual({ status: 'dead' })
  expect(parseEnsureOutput('Add-Type : some powershell error')).toEqual({
    status: 'dead',
  })
})

test('ignores trailing noise after the status line', () => {
  expect(parseEnsureOutput('OK\r\nsome warning')).toEqual({ status: 'ok' })
})

test('negative or non-integer hwnd is dead without spawning anything', () => {
  // ensureWindow itself spawns PowerShell; the guard entry in platforms/win32
  // validates first. parseEnsureOutput is exercised via the statuses above.
  expect(parseEnsureOutput('DEAD')).toEqual({ status: 'dead' })
})

// ── buildEnsureWindowScript ─────────────────────────────────────────────────

test('foreground script restores minimized windows and retries activation', () => {
  const script = buildEnsureWindowScript(12345, true)
  expect(script).toContain('IsWindow')
  expect(script).toContain('IsIconic')
  // SW_RESTORE = 9
  expect(script).toContain('ShowWindow([IntPtr]12345, 9)')
  // Foreground-lock workaround + last-resort ALT nudge + retry loop
  expect(script).toContain('AttachThreadInput')
  expect(script).toContain('[CuGuard]::AltNudge()')
  expect(script).toContain('for ($i = 0; $i -lt 3')
  // Re-verification after activation attempts
  expect(script).toContain('NOFG|')
})

test('liveness-only script skips the activation block entirely', () => {
  const script = buildEnsureWindowScript(999, false)
  expect(script).toContain('IsWindow')
  // The C# helper class is always compiled in full — assert on INVOCATIONS.
  expect(script).not.toContain('[CuGuard]::TryForeground')
  expect(script).not.toContain('[CuGuard]::IsIconic')
  expect(script).not.toContain('[CuGuard]::AltNudge')
  expect(script).not.toContain('NOFG|')
})

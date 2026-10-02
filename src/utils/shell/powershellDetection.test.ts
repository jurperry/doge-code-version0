import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock the PATH probe so the pwsh → powershell fallback is exercised
// hermetically (real machines may or may not have pwsh installed). The probe
// table is mutable so each test re-scripts the lookups without re-mocking.
// bun test shares one module registry across files, so the mock must keep the
// module's full surface: `which` intercepts only pwsh/powershell (everything
// else delegates to the real Bun.which) and `whichSync` passes straight
// through — unrelated modules import whichSync from this module.
const probeTable: Record<string, string | null> = {
  pwsh: null,
  powershell: null,
}
const realWhich =
  typeof Bun !== 'undefined' && typeof Bun.which === 'function'
    ? Bun.which.bind(Bun)
    : () => null
mock.module('../which.js', () => ({
  which: async (cmd: string): Promise<string | null> =>
    cmd in probeTable ? probeTable[cmd] : realWhich(cmd),
  whichSync: (cmd: string): string | null => realWhich(cmd),
}))

const { findPowerShell, getPowerShellEdition, resetPowerShellCache } =
  await import('./powershellDetection.js')

beforeEach(() => {
  probeTable.pwsh = null
  probeTable.powershell = null
  resetPowerShellCache()
})

afterAll(() => {
  mock.restore()
})

describe('findPowerShell pwsh → powershell fallback', () => {
  test('prefers pwsh (PowerShell 7+) when both are on PATH', async () => {
    probeTable.pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    probeTable.powershell =
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    expect(await findPowerShell()).toBe(probeTable.pwsh)
    expect(await getPowerShellEdition()).toBe('core')
  })

  test('falls back to Windows PowerShell 5.1 when pwsh is absent', async () => {
    probeTable.powershell =
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    expect(await findPowerShell()).toBe(probeTable.powershell)
    expect(await getPowerShellEdition()).toBe('desktop')
  })

  test('null when neither pwsh nor powershell exists', async () => {
    expect(await findPowerShell()).toBe(null)
    expect(await getPowerShellEdition()).toBe(null)
  })
})

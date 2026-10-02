import { describe, expect, test } from 'bun:test'
import {
  isPowerShellToolEnabledFor,
  resolveActiveShellToolFor,
  type ShellToolGateInput,
} from './shellToolUtils.js'

function gate(overrides: Partial<ShellToolGateInput>): ShellToolGateInput {
  return {
    platform: 'windows',
    userType: undefined,
    psToolEnv: undefined,
    defaultShell: 'bash',
    ...overrides,
  }
}

describe('isPowerShellToolEnabledFor', () => {
  test('non-Windows is always off, even with the setting selected', () => {
    expect(
      isPowerShellToolEnabledFor(
        gate({ platform: 'macos', defaultShell: 'powershell' }),
      ),
    ).toBe(false)
    expect(
      isPowerShellToolEnabledFor(gate({ platform: 'linux', psToolEnv: '1' })),
    ).toBe(false)
  })

  test('defaultShell: powershell opts in unconditionally', () => {
    expect(
      isPowerShellToolEnabledFor(gate({ defaultShell: 'powershell' })),
    ).toBe(true)
    // Even an explicit env killswitch does not override an explicit setting.
    expect(
      isPowerShellToolEnabledFor(
        gate({ defaultShell: 'powershell', psToolEnv: '0' }),
      ),
    ).toBe(true)
    expect(
      isPowerShellToolEnabledFor(
        gate({ defaultShell: 'powershell', userType: 'ant', psToolEnv: '0' }),
      ),
    ).toBe(true)
  })

  test('env gate preserved when the setting is bash', () => {
    // external: opt-in via env=1
    expect(isPowerShellToolEnabledFor(gate({}))).toBe(false)
    expect(isPowerShellToolEnabledFor(gate({ psToolEnv: '0' }))).toBe(false)
    expect(isPowerShellToolEnabledFor(gate({ psToolEnv: '1' }))).toBe(true)
    expect(isPowerShellToolEnabledFor(gate({ psToolEnv: 'true' }))).toBe(true)
    // ant: defaults on, opt-out via env=0
    expect(isPowerShellToolEnabledFor(gate({ userType: 'ant' }))).toBe(true)
    expect(
      isPowerShellToolEnabledFor(gate({ userType: 'ant', psToolEnv: '0' })),
    ).toBe(false)
    expect(
      isPowerShellToolEnabledFor(gate({ userType: 'ant', psToolEnv: 'false' })),
    ).toBe(false)
    expect(
      isPowerShellToolEnabledFor(gate({ userType: 'ant', psToolEnv: '1' })),
    ).toBe(true)
  })
})

describe('resolveActiveShellToolFor', () => {
  test('powershell only when the gate is open AND the setting selects it', () => {
    expect(
      resolveActiveShellToolFor(gate({ defaultShell: 'powershell' })),
    ).toBe('powershell')
  })

  test('env=1 without the setting does not make pwsh active', () => {
    expect(resolveActiveShellToolFor(gate({ psToolEnv: '1' }))).toBe('bash')
    expect(
      resolveActiveShellToolFor(gate({ userType: 'ant' })),
    ).toBe('bash')
  })

  test('non-Windows always resolves to bash', () => {
    expect(
      resolveActiveShellToolFor(
        gate({ platform: 'macos', defaultShell: 'powershell' }),
      ),
    ).toBe('bash')
    expect(
      resolveActiveShellToolFor(gate({ platform: 'linux', psToolEnv: '1' })),
    ).toBe('bash')
  })

  test('bash by default', () => {
    expect(resolveActiveShellToolFor(gate({}))).toBe('bash')
  })
})

import { describe, expect, test } from 'bun:test'
import { parseShellArgs } from './args.js'

describe('parseShellArgs', () => {
  test('empty args open the interactive selector', () => {
    expect(parseShellArgs('')).toEqual({ kind: 'select' })
    expect(parseShellArgs('   ')).toEqual({ kind: 'select' })
  })

  test('direct selection: bash', () => {
    expect(parseShellArgs('bash')).toEqual({ kind: 'set', shell: 'bash' })
    expect(parseShellArgs('BASH')).toEqual({ kind: 'set', shell: 'bash' })
  })

  test('direct selection: pwsh and its powershell alias', () => {
    expect(parseShellArgs('pwsh')).toEqual({ kind: 'set', shell: 'powershell' })
    expect(parseShellArgs('powershell')).toEqual({
      kind: 'set',
      shell: 'powershell',
    })
    expect(parseShellArgs('PwSh')).toEqual({ kind: 'set', shell: 'powershell' })
  })

  test('status', () => {
    expect(parseShellArgs('status')).toEqual({ kind: 'status' })
  })

  test('help variants', () => {
    for (const arg of ['help', '-h', '--help']) {
      expect(parseShellArgs(arg)).toEqual({ kind: 'help' })
    }
  })

  test('anything else is invalid and echoes the raw arg', () => {
    expect(parseShellArgs('zsh')).toEqual({ kind: 'invalid', arg: 'zsh' })
    expect(parseShellArgs('  Zsh ')).toEqual({ kind: 'invalid', arg: 'Zsh' })
  })
})

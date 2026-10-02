import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildPowerShellArgs,
  createPowerShellProvider,
  POWERSHELL_UTF8_PREAMBLE,
} from './powershellProvider.js'

const ENV_KEY = 'CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY'
const savedEnv = process.env[ENV_KEY]

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
})

describe('buildPowerShellArgs', () => {
  test('adds -ExecutionPolicy Bypass before -Command by default', () => {
    delete process.env[ENV_KEY]
    expect(buildPowerShellArgs('Get-Date')).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Get-Date',
    ])
  })

  test('omits the bypass when the respect-policy env is truthy', () => {
    process.env[ENV_KEY] = '1'
    expect(buildPowerShellArgs('Get-Date')).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Date',
    ])
    process.env[ENV_KEY] = 'true'
    expect(buildPowerShellArgs('Get-Date')).not.toContain('Bypass')
  })

  test('falsy env values still bypass', () => {
    process.env[ENV_KEY] = '0'
    expect(buildPowerShellArgs('Get-Date')).toContain('Bypass')
  })
})

describe('buildExecCommand UTF-8 preamble', () => {
  const PREAMBLE = POWERSHELL_UTF8_PREAMBLE

  test('non-sandbox command starts with the preamble on the same line', async () => {
    const provider = createPowerShellProvider('C:\\Tools\\pwsh.exe')
    const { commandString } = await provider.buildExecCommand('Get-Date', {
      id: 'ab',
      useSandbox: false,
    })
    // Same line (no newline) so error line numbers still match user input.
    expect(commandString.startsWith(PREAMBLE + 'Get-Date')).toBe(true)
    expect(commandString).toContain('Get-Location')
  })

  test('sandbox EncodedCommand decodes to the preamble + command', async () => {
    const provider = createPowerShellProvider('/opt/microsoft/powershell/7/pwsh')
    const { commandString } = await provider.buildExecCommand('Get-Date', {
      id: 'ab',
      useSandbox: true,
      sandboxTmpDir: '/tmp/sbx',
    })
    const encoded = commandString.split('-EncodedCommand ')[1]!
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(decoded.startsWith(PREAMBLE + 'Get-Date')).toBe(true)
  })
})

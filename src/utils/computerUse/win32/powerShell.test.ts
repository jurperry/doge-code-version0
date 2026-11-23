import { expect, test } from 'bun:test'

import { _test, runPowerShell, runPowerShellSync } from './powerShell.js'

test('PowerShell success returns trimmed stdout', () => {
  expect(_test.assertPowerShellSuccess({ exitCode: 0, stdout: '  ok\r\n', stderr: '' })).toBe('ok')
})

test('PowerShell exit failures and timeouts are explicit outcome-unknown errors', () => {
  expect(() => _test.assertPowerShellSuccess({
    exitCode: 1,
    stdout: '',
    stderr: 'Add-Type failed',
  })).toThrow(/Add-Type failed.*outcome is unknown.*do not blindly retry/i)
  expect(() => _test.assertPowerShellSuccess({
    exitCode: null,
    stdout: '',
    stderr: '',
  }, true)).toThrow(/timed out.*outcome is unknown/i)
})

const windowsTest = process.platform === 'win32' ? test : test.skip

windowsTest('real sync and async runners enforce timeout and carry stdin', async () => {
  expect(() => runPowerShellSync('Start-Sleep -Seconds 2', 30)).toThrow(/outcome is unknown/i)
  expect(runPowerShellSync('[Console]::Out.Write([Console]::In.ReadToEnd())', 1000, 'sync-stdin')).toBe('sync-stdin')
  await expect(runPowerShell('Start-Sleep -Seconds 2', 30)).rejects.toThrow(/timed out.*outcome is unknown/i)
  expect(await runPowerShell('[Console]::Out.Write([Console]::In.ReadToEnd())', 1000, 'stdin-ok')).toBe('stdin-ok')
})

windowsTest('abort during stdin writing still terminates the child', async () => {
  const controller = new AbortController()
  const pending = runPowerShell('Start-Sleep -Seconds 20', 30_000, 'pending-input', controller.signal)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
})

windowsTest('real runners preserve Unicode application paths', async () => {
  const path = 'E:\\game\\植物大战僵尸食物版\\PlantsVsZombiesFood.exe'
  expect(runPowerShellSync(`'${path}'`)).toBe(path)
  expect(await runPowerShell(`'${path}'`)).toBe(path)
})

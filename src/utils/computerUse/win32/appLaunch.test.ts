import { expect, test } from 'bun:test'

import { buildPortableAppLaunchBlock, START_CU_APPLICATION } from './appLaunch.js'

test('portable executables launch from their own directory', () => {
  const script = buildPortableAppLaunchBlock()
  expect(script).toContain('(Resolve-Path -LiteralPath $target).Path')
  expect(script).toContain('Start-CuApplication $cuLaunchExe (Split-Path -Parent $cuLaunchExe)')
  expect(START_CU_APPLICATION).toContain('FilePath = $file')
  expect(START_CU_APPLICATION).toContain('$startOptions.WorkingDirectory = $directory')
  expect(script).toContain('$launchPath = $cuLaunchExe')
})

test('a declined UAC launch exits instead of trying another launch path', () => {
  expect(START_CU_APPLICATION).toMatch(/NativeErrorCode -eq 1223[\s\S]+throw 'Windows cancelled the launch/)
})

test('resolved executable expressions use the same launch semantics', () => {
  const script = buildPortableAppLaunchBlock('$found.Source')
  expect(script).toContain('(Resolve-Path -LiteralPath $found.Source).Path')
  expect(script).not.toContain('Start-Process $target')
})

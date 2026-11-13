import { expect, test } from 'bun:test'

import { buildPortableAppLaunchBlock } from './appLaunch.js'

test('portable executables launch from their own directory', () => {
  const script = buildPortableAppLaunchBlock()
  expect(script).toContain('(Resolve-Path -LiteralPath $target).Path')
  expect(script).toContain('-WorkingDirectory (Split-Path -Parent $cuLaunchExe)')
  expect(script).toContain('-FilePath $cuLaunchExe')
  expect(script).toContain('$launchPath = $cuLaunchExe')
})

test('resolved executable expressions use the same launch semantics', () => {
  const script = buildPortableAppLaunchBlock('$found.Source')
  expect(script).toContain('(Resolve-Path -LiteralPath $found.Source).Path')
  expect(script).not.toContain('Start-Process $target')
})

import { expect, test } from 'bun:test'

import { _test } from './windowBorder.js'

test('border decoration is best effort', () => {
  expect(_test.tryBorder(() => '0')).toBe(true)
  expect(_test.tryBorder(() => '-1')).toBe(false)
  expect(_test.tryBorder(() => { throw new Error('PowerShell timed out') })).toBe(false)
})

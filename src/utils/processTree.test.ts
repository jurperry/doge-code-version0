import { expect, test } from 'bun:test'
import { descendantPids } from './processTree.js'

test('descendants include detached process groups and are ordered child-first', () => {
  expect(descendantPids(100, '100 1\n200 100\n300 200\n400 100\n500 1')).toEqual([300, 200, 400])
  expect(descendantPids(100, '100 200\n200 100\n200 100\ninvalid')).toEqual([200])
})

import { expect, test } from 'bun:test'

import { _test } from './toolRendering.js'

const text = (value: unknown): any => [{ type: 'text', text: JSON.stringify(value) }]

test('result summaries distinguish dispatch, partial batch failure and denied access', () => {
  expect(_test.getResultSummary('left_click', [])).toBe('Click dispatched')
  expect(_test.getResultSummary('computer_batch', text({ completed: [] }))).toBe('Batch dispatched')
  expect(_test.getResultSummary('computer_batch', text({ completed: [], failed: { ok: false }, remaining: 1 })))
    .toBe('Batch stopped with a failed action')
  expect(_test.getResultSummary('request_access', text({ granted: [], userConsented: false })))
    .toBe('Access declined')
})

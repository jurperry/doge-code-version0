import { expect, test } from 'bun:test'

import wrapText from '../ink/wrap-text.js'
import { Cursor } from '../utils/Cursor.js'
import { inputTextWrapMode } from './BaseTextInput.js'

const COLUMNS = 80

/** Render a value the way BaseTextInput does: Cursor layout, then Ink wrap. */
function renderInputValue(value: string, multiline: boolean): string {
  const cursor = Cursor.fromText(value, COLUMNS, value.length)
  const renderedValue = cursor.render('', '', s => s)
  return wrapText(renderedValue, COLUMNS, inputTextWrapMode(multiline))
}

test('multi-line inputs render with wrap, single-line with truncate-end', () => {
  expect(inputTextWrapMode(true)).toBe('wrap')
  expect(inputTextWrapMode(false)).toBe('truncate-end')
  expect(inputTextWrapMode(undefined)).toBe('truncate-end')
})

test('a multi-line prompt keeps every line visible', () => {
  // Five short lines: each fits, but the total width (90) exceeds the 80-col
  // terminal. Under truncate-end Ink measures the whole string and cuts it,
  // silently dropping the tail — the regression this guards.
  const value = [
    'first line here..',
    'second line here.',
    'third line here..',
    'fourth line here.',
    'fifth line here..',
  ].join('\n')

  const out = renderInputValue(value, true)
  const lines = out.split('\n')

  expect(lines).toHaveLength(5)
  expect(out).toContain('fifth line here..')
  expect(out).not.toContain('…')

  // And the previous behavior, for contrast: the tail is gone.
  expect(renderInputValue(value, false)).not.toContain('fifth line here..')
})

test('a multi-line prompt whose first line overflows keeps the later lines', () => {
  // Worst case, and the one users hit by pasting a long paragraph: the first
  // line alone is wider than the terminal, so a whole-string truncate leaves
  // exactly one line plus an ellipsis.
  const value = `${'A'.repeat(150)}\nsecond line\nthird line`

  const out = renderInputValue(value, true)
  const lines = out.split('\n')

  expect(lines.length).toBeGreaterThan(1)
  expect(out).toContain('second line')
  expect(out).toContain('third line')

  expect(renderInputValue(value, false)).not.toContain('third line')
})

test('single-line inputs keep the truncate-end behavior', () => {
  // Single-line inputs are deliberately left on truncate-end: they're meant to
  // stay clamped, so this pins the mode rather than the row count (Cursor
  // already soft-wraps long values, so both modes are multi-row here).
  const value = 'x'.repeat(200)
  const truncated = renderInputValue(value, false)
  const wrapped = renderInputValue(value, true)

  expect(truncated).toContain('…')
  expect(wrapped).not.toContain('…')
  // wrap keeps characters that truncate-end drops.
  expect(wrapped.replace(/\n/g, '').length).toBeGreaterThan(
    truncated.replace(/\n/g, '').length,
  )
})

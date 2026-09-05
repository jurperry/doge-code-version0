import { expect, test } from 'bun:test'
import { contextRingChar } from './TokenWarning.js'

// Ring glyph picks one of five fill steps by consumed fraction.
// Boundaries sit at the midpoints of 0/25/50/75/100%.
test('contextRingChar maps consumed fraction to ring fill steps', () => {
  expect(contextRingChar(0)).toBe('○')
  expect(contextRingChar(0.124)).toBe('○')
  expect(contextRingChar(0.125)).toBe('◔')
  expect(contextRingChar(0.3)).toBe('◔')
  expect(contextRingChar(0.375)).toBe('◑')
  expect(contextRingChar(0.6)).toBe('◑')
  expect(contextRingChar(0.625)).toBe('◕')
  expect(contextRingChar(0.8)).toBe('◕')
  expect(contextRingChar(0.875)).toBe('●')
  expect(contextRingChar(1)).toBe('●')
})

test('contextRingChar clamps out-of-range fractions', () => {
  expect(contextRingChar(-0.5)).toBe('○')
  expect(contextRingChar(1.5)).toBe('●')
})

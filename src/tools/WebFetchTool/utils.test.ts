import { expect, test } from 'bun:test'
import {
  isPermittedRedirect,
  shouldRunWebFetchPreflight,
} from './utils.js'

test('WebFetch preflight defaults to the Anthropic protocol on the official endpoint', () => {
  expect(shouldRunWebFetchPreflight(undefined, 'anthropic', true)).toBe(true)
  expect(shouldRunWebFetchPreflight(undefined, 'anthropic', false)).toBe(false)
  expect(shouldRunWebFetchPreflight(undefined, 'openai', true)).toBe(false)
  expect(shouldRunWebFetchPreflight(undefined, 'responses', true)).toBe(false)
})

test('explicit WebFetch preflight settings override connection defaults', () => {
  expect(shouldRunWebFetchPreflight(true, 'anthropic', true)).toBe(false)
  expect(shouldRunWebFetchPreflight(false, 'openai', false)).toBe(true)
  expect(shouldRunWebFetchPreflight(false, 'responses', false)).toBe(true)
})

test('skipping preflight does not relax redirect boundaries', () => {
  expect(
    isPermittedRedirect(
      'https://example.com/start',
      'https://www.example.com/next',
    ),
  ).toBe(true)
  expect(
    isPermittedRedirect(
      'https://example.com/start',
      'https://other.example.net/next',
    ),
  ).toBe(false)
  expect(
    isPermittedRedirect(
      'https://example.com/start',
      'http://example.com/next',
    ),
  ).toBe(false)
})

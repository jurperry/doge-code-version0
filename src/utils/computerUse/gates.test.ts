import { afterEach, beforeEach, expect, test } from 'bun:test'

import { getChicagoEnabled } from './gates.js'

const originalOptOut = process.env.DOGE_COMPUTER_USE_MCP

beforeEach(() => {
  delete process.env.DOGE_COMPUTER_USE_MCP
})

afterEach(() => {
  if (originalOptOut === undefined) delete process.env.DOGE_COMPUTER_USE_MCP
  else process.env.DOGE_COMPUTER_USE_MCP = originalOptOut
})

test('computer use is enabled by default', () => {
  expect(getChicagoEnabled()).toBe(true)
})

test('computer use honors explicit false environment values', () => {
  for (const value of ['0', 'false', 'no', 'off', ' FALSE ']) {
    process.env.DOGE_COMPUTER_USE_MCP = value
    expect(getChicagoEnabled()).toBe(false)
  }
})

test('computer use remains enabled for explicit true and unrelated values', () => {
  for (const value of ['1', 'true', 'yes', 'on', '']) {
    process.env.DOGE_COMPUTER_USE_MCP = value
    expect(getChicagoEnabled()).toBe(true)
  }
})

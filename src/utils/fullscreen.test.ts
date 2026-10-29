import { afterEach, describe, expect, test } from 'bun:test'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import { _resetTmuxControlModeProbeForTesting, isFullscreenEnvEnabled } from './fullscreen.js'

const keys = ['CLAUDE_CODE_NO_FLICKER', 'USER_TYPE', 'TMUX', 'TERM_PROGRAM'] as const
const previous = new Map<string, string | undefined>(keys.map(key => [key, process.env[key]]))
const wasInteractive = getIsInteractive()

afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setIsInteractive(wasInteractive)
  _resetTmuxControlModeProbeForTesting()
})

describe('isFullscreenEnvEnabled', () => {
  test('defaults to the separated layout for interactive Doge users', () => {
    delete process.env.CLAUDE_CODE_NO_FLICKER
    delete process.env.TMUX
    delete process.env.USER_TYPE
    setIsInteractive(true)
    expect(isFullscreenEnvEnabled()).toBe(true)
    process.env.USER_TYPE = 'external'
    expect(isFullscreenEnvEnabled()).toBe(true)
  })

  test('keeps headless and SDK rendering sequential by default', () => {
    delete process.env.CLAUDE_CODE_NO_FLICKER
    delete process.env.TMUX
    setIsInteractive(false)
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test.each(['0', 'false', 'no', 'off'])('preserves native scrollback with CLAUDE_CODE_NO_FLICKER=%s', value => {
    setIsInteractive(true)
    process.env.CLAUDE_CODE_NO_FLICKER = value
    expect(isFullscreenEnvEnabled()).toBe(false)
  })

  test('preserves the explicit fullscreen opt-in', () => {
    setIsInteractive(false)
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    expect(isFullscreenEnvEnabled()).toBe(true)
  })
})

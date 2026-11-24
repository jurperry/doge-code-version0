import { describe, expect, test } from 'bun:test'

import { _test as inputSemantics, bindWindow, captureScreenForApi, getBindingRelease, getBoundHwnd, platform, unbindWindow } from './platforms/win32.js'
import { _test as messageSemantics } from './win32/windowMessage.js'

describe('Windows input planning', () => {
  test('key chords keep modifiers held around main keys and normalize letter VKs', () => {
    expect(inputSemantics.planKeyChord(['ctrl', 'shift', 'a'])).toEqual({
      modifiers: [0xA2, 0xA0],
      keys: [0x41],
    })
    expect(inputSemantics.planKeyChord(['ctrl', 'v'])).toEqual({
      modifiers: [0xA2],
      keys: [0x56],
    })
    expect(inputSemantics.vkForKey('a')).toBe(0x41)
    expect(() => inputSemantics.planKeyChord(['ctrl', 'not-a-key'])).toThrow(/no input was sent/i)
  })

  test('Unicode uses UTF-16 SendInput events and base64 rather than script interpolation', () => {
    const payload = "中文😀'; Write-Host should-not-run'"
    const script = inputSemantics.unicodePowerShellScript(payload)
    expect(script).not.toContain(payload)
    expect(script).toContain('[Console]::In.ReadToEnd()')
    expect(Buffer.from(payload, 'utf8').toString('base64')).toBeTruthy()
    expect(script).toContain('foreach (char ch in text)')
    expect(script).toContain('events.Add(Event(0, ch, 0x0004))')
    expect(script).toContain('events.Add(Event(0, ch, 0x0004 | 0x0002))')
    expect(script).toContain('SendInput')
    expect(script).toContain('LayoutKind.Sequential')
    expect(script).toContain('[FieldOffset(8)] public CuInputUnion union')
  })

  test('Unicode foreground guard is exclusive to bound-window input', () => {
    const global = inputSemantics.unicodePowerShellScript('global')
    expect(global).not.toContain('CuGuard')
    expect(global).not.toContain('SetCursorPos')
    const bound = inputSemantics.unicodePowerShellScript('bound', 123)
    expect(bound).toContain('CuGuard')
    expect(bound).toContain('[IntPtr]123')
  })

  test('multi-click stays in one script and middle-click uses middle flags/messages', () => {
    const script = inputSemantics.clickPowerShellScript(123, 10, 20, 'middle', 3)
    expect(script).toContain('for ($i = 0; $i -lt 3; $i++)')
    expect(script).toContain('mouse_event(0x0020')
    expect(script).toContain('mouse_event(0x0040')
    expect(script).toContain('if (-not [CuWin32]::GetWindowRect')
    expect(script).toContain('if (-not [CuWin32]::SetCursorPos')
    expect(messageSemantics.clickMessages('middle')).toEqual({ down: '0x0207', up: '0x0208', buttons: 16 })
    expect(messageSemantics.clickMessages('right')).toEqual({ down: '0x0204', up: '0x0205', buttons: 2 })
    expect(messageSemantics.requireProcess(123, 456)).toBe('[WinMsg]::RequireProcess([IntPtr]123, 456)')
  })

  test('wheel deltas preserve the public up/down and left/right contract', () => {
    expect(inputSemantics.wheelDelta(-3, 'vertical')).toBe(360)
    expect(inputSemantics.wheelDelta(3, 'vertical')).toBe(-360)
    expect(inputSemantics.wheelDelta(3, 'horizontal')).toBe(360)
    expect(inputSemantics.wheelDelta(-3, 'horizontal')).toBe(-360)
  })
})

describe('Windows geometry', () => {
  test('window downsampling preserves its own aspect ratio and never upscales', () => {
    expect(inputSemantics.fitCaptureDimensions(800, 400, 400, 400)).toEqual([400, 200])
    expect(inputSemantics.fitCaptureDimensions(800, 400, 1600, 900)).toEqual([800, 400])
  })


})


describe('Windows bound-target transitions', () => {
  test('only a newly started different foreground process leaves the old binding', () => {
    const leave = inputSemantics.shouldLeaveBoundForNewForeground
    expect(leave(10, 1000, { id: 'new', appName: 'new', pid: 20, startedAt: 2000 })).toBe(true)
    expect(leave(10, 1000, { id: 'old', appName: 'old', pid: 20, startedAt: 500 })).toBe(false)
    expect(leave(10, 1000, { id: 'same', appName: 'same', pid: 10, startedAt: 2000 })).toBe(false)
    expect(leave(10, 1000, { id: 'unknown', appName: 'unknown', pid: 20, startedAt: 0 })).toBe(false)
    expect(leave(null, 1000, { id: 'new', appName: 'new', pid: 20, startedAt: 2000 })).toBe(false)
    expect(leave(10, 1000, {
      id: 'renderer', appName: 'renderer', pid: 30, startedAt: 3000,
      hostId: 'host', hostName: 'host', hostPid: 10, hostStartedAt: 500,
    })).toBe(false)
  })

  test('UAC consent and our own elevation broker are not target takeovers', () => {
    const transient = inputSemantics.isComputerUseTransientForeground
    const context = { selfPid: 10, helperPid: 20 }
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    expect(transient({ id: `${systemRoot}\\System32\\consent.exe`, appName: 'consent', pid: 30, startedAt: 2000 }, context)).toBe(true)
    expect(transient({ id: 'consent', appName: 'consent', pid: 30, startedAt: 2000 }, context)).toBe(true)
    expect(transient({ id: 'C:\\Tools\\consent.exe', appName: 'consent', pid: 30, startedAt: 2000 }, context)).toBe(false)
    expect(transient({
      id: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      appName: 'powershell', pid: 20, startedAt: 2000,
    }, context)).toBe(true)
    expect(transient({
      id: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      appName: 'powershell', pid: 30, hostPid: 20, startedAt: 2000, hostStartedAt: 2000,
    }, context)).toBe(true)
    expect(transient({ id: 'C:\\Tools\\doge.exe', appName: 'doge', pid: 10, startedAt: 2000 }, context)).toBe(true)
    expect(transient({ id: 'C:\\Games\\game.exe', appName: 'game', pid: 30, startedAt: 2000 }, context)).toBe(false)
  })
})


describe('Windows capture revisions', () => {
  test.skipIf(process.platform !== 'win32')('only visible screenshots fall back after a bound window fails capture', async () => {
    const original = platform.screenshot.captureScreen
    platform.screenshot.captureScreen = async displayId => {
      if (getBoundHwnd()) throw new Error('the window did not render')
      return { base64: 'capture', width: 100, height: 100, displayId, captureMode: 'full_display' }
    }
    try {
      bindWindow(1, process.pid, undefined, 'fixture')
      await expect(captureScreenForApi()).rejects.toThrow('the window did not render')
      expect(getBoundHwnd()).toBe(1)
      const shot = await captureScreenForApi(undefined, true)
      expect(shot.captureMode).toBe('full_display')
      expect(getBoundHwnd()).toBeNull()
      expect(getBindingRelease()?.reason).toBe('capture_unavailable')
    } finally {
      platform.screenshot.captureScreen = original
      unbindWindow()
    }
  })

  test('a capture is discarded if the binding changes while it is pending', async () => {
    const original = platform.screenshot.captureScreen
    let finish!: () => void
    platform.screenshot.captureScreen = async () => new Promise(resolve => {
      finish = () => resolve({
        base64: Buffer.alloc(2048, 1).toString('base64'),
        width: 100, height: 100, displayWidth: 100, displayHeight: 100,
        originX: 0, originY: 0,
      })
    })
    try {
      const pending = captureScreenForApi()
      unbindWindow()
      finish()
      await expect(pending).rejects.toThrow(/target changed.*old image was discarded/i)
    } finally {
      platform.screenshot.captureScreen = original
    }
  })
})

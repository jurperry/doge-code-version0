import { describe, expect, test } from 'bun:test'

import { _test as inputSemantics } from './platforms/win32.js'
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

  test('multi-click stays in one script and middle-click uses middle flags/messages', () => {
    const script = inputSemantics.clickPowerShellScript(123, 10, 20, 'middle', 3)
    expect(script).toContain('for ($i = 0; $i -lt 3; $i++)')
    expect(script).toContain('mouse_event(0x0020')
    expect(script).toContain('mouse_event(0x0040')
    expect(script).toContain('if (-not [CuClickRect]::GetWindowRect')
    expect(script).toContain('if (-not [CuWin32]::SetCursorPos')
    expect(messageSemantics.clickMessages('middle')).toEqual({ down: '0x0207', up: '0x0208' })
    expect(messageSemantics.clickMessages('right')).toEqual({ down: '0x0204', up: '0x0205' })
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

  test('display parsing retains negative virtual-screen origins', () => {
    expect(inputSemantics.parseDisplayEntries('1920,1080,0,-1920,-100,False,1.5|1280,720,1,0,0,True,1')).toEqual([
      { width: 1920, height: 1080, displayId: 0, originX: -1920, originY: -100, scaleFactor: 1 },
      { width: 1280, height: 720, displayId: 1, originX: 0, originY: 0, scaleFactor: 1 },
    ])
    expect(() => inputSemantics.parseDisplayEntries('bad-entry')).toThrow('Invalid display metadata entry')
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildComputerUseTools } from './tools.js'
import type { BindingReleaseInfo, ComputerExecutor } from './executor.js'
import {
  ComputerUseActionError,
  handleToolCall,
  resetMouseButtonHeld,
  _test,
} from './toolCalls.js'
import {
  DEFAULT_GRANT_FLAGS,
  type ComputerUseHostAdapter,
  type ComputerUseOverrides,
} from './types.js'

const validBase64 = Buffer.alloc(2048, 7).toString('base64')
const shot = (width = 100, height = 100) => ({
  base64: validBase64,
  width,
  height,
  displayWidth: width,
  displayHeight: height,
  originX: 0,
  originY: 0,
  displayId: 0,
})

function makeAdapter(executorOverrides: Partial<ComputerExecutor> = {}): ComputerUseHostAdapter {
  const frontmost = { bundleId: 'app.test', displayName: 'Test App' }
  const executor: ComputerExecutor = {
    capabilities: { screenshotFiltering: 'native', platform: 'darwin', hostBundleId: 'host.test' },
    prepareForAction: async () => [],
    previewHideSet: async () => [],
    getDisplaySize: async () => ({ width: 100, height: 100, scaleFactor: 1, originX: 0, originY: 0, displayId: 0 }),
    listDisplays: async () => [{ width: 100, height: 100, scaleFactor: 1, originX: 0, originY: 0, displayId: 0 }],
    findWindowDisplays: async () => [],
    resolvePrepareCapture: async () => ({ ...shot(), hidden: [] }),
    screenshot: async () => shot(),
    zoom: async () => ({ base64: validBase64, width: 50, height: 50 }),
    key: async () => {},
    holdKey: async () => {},
    type: async () => {},
    readClipboard: async () => '',
    writeClipboard: async () => {},
    moveMouse: async () => {},
    click: async () => {},
    mouseDown: async () => {},
    mouseUp: async () => {},
    getCursorPosition: async () => ({ x: 25, y: 25 }),
    drag: async () => {},
    scroll: async () => {},
    getFrontmostApp: async () => frontmost,
    appUnderPoint: async () => frontmost,
    listInstalledApps: async () => [],
    getAppIcon: async () => undefined,
    listRunningApps: async () => [],
    openApp: async () => {},
    ...executorOverrides,
  }
  return {
    serverName: 'computer-use-test',
    logger: { silly() {}, debug() {}, info() {}, warn() {}, error() {} },
    executor,
    ensureOsPermissions: async () => ({ granted: true }),
    isDisabled: () => false,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  }
}

function makeOverrides(extra: Partial<ComputerUseOverrides> = {}): ComputerUseOverrides {
  return {
    allowedApps: [{ bundleId: 'app.test', displayName: 'Test App', grantedAt: 1, tier: 'full' }],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    userDeniedBundleIds: [],
    coordinateMode: 'pixels',
    lastScreenshot: shot(),
    ...extra,
  }
}

function json(result: any): any {
  return JSON.parse(result.content[0].text)
}

beforeEach(() => resetMouseButtonHeld())
afterEach(() => resetMouseButtonHeld())

describe('screenshot validity and persistence', () => {
  const emptyShot = () => ({
    base64: '', width: 0, height: 0, displayWidth: 0, displayHeight: 0,
    originX: 0, originY: 0, displayId: 0,
  })

  test('non-atomic capture retries once then fails closed without stashing', async () => {
    let calls = 0
    const result = await handleToolCall(makeAdapter({
      screenshot: async () => { calls++; return emptyShot() },
    }), 'screenshot', {}, makeOverrides())

    expect(calls).toBe(2)
    expect(result.isError).toBe(true)
    expect(result.telemetry?.error_kind).toBe('capture_failed')
    expect(result.content.some(item => item.type === 'image')).toBe(false)
    expect(result.screenshot).toBeUndefined()
  })

  test('a transient empty capture can recover on the retry', async () => {
    let calls = 0
    const result = await handleToolCall(makeAdapter({
      screenshot: async () => ++calls === 1 ? emptyShot() : shot(),
    }), 'screenshot', {}, makeOverrides())

    expect(calls).toBe(2)
    expect(result.isError).toBeUndefined()
    expect(result.screenshot).toBeDefined()
    expect(result.content.some(item => item.type === 'image')).toBe(true)
  })

  test('screenshot and zoom prepare the current target before capture', async () => {
    const requestSignal = new AbortController().signal
    const calls: string[] = []
    const adapter = makeAdapter({
      prepareForTarget: async signal => {
        expect(signal).toBe(requestSignal)
        calls.push('prepare')
      },
      screenshot: async () => { calls.push('screenshot'); return shot() },
      zoom: async () => { calls.push('zoom'); return { base64: validBase64, width: 50, height: 50 } },
    })
    const options = makeOverrides({ requestSignal })
    expect((await handleToolCall(adapter, 'screenshot', {}, options)).isError).toBeUndefined()
    expect((await handleToolCall(adapter, 'zoom', { region: [0, 0, 20, 20] }, options)).isError).toBeUndefined()
    expect(calls).toEqual(['prepare', 'screenshot', 'prepare', 'zoom'])
  })

  test('a binding released during capture is reported instead of silently changing space', async () => {
    let bound = true
    let release: BindingReleaseInfo | null = null
    const adapter = makeAdapter({
      isWindowBound: () => bound,
      getBoundAppId: () => bound ? 'app.test' : null,
      getBoundRevision: () => bound ? 1 : 2,
      prepareForTarget: async () => {
        bound = false
        release = {
          reason: 'new_foreground',
          at: Date.now(),
          revision: 2,
          appId: 'app.test',
          pid: 1,
          hwnd: 10,
          foreground: {
            bundleId: 'C:\\Windows\\System32\\consent.exe',
            displayName: 'consent',
            pid: 99,
            startedAt: Date.now(),
          },
        }
      },
      getBindingRelease: () => release,
      screenshot: async () => ({ ...shot(), captureMode: 'full_display' }),
    })
    const result = await handleToolCall(adapter, 'screenshot', {}, makeOverrides())
    expect(result.isError).toBeUndefined()
    expect(result.screenshot?.captureMode).toBe('full_display')
    expect(result.screenshot?.bindingRelease).toEqual(release!)
    expect(result.content.some(item => item.type === 'text' && item.text.includes('(capture=full_display)'))).toBe(true)
    expect(result.content.some(item => item.type === 'text' && item.text.includes('Binding released before this capture'))).toBe(true)
  })

  test('a release from an earlier call is still surfaced on the next full-display capture', async () => {
    const release: BindingReleaseInfo = {
      reason: 'new_foreground',
      at: Date.now() - 1000,
      revision: 2,
      appId: 'app.test',
      pid: 1,
      hwnd: 10,
      foreground: null,
    }
    const adapter = makeAdapter({
      getBoundRevision: () => 2,
      getBindingRelease: () => release,
      screenshot: async () => ({ ...shot(), captureMode: 'full_display' }),
    })
    const result = await handleToolCall(adapter, 'screenshot', {}, makeOverrides())
    expect(result.isError).toBeUndefined()
    expect(result.screenshot?.bindingRelease).toEqual(release)
    expect(result.content.some(item => item.type === 'text' && item.text.includes('Binding released before this capture'))).toBe(true)
  })

  test('atomic capture surfaces capture mode and release metadata', async () => {
    const release: BindingReleaseInfo = {
      reason: 'new_foreground',
      at: Date.now() - 1000,
      revision: 2,
      appId: 'app.test',
      pid: 1,
      hwnd: 10,
      foreground: null,
    }
    const adapter = makeAdapter({
      getBoundRevision: () => 2,
      getBindingRelease: () => release,
      resolvePrepareCapture: async () => ({ ...shot(), captureMode: 'full_display', hidden: [] }),
    })
    const gates = adapter.getSubGates()
    adapter.getSubGates = () => ({ ...gates, autoTargetDisplay: true })
    const result = await handleToolCall(adapter, 'screenshot', {}, makeOverrides())
    expect(result.isError).toBeUndefined()
    expect(result.screenshot?.captureMode).toBe('full_display')
    expect(result.screenshot?.bindingRelease).toEqual(release)
    expect(result.content.some(item => item.type === 'text' && item.text.includes('(capture=full_display)'))).toBe(true)
    expect(result.content.some(item => item.type === 'text' && item.text.includes('Binding released before this capture'))).toBe(true)
  })

  test('a release during capture is surfaced even when prepare did not unbind', async () => {
    let release: BindingReleaseInfo | null = null
    const adapter = makeAdapter({
      getBoundRevision: () => release ? 2 : 1,
      getBindingRelease: () => release,
      screenshot: async () => {
        release = {
          reason: 'new_foreground',
          at: Date.now(),
          revision: 2,
          appId: 'app.test',
          pid: 1,
          hwnd: 10,
          foreground: null,
        }
        return { ...shot(), captureMode: 'full_display' }
      },
    })
    const result = await handleToolCall(adapter, 'screenshot', {}, makeOverrides())
    expect(result.isError).toBeUndefined()
    expect(result.screenshot?.bindingRelease).toEqual(release!)
    expect(result.content.some(item => item.type === 'text' && item.text.includes('Binding released before this capture'))).toBe(true)
  })

  test('a post-capture release never relabels a bound image as full-display', async () => {
    let release: BindingReleaseInfo | null = null
    const adapter = makeAdapter({
      getBoundRevision: () => release ? 2 : 1,
      getBindingRelease: () => release,
      screenshot: async () => {
        release = {
          reason: 'new_foreground',
          at: Date.now(),
          revision: 2,
          appId: 'app.test',
          pid: 1,
          hwnd: 10,
          foreground: null,
        }
        return { ...shot(), captureMode: 'bound_window' }
      },
    })
    const result = await handleToolCall(adapter, 'screenshot', {}, makeOverrides())
    expect(result.isError).toBeUndefined()
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
    expect(text).toContain('(capture=bound_window)')
    expect(text).toContain('still window-bound')
    expect(text).not.toContain('This image is full-display')
    expect(result.screenshot?.bindingRelease).toEqual(release!)
  })

  test('a revoked bound target cannot prepare elevation or be captured', async () => {
    let preparations = 0
    const adapter = makeAdapter({
      getBoundAppId: () => 'revoked.app',
      prepareForTarget: async () => { preparations++ },
    })
    const options = makeOverrides()
    const screenshot = await handleToolCall(adapter, 'screenshot', {}, options)
    const zoom = await handleToolCall(adapter, 'zoom', { region: [0, 0, 20, 20] }, options)
    expect(screenshot.telemetry?.error_kind).toBe('app_not_granted')
    expect(zoom.telemetry?.error_kind).toBe('app_not_granted')
    expect(preparations).toBe(0)
  })

  test('a thrown transient capture is retried and later throws become capture_failed', async () => {
    let calls = 0
    const recovered = await handleToolCall(makeAdapter({
      screenshot: async () => {
        calls++
        if (calls === 1) throw new Error('transient capture failure')
        return shot()
      },
    }), 'screenshot', {}, makeOverrides())
    expect(recovered.isError).toBeUndefined()
    expect(calls).toBe(2)

    const failed = await handleToolCall(makeAdapter({
      screenshot: async () => { throw new Error('capture unavailable') },
    }), 'screenshot', {}, makeOverrides())
    expect(failed.isError).toBe(true)
    expect(failed.telemetry?.error_kind).toBe('capture_failed')
    expect(failed.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/capture unavailable.*Recovery:.*Do not click using stale coordinates/) })
  })

  test('single-display capture metadata avoids a second enumeration for monitor notes', async () => {
    let enumerations = 0
    const adapter = makeAdapter({
      resolvePrepareCapture: async () => ({ ...shot(), displayCount: 1, hidden: [] }),
      listDisplays: async () => { enumerations++; return [] },
    })
    const gates = adapter.getSubGates()
    adapter.getSubGates = () => ({ ...gates, autoTargetDisplay: true })
    const result = await handleToolCall(adapter, 'screenshot', {}, makeOverrides())
    expect(result.isError).toBeUndefined()
    expect(result.screenshot?.displayCount).toBe(1)
    expect(enumerations).toBe(0)
  })

  test('a valid but very small bound-window image is not rejected by the retry heuristic', async () => {
    const tiny = { ...shot(16, 16), base64: 'c21hbGw=' }
    const result = await handleToolCall(makeAdapter({
      screenshot: async () => tiny,
    }), 'screenshot', {}, makeOverrides())
    expect(result.isError).toBeUndefined()
    expect(result.screenshot?.width).toBe(16)
  })

  test('atomic capture also rejects an empty result instead of warning and succeeding', async () => {
    const adapter = makeAdapter({
      resolvePrepareCapture: async () => ({ ...emptyShot(), hidden: [] }),
    })
    adapter.getSubGates = () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: true,
      clipboardGuard: false,
    })
    const result = await handleToolCall(adapter, 'screenshot', {}, makeOverrides())
    expect(result.isError).toBe(true)
    expect(result.telemetry?.error_kind).toBe('capture_failed')
    expect(result.screenshot).toBeUndefined()
  })

  test('zoom rejects empty output without applying the full-screen byte threshold', async () => {
    const empty = await handleToolCall(makeAdapter({
      zoom: async () => ({ base64: '', width: 0, height: 0 }),
    }), 'zoom', { region: [0, 0, 10, 10] }, makeOverrides())
    expect(empty.isError).toBe(true)

    const small = await handleToolCall(makeAdapter({
      zoom: async () => ({ base64: 'c21hbGw=', width: 10, height: 10 }),
    }), 'zoom', { region: [0, 0, 10, 10] }, makeOverrides())
    expect(small.isError).toBeUndefined()
    expect(small.content[0]).toMatchObject({ type: 'image', data: 'c21hbGw=' })
  })

  test('zoom receives the origin of the screenshot being inspected', async () => {
    let origin: { x: number; y: number } | undefined
    const result = await handleToolCall(makeAdapter({
      zoom: async (_region, _apps, _display, captureOrigin) => {
        origin = captureOrigin
        return { base64: validBase64, width: 50, height: 50 }
      },
    }), 'zoom', { region: [0, 0, 10, 10] }, makeOverrides({
      lastScreenshot: { ...shot(), originX: -100, originY: -50 },
    }))
    expect(result.isError).toBeUndefined()
    expect(origin).toEqual({ x: -100, y: -50 })
  })

  test('save_to_disk preserves the image and appends the returned path', async () => {
    let saved = ''
    const result = await handleToolCall(Object.assign(makeAdapter(), {
      saveImageToDisk: async (base64: string) => { saved = base64; return 'E:/tmp/cu-shot.jpg' },
    }), 'screenshot', { save_to_disk: true }, makeOverrides())

    expect(saved).toBe(validBase64)
    expect(result.screenshot).toBeDefined()
    expect(result.content.some(item => item.type === 'image')).toBe(true)
    expect(result.content.at(-1)).toEqual({ type: 'text', text: 'Screenshot saved to: E:/tmp/cu-shot.jpg' })
  })

  test('save failure and unavailable capability never stash a new screenshot', async () => {
    const failed = await handleToolCall(Object.assign(makeAdapter(), {
      saveImageToDisk: async () => { throw new Error('disk full') },
    }), 'screenshot', { save_to_disk: true }, makeOverrides())
    expect(failed.isError).toBe(true)
    expect(failed.screenshot).toBeUndefined()
    expect(failed.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('disk full') })

    const unavailable = await handleToolCall(makeAdapter(), 'zoom', {
      region: [0, 0, 10, 10], save_to_disk: true,
    }, makeOverrides())
    expect(unavailable.isError).toBe(true)
    expect(unavailable.telemetry?.error_kind).toBe('feature_unavailable')
  })

  test('invalid save flag fails before capture and false does not save', async () => {
    let captures = 0
    let saves = 0
    const adapter = Object.assign(makeAdapter({
      screenshot: async () => { captures++; return shot() },
    }), { saveImageToDisk: async () => { saves++; return 'unused.jpg' } })
    const invalid = await handleToolCall(adapter, 'screenshot', { save_to_disk: 'yes' }, makeOverrides())
    expect(invalid.telemetry?.error_kind).toBe('bad_args')
    expect(captures).toBe(0)

    const result = await handleToolCall(adapter, 'screenshot', { save_to_disk: false }, makeOverrides())
    expect(result.isError).toBeUndefined()
    expect(captures).toBe(1)
    expect(saves).toBe(0)
  })

  test('cursor outside a bound screenshot is not misreported as another monitor', async () => {
    const result = await handleToolCall(makeAdapter({
      getCursorPosition: async () => ({ x: 150, y: 25 }),
    }), 'cursor_position', {}, makeOverrides())
    expect(json(result)).toMatchObject({
      x: 150,
      y: 25,
      coordinateSpace: 'logical_points',
      note: expect.stringContaining('outside the last screenshot'),
    })
    expect(json(result).note).not.toContain('different monitor')
  })
})

describe('computer_batch failure and visual feedback', () => {
  test('an executor throw preserves completed, failed, remaining and monotonic progress', async () => {
    const progress: number[] = []
    const result = await handleToolCall(makeAdapter({
      key: async () => { throw new Error('foreground stolen') },
    }), 'computer_batch', {
      actions: [
        { action: 'cursor_position' },
        { action: 'key', text: 'a' },
        { action: 'cursor_position' },
      ],
    }, makeOverrides({ reportProgress: event => progress.push(event.progress) }))

    expect(result.isError).toBe(true)
    expect(json(result)).toMatchObject({
      completed: [{ action: 'cursor_position', ok: true }],
      failed: { action: 'key', ok: false },
      remaining: 1,
    })
    expect(json(result).failed.output).toContain('actions[1] (key) threw: foreground stolen')
    expect(result.telemetry?.error_kind).toBe('executor_threw')
    expect(progress).toEqual([1, 2])
  })

  test('mid-batch images are returned without rebasing later coordinates', async () => {
    const result = await handleToolCall(makeAdapter({
      screenshot: async () => shot(200, 200),
    }), 'computer_batch', {
      actions: [{ action: 'screenshot' }, { action: 'cursor_position' }],
    }, makeOverrides())

    expect(result.content.filter(item => item.type === 'image')).toHaveLength(1)
    expect(result.screenshot).toBeUndefined()
    const parsed = json(result)
    expect(parsed.completed).toHaveLength(2)
    expect(JSON.parse(parsed.completed[1].output)).toMatchObject({
      x: 25,
      y: 25,
      coordinateSpace: 'image_pixels',
    })
  })

  test('batch action results retain non-primary text such as saved paths', async () => {
    const adapter = Object.assign(makeAdapter(), {
      saveImageToDisk: async () => 'E:/tmp/batch-shot.jpg',
    })
    const result = await handleToolCall(adapter, 'computer_batch', {
      actions: [{ action: 'screenshot', save_to_disk: true }],
    }, makeOverrides())
    expect(json(result).completed[0].output).toContain('Screenshot saved to: E:/tmp/batch-shot.jpg')
    expect(result.content.some(item => item.type === 'image')).toBe(true)
  })

  test('images captured before a thrown action survive the failure result', async () => {
    const result = await handleToolCall(makeAdapter({
      key: async () => { throw new Error('boom') },
    }), 'computer_batch', {
      actions: [{ action: 'screenshot' }, { action: 'key', text: 'a' }],
    }, makeOverrides())

    expect(result.content.filter(item => item.type === 'image')).toHaveLength(1)
    expect(result.screenshot).toBeUndefined()
    expect(json(result).failed).toMatchObject({ ok: false, code: 'executor_threw' })
  })

  test('mouse cleanup failure is appended without erasing batch progress', async () => {
    const adapter = makeAdapter({
      key: async () => { throw new Error('original failure') },
      mouseUp: async () => { throw new Error('cleanup failure') },
    })
    await handleToolCall(adapter, 'left_mouse_down', {}, makeOverrides())
    const result = await handleToolCall(adapter, 'computer_batch', {
      actions: [{ action: 'key', text: 'a' }],
    }, makeOverrides())

    expect(json(result).failed.output).toContain('original failure')
    expect(json(result).failed.output).toContain('Mouse cleanup also failed: cleanup failure')
    expect(json(result).remaining).toBe(0)
  })

  test('all action arguments are validated before any side effect', async () => {
    let cursorCalls = 0
    const result = await handleToolCall(makeAdapter({
      getCursorPosition: async () => { cursorCalls++; return { x: 0, y: 0 } },
    }), 'computer_batch', {
      actions: [{ action: 'cursor_position' }, { action: 'left_click' }],
    }, makeOverrides())
    expect(result.isError).toBe(true)
    expect(result.telemetry?.error_kind).toBe('bad_args')
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('actions[1] coordinate is required') })
    expect(cursorCalls).toBe(0)
  })

  test('batch preflights system shortcuts, empty chords and unavailable saves before dispatch', async () => {
    const dispatched: string[] = []
    const adapter = makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      click: async () => { dispatched.push('click') },
      key: async () => { dispatched.push('key') },
      validateKeyChord: parts => { if (parts.includes('NoSuchKey')) throw new Error('Unsupported key') },
    })
    for (const [action, code] of [
      [{ action: 'key', text: 'win+r' }, 'grant_flag_required'],
      [{ action: 'hold_key', duration: 0, text: 'Shift+Ctrl+Esc+Alt' }, 'grant_flag_required'],
      [{ action: 'left_click', coordinate: [2, 2], text: 'ralt+f4' }, 'grant_flag_required'],
      [{ action: 'key', text: ' + ' }, 'bad_args'],
      [{ action: 'key', text: 'NoSuchKey' }, 'bad_args'],
      [{ action: 'screenshot', save_to_disk: true }, 'feature_unavailable'],
    ] as const) {
      const result = await handleToolCall(adapter, 'computer_batch', {
        actions: [{ action: 'left_click', coordinate: [1, 1] }, action],
      }, makeOverrides())
      expect(result.telemetry?.error_kind).toBe(code)
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('actions[1]') })
      expect(dispatched).toEqual([])
    }
  })

  test('batch size and text length limits fail before execution', async () => {
    const oversized = await handleToolCall(makeAdapter(), 'computer_batch', {
      actions: Array.from({ length: 101 }, () => ({ action: 'cursor_position' })),
    }, makeOverrides())
    expect(oversized.telemetry?.error_kind).toBe('bad_args')

    let types = 0
    const longText = await handleToolCall(makeAdapter({
      type: async () => { types++ },
    }), 'type', { text: 'x'.repeat(100_001) }, makeOverrides())
    expect(longText.telemetry?.error_kind).toBe('bad_args')
    expect(types).toBe(0)

    let captures = 0
    const tooManyImages = await handleToolCall(makeAdapter({
      screenshot: async () => { captures++; return shot() },
    }), 'computer_batch', {
      actions: Array.from({ length: 5 }, () => ({ action: 'screenshot' })),
    }, makeOverrides())
    expect(tooManyImages.telemetry?.error_kind).toBe('bad_args')
    expect(captures).toBe(0)
  })
})

describe('failure recovery and argument boundaries', () => {
  test('side-effect failures include inspect-before-retry guidance', async () => {
    const result = await handleToolCall(makeAdapter({
      click: async () => { throw new Error('native click failure') },
    }), 'left_click', { coordinate: [10, 10] }, makeOverrides())
    expect(result.isError).toBe(true)
    expect(result.telemetry?.error_kind).toBe('executor_threw')
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/native click failure.*Recovery:.*do not repeat it blindly.*Take a screenshot/),
    })
  })

  test('native cursor failures preserve diagnostics and batch recovery details', async () => {
    const failure = () => new ComputerUseActionError('[CU_INPUT_CURSOR] SetCursorPos failed before click (Win32 error 5).', 'native_input_failed', {
      phase: 'cursor_position', nativeApi: 'SetCursorPos', win32Error: 5,
      route: 'broker', clientIL: 'medium', targetIL: 'high',
    })
    const single = await handleToolCall(makeAdapter({
      click: async () => { throw failure() },
    }), 'left_click', { coordinate: [10, 10] }, makeOverrides())
    expect(single.structuredContent).toMatchObject({
      code: 'native_input_failed', phase: 'cursor_position', nativeApi: 'SetCursorPos',
      win32Error: 5, route: 'broker', clientIL: 'medium', targetIL: 'high',
    })
    const singleText = single.content[0]!.type === 'text' ? single.content[0]!.text : ''
    expect(singleText).toContain('open_application')
    expect(singleText).toContain('current action may be partial')
    expect(singleText).toContain('Do not repeat it blindly')

    for (const [name, args, method] of [
      ['double_click', { coordinate: [10, 10] }, 'click'],
      ['left_click_drag', { coordinate: [20, 20], start_coordinate: [10, 10] }, 'drag'],
    ] as const) {
      const partial = await handleToolCall(makeAdapter({
        [method]: async () => { throw failure() },
      }), name, args, makeOverrides())
      expect(partial.structuredContent).toMatchObject({ code: 'native_input_failed' })
      expect(partial.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('current action may be partial') })
    }

    const batch = await handleToolCall(makeAdapter({
      click: async () => { throw failure() },
    }), 'computer_batch', {
      actions: [{ action: 'left_click', coordinate: [10, 10] }, { action: 'key', text: 'a' }],
    }, makeOverrides())
    expect(json(batch).failed).toMatchObject({
      action: 'left_click', code: 'native_input_failed', phase: 'cursor_position',
      nativeApi: 'SetCursorPos', win32Error: 5, route: 'broker', clientIL: 'medium', targetIL: 'high',
    })
    expect(json(batch).remaining).toBe(1)

    const crossCopy = new Error('SetCursorPos failed in another package instance')
    crossCopy.name = 'ComputerUseActionError'
    Object.assign(crossCopy, {
      errorKind: 'native_input_failed',
      details: { phase: 'cursor_position', nativeApi: 'SetCursorPos', route: 'broker' },
    })
    const structural = await handleToolCall(makeAdapter({
      click: async () => { throw crossCopy },
    }), 'left_click', { coordinate: [10, 10] }, makeOverrides())
    expect(structural.structuredContent).toMatchObject({
      code: 'native_input_failed', phase: 'cursor_position', nativeApi: 'SetCursorPos', route: 'broker',
    })
  })

  test('non-finite coordinates fail before direct or batched side effects', async () => {
    let clicks = 0
    let cursorCalls = 0
    const adapter = makeAdapter({
      click: async () => { clicks++ },
      getCursorPosition: async () => { cursorCalls++; return { x: 0, y: 0 } },
    })
    for (const coordinate of [[NaN, 1], [Infinity, 1], [-Infinity, 1]]) {
      const result = await handleToolCall(adapter, 'left_click', { coordinate }, makeOverrides())
      expect(result.telemetry?.error_kind).toBe('bad_args')
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('finite non-negative') })
    }
    const batch = await handleToolCall(adapter, 'computer_batch', {
      actions: [{ action: 'cursor_position' }, { action: 'left_click', coordinate: [0, NaN] }],
    }, makeOverrides())
    expect(batch.telemetry?.error_kind).toBe('bad_args')
    const zoom = await handleToolCall(adapter, 'zoom', { region: [0, 0, Infinity, 10] }, makeOverrides())
    expect(zoom.telemetry?.error_kind).toBe('bad_args')
    expect(clicks).toBe(0)
    expect(cursorCalls).toBe(0)
  })

  test('batch interruption preserves completed actions, images and the exact recovery boundary', async () => {
    let abortAfterCursor = false
    let keys = 0
    const result = await handleToolCall(makeAdapter({
      getCursorPosition: async () => { abortAfterCursor = true; return { x: 25, y: 25 } },
      key: async () => { keys++ },
    }), 'computer_batch', {
      actions: [{ action: 'screenshot' }, { action: 'cursor_position' }, { action: 'key', text: 'a' }],
    }, makeOverrides({ isAborted: () => abortAfterCursor }))
    expect(result.isError).toBe(true)
    expect(result.content.filter(item => item.type === 'image')).toHaveLength(1)
    expect(json(result).completed).toHaveLength(2)
    expect(json(result)).toMatchObject({
      aborted: { action: 'key', index: 2, ok: false },
      remaining: 1,
    })
    expect(json(result).aborted.output).toContain('were not dispatched')
    expect(json(result).recovery).toContain('Do not replay the whole batch')
    expect(keys).toBe(0)
  })

  test('cancellation during the inter-action settle is aborted before the next dispatch', async () => {
    let checks = 0
    let keys = 0
    const result = await handleToolCall(makeAdapter({
      key: async () => { keys++ },
    }), 'computer_batch', {
      actions: [{ action: 'cursor_position' }, { action: 'key', text: 'a' }],
    }, makeOverrides({ isAborted: () => ++checks >= 4 }))
    expect(json(result)).toMatchObject({
      completed: [{ action: 'cursor_position', ok: true }],
      aborted: { action: 'key', index: 1 },
      remaining: 1,
    })
    expect(json(result).failed).toBeUndefined()
    expect(keys).toBe(0)
  })

  test('an abort raised by the pre-input gate is not mislabeled as an attempted failure', async () => {
    let aborted = false
    let clicks = 0
    const result = await handleToolCall(makeAdapter({
      getFrontmostApp: async () => {
        aborted = true
        return { bundleId: 'app.test', displayName: 'Test App' }
      },
      click: async () => { clicks++ },
    }), 'computer_batch', {
      actions: [{ action: 'left_click', coordinate: [10, 10] }, { action: 'cursor_position' }],
    }, makeOverrides({ isAborted: () => aborted }))
    expect(json(result)).toMatchObject({
      completed: [],
      aborted: { action: 'left_click', index: 0 },
      remaining: 2,
    })
    expect(json(result).failed).toBeUndefined()
    expect(result.telemetry?.error_kind).toBeUndefined()
    expect(clicks).toBe(0)
  })

  test('an executor AbortError after dispatch remains an outcome-unknown failure', async () => {
    let aborted = false
    const result = await handleToolCall(makeAdapter({
      click: async () => {
        aborted = true
        throw new DOMException('native interruption', 'AbortError')
      },
    }), 'computer_batch', {
      actions: [{ action: 'left_click', coordinate: [10, 10] }, { action: 'cursor_position' }],
    }, makeOverrides({ isAborted: () => aborted }))
    expect(json(result)).toMatchObject({
      failed: { action: 'left_click', ok: false },
      remaining: 1,
    })
    expect(json(result).aborted).toBeUndefined()
    expect(result.telemetry?.error_kind).toBe('executor_threw')
  })

  test('cancellation after a grapheme was delivered stays a partial failure', async () => {
    let aborted = false
    let types = 0
    const result = await handleToolCall(makeAdapter({
      type: async () => { types++; aborted = true },
    }), 'computer_batch', {
      actions: [{ action: 'type', text: 'ab' }, { action: 'cursor_position' }],
    }, makeOverrides({ isAborted: () => aborted }))
    expect(json(result)).toMatchObject({
      failed: { action: 'type', ok: false },
      remaining: 1,
    })
    expect(json(result).aborted).toBeUndefined()
    expect(types).toBe(1)
  })

  test('cancellation after capture cannot claim that no capture happened', async () => {
    let aborted = false
    const result = await handleToolCall(makeAdapter({
      screenshot: async () => { aborted = true; return shot() },
    }), 'computer_batch', {
      actions: [{ action: 'screenshot' }, { action: 'cursor_position' }],
    }, makeOverrides({ isAborted: () => aborted }))
    expect(json(result)).toMatchObject({
      failed: { action: 'screenshot', ok: false },
      remaining: 1,
    })
    expect(json(result).aborted).toBeUndefined()
    expect(result.content.filter(item => item.type === 'image')).toHaveLength(0)
  })

  test('aborted cleanup failure has distinct recovery guidance', async () => {
    let checks = 0
    const adapter = makeAdapter({ mouseUp: async () => { throw new Error('release failed') } })
    await handleToolCall(adapter, 'left_mouse_down', {}, makeOverrides())
    const result = await handleToolCall(adapter, 'computer_batch', {
      actions: [{ action: 'cursor_position' }],
    }, makeOverrides({ isAborted: () => ++checks >= 2 }))
    expect(json(result).aborted.output).toContain('Mouse cleanup also failed: release failed')
    expect(json(result).recovery).toContain('cancelled before the aborted action was dispatched')
    expect(json(result).recovery).toContain('check that no mouse button remains held')
  })

  test('open_application recovery never blindly repeats an uncertain launch', async () => {
    const result = await handleToolCall(makeAdapter({
      openApp: async () => { throw new Error('window wait timed out') },
    }), 'open_application', { app: 'Test App' }, makeOverrides())
    expect(result.isError).toBe(true)
    const block = result.content[0]!
    const text = block.type === 'text' ? block.text : ''
    expect(text).toContain('may already have started')
    expect(text).toContain('Do not blindly relaunch')
    expect(text).not.toContain('Retry open_application once')
  })

  test('open_application timeout reconciles only a verified binding', async () => {
    const adapter = makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      openApp: async () => { throw new Error('PowerShell timed out: no diagnostic output') },
      getBoundAppId: () => 'app.test',
      getBoundWindowState: () => ({ hwnd: 42, foreground: false, minimized: false, requiresForeground: true }),
    })
    const result = await handleToolCall(adapter, 'open_application', { app: 'app.test' }, makeOverrides())
    expect(result.structuredContent).toMatchObject({
      code: 'state_conflict', phase: 'open_outcome_unconfirmed', hwnd: 42,
    })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('do not relaunch') })

    const unbound = await handleToolCall(makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      openApp: async () => { throw new Error('PowerShell timed out: no diagnostic output') },
    }), 'open_application', { app: 'Test App' }, makeOverrides())
    expect(unbound.telemetry?.error_kind).toBe('executor_threw')
  })
})

describe('pixel-validation host fallback', () => {
  test('aborting a clipboard read does not stash an empty sentinel', async () => {
    let aborted = false
    let releaseRead: ((value: string) => void) | undefined
    let stash: string | undefined
    let clears = 0
    const adapter = makeAdapter({
      readClipboard: () => new Promise(resolve => { releaseRead = resolve }),
      writeClipboard: async text => { if (text === '') clears++ },
    })
    adapter.getSubGates = () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: true,
    })
    const pending = handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, makeOverrides({
      isAborted: () => aborted,
      allowedApps: [{ bundleId: 'app.test', displayName: 'Test App', grantedAt: 1, tier: 'click' }],
      getClipboardStash: () => stash,
      onClipboardStashChanged: value => { stash = value },
    }))
    for (let i = 0; i < 100 && !releaseRead; i++) await new Promise(resolve => setTimeout(resolve, 1))
    aborted = true
    releaseRead!('original')
    const result = await pending
    expect(result.isError).toBe(true)
    expect(stash).toBeUndefined()
    expect(clears).toBe(0)
  })

  test('mouse-up cleanup still runs when its gate aborts', async () => {
    let releases = 0
    let preparations = 0
    const adapter = makeAdapter({
      mouseUp: async () => { releases++ },
      prepareForTarget: async () => { preparations++ },
    })
    await handleToolCall(adapter, 'left_mouse_down', {}, makeOverrides())
    const result = await handleToolCall(adapter, 'left_mouse_up', {}, makeOverrides({ isAborted: () => true }))
    expect(result.isError).toBe(true)
    expect(releases).toBe(1)
    expect(preparations).toBe(1)
  })

  test('aborting during the first grapheme delay prevents any text input', async () => {
    let aborted = false
    let types = 0
    const adapter = makeAdapter({ type: async () => { types++ } })
    const timer = setTimeout(() => { aborted = true }, 1)
    const result = await handleToolCall(adapter, 'type', { text: 'a' }, makeOverrides({
      isAborted: () => aborted,
    }))
    clearTimeout(timer)
    expect(result.isError).toBe(true)
    expect(types).toBe(0)
    expect(aborted).toBe(true)
  })

  test('aborting after a deferred gate prevents the eventual click', async () => {
    let aborted = false
    let releaseGate: ((value: { bundleId: string; displayName: string }) => void) | undefined
    let clicks = 0
    let clipboardWrites = 0
    const adapter = makeAdapter({
      getFrontmostApp: () => new Promise(resolve => { releaseGate = resolve }),
      click: async () => { clicks++ },
      writeClipboard: async () => { clipboardWrites++ },
    })
    adapter.getSubGates = () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: true,
    })
    const pending = handleToolCall(adapter, 'left_click', {
      coordinate: [10, 10],
    }, makeOverrides({
      isAborted: () => aborted,
      allowedApps: [{ bundleId: 'app.test', displayName: 'Test App', grantedAt: 1, tier: 'click' }],
    }))
    for (let i = 0; i < 100 && !releaseGate; i++) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    aborted = true
    releaseGate!({ bundleId: 'app.test', displayName: 'Test App' })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('aborted before new side effects') })
    expect(clicks).toBe(0)
    expect(clipboardWrites).toBe(0)
  })

  test('unavailable crop skips validation and allows the click', async () => {
    let clicks = 0
    const adapter = makeAdapter({ click: async () => { clicks++ } })
    adapter.getSubGates = () => ({
      pixelValidation: true,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    })
    const result = await handleToolCall(adapter, 'left_click', {
      coordinate: [10, 10],
    }, makeOverrides())
    expect(result.isError).toBeUndefined()
    expect(clicks).toBe(1)
  })

  test('a changed click target is an explicit error and never reports success', async () => {
    let clicks = 0
    const adapter = makeAdapter({
      click: async () => { clicks++ },
      screenshot: async () => ({ ...shot(), base64: Buffer.alloc(2048, 8).toString('base64') }),
    })
    adapter.cropRawPatch = base64 => Buffer.from(base64 === validBase64 ? 'old' : 'new')
    adapter.getSubGates = () => ({
      pixelValidation: true,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    })
    const result = await handleToolCall(adapter, 'left_click', {
      coordinate: [10, 10],
    }, makeOverrides())
    expect(result.isError).toBe(true)
    expect(result.telemetry?.error_kind).toBe('state_conflict')
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('The click was not dispatched') })
    expect(clicks).toBe(0)
  })
})

describe('Windows effective-target permission gates', () => {
  function windowsAdapter(tier: 'read' | 'click' | 'full', frontmost: any = { bundleId: 'app.test', displayName: 'Test App' }) {
    return makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      getFrontmostApp: async () => frontmost,
    })
  }
  const grants = (tier: 'read' | 'click' | 'full') => makeOverrides({
    allowedApps: [{ bundleId: 'app.test', displayName: 'Test App', grantedAt: 1, tier }],
  })

  test('read tier rejects both mouse and keyboard before executor calls', async () => {
    let actions = 0
    const adapter = windowsAdapter('read')
    adapter.executor.click = async () => { actions++ }
    adapter.executor.type = async () => { actions++ }
    const click = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, grants('read'))
    const type = await handleToolCall(adapter, 'type', { text: 'x' }, grants('read'))
    expect(click.telemetry?.error_kind).toBe('tier_insufficient')
    expect(type.telemetry?.error_kind).toBe('tier_insufficient')
    expect(actions).toBe(0)
  })

  test('click tier allows plain left click but rejects keyboard and preserves clipboardGuard', async () => {
    let clicks = 0
    const clipboardWrites: string[] = []
    const adapter = windowsAdapter('click')
    adapter.executor.click = async () => { clicks++ }
    adapter.executor.readClipboard = async () => 'user-text'
    adapter.executor.writeClipboard = async text => { clipboardWrites.push(text) }
    let stash: string | undefined
    const guarded = makeOverrides({
      allowedApps: [{ bundleId: 'app.test', displayName: 'Test App', grantedAt: 1, tier: 'click' as const }],
      getClipboardStash: () => stash,
      onClipboardStashChanged: value => { stash = value },
    })
    adapter.getSubGates = () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: true,
    })
    const click = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, guarded)
    const type = await handleToolCall(adapter, 'type', { text: 'x' }, guarded)
    expect(click.isError).toBeUndefined()
    expect(type.telemetry?.error_kind).toBe('tier_insufficient')
    expect(clicks).toBe(1)
    expect(clipboardWrites).toContain('')
    expect(stash).toBe('user-text')

    await handleToolCall(adapter, 'type', { text: 'x' }, {
      ...guarded,
      allowedApps: [{ bundleId: 'app.test', displayName: 'Test App', grantedAt: 1, tier: 'full' as const }],
    })
    expect(clipboardWrites).toContain('user-text')
    expect(stash).toBeUndefined()
  })

  test('clipboardGuard fails closed instead of clearing without stash callbacks', async () => {
    let writes = 0
    let clicks = 0
    const adapter = windowsAdapter('click')
    adapter.executor.writeClipboard = async () => { writes++ }
    adapter.executor.click = async () => { clicks++ }
    adapter.getSubGates = () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: true,
    })
    const result = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, grants('click'))
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('refusing to clear the clipboard') })
    expect(writes).toBe(0)
    expect(clicks).toBe(0)
  })

  test('clipboard read failure leaves the original contents untouched', async () => {
    let writes = 0
    let stash: string | undefined
    const adapter = windowsAdapter('click')
    adapter.executor.readClipboard = async () => { throw new Error('read denied') }
    adapter.executor.writeClipboard = async () => { writes++ }
    adapter.getSubGates = () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: true,
    })
    const result = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, makeOverrides({
      allowedApps: [{ bundleId: 'app.test', displayName: 'Test App', grantedAt: 1, tier: 'click' }],
      getClipboardStash: () => stash,
      onClipboardStashChanged: value => { stash = value },
    }))
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('left unchanged') })
    expect(stash).toBeUndefined()
    expect(writes).toBe(0)
  })

  test('full tier permits keyboard and system combos still require their flag', async () => {
    const adapter = windowsAdapter('full')
    const allowed = await handleToolCall(adapter, 'type', { text: 'x' }, grants('full'))
    expect(allowed.isError).toBeUndefined()
    const combo = await handleToolCall(adapter, 'key', { text: 'alt+tab' }, grants('full'))
    expect(combo.telemetry?.error_kind).toBe('grant_flag_required')
  })

  test('only authorized Windows input prepares the elevated target with the request signal', async () => {
    let preparations = 0
    const requestSignal = new AbortController().signal
    const adapter = windowsAdapter('full')
    adapter.executor.prepareForTarget = async signal => {
      expect(signal).toBe(requestSignal)
      preparations++
    }
    const denied = await handleToolCall(adapter, 'type', { text: 'x' }, grants('read'))
    expect(denied.telemetry?.error_kind).toBe('tier_insufficient')
    expect(preparations).toBe(0)
    const allowed = await handleToolCall(adapter, 'type', { text: 'x' }, { ...grants('full'), requestSignal })
    expect(allowed.isError).toBeUndefined()
    expect(preparations).toBe(1)
  })

  test('Windows rejects an ungranted hit target and a foreground change during preparation', async () => {
    let actions = 0
    const hitAdapter = windowsAdapter('full')
    hitAdapter.executor.appUnderPoint = async () => ({ bundleId: 'other.app', displayName: 'Other' })
    hitAdapter.executor.click = async () => { actions++ }
    const hit = await handleToolCall(hitAdapter, 'left_click', { coordinate: [1, 1] }, grants('full'))
    expect(hit.telemetry?.error_kind).toBe('app_not_granted')

    const switchAdapter = windowsAdapter('full')
    switchAdapter.executor.prepareForTarget = async () => {
      switchAdapter.executor.getFrontmostApp = async () => ({ bundleId: 'other.app', displayName: 'Other' })
    }
    switchAdapter.executor.type = async () => { actions++ }
    const switched = await handleToolCall(switchAdapter, 'type', { text: 'x' }, grants('full'))
    expect(switched.telemetry?.error_kind).toBe('app_not_granted')

    const unknownAdapter = windowsAdapter('full')
    unknownAdapter.executor.appUnderPoint = async () => null
    unknownAdapter.executor.click = async () => { actions++ }
    const unknown = await handleToolCall(unknownAdapter, 'left_click', { coordinate: [1, 1] }, grants('full'))
    expect(unknown.telemetry?.error_kind).toBe('state_conflict')

    const errorAdapter = windowsAdapter('full')
    errorAdapter.executor.appUnderPoint = async () => { throw new Error('hit-test unavailable') }
    errorAdapter.executor.click = async () => { actions++ }
    const failed = await handleToolCall(errorAdapter, 'left_click', { coordinate: [1, 1] }, grants('full'))
    expect(failed.isError).toBe(true)
    expect(actions).toBe(0)
  })

  test('a desktop click uses the authorized hit PID rather than the foreground PID', async () => {
    const adapter = windowsAdapter('full', { bundleId: 'app.test', displayName: 'Test App', pid: 20 });
    const events: Array<string | number | undefined> = [];
    adapter.executor.prepareForTarget = async (_signal, purpose, authorizedPid) => { events.push(authorizedPid ?? purpose) };
    adapter.executor.appUnderPoint = async () => ({ bundleId: 'other.app', displayName: 'Other', pid: 30 });
    adapter.executor.click = async (_x, _y, _button, _count, _modifiers, _foreground, authorizedPid) => { events.push(authorizedPid) };
    const denied = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, grants('full'));
    expect(denied.telemetry?.error_kind).toBe('app_not_granted');
    expect(events).toEqual(['click']);
    const allowed = grants('full');
    allowed.allowedApps.push({ bundleId: 'other.app', displayName: 'Other', grantedAt: 1, tier: 'click' });
    expect((await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, allowed)).isError).toBeUndefined();
    expect(events).toEqual(['click', 'click', 30, 30]);
  })

  test('Windows rechecks the UAC desktop guard after preparing the approved pointer target', async () => {
    const adapter = windowsAdapter('full');
    const events: string[] = [];
    adapter.executor.appUnderPoint = async () => ({ bundleId: 'app.test', displayName: 'Test App', pid: 30 });
    adapter.executor.prepareForTarget = async (_signal, _purpose, authorizedPid) => {
      if (authorizedPid) events.push('elevation prepared');
    };
    adapter.executor.click = async () => { events.push('clicked') };
    const result = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, {
      ...grants('full'),
      beforeAction: async () => {
        events.push('checked desktop');
        if (events.includes('elevation prepared')) throw new Error('Take a fresh screenshot after UAC.');
      },
    });
    expect(result.isError).toBeTrue();
    expect(JSON.stringify(result.content)).toContain('after UAC');
    expect(events).toEqual(['checked desktop', 'elevation prepared', 'checked desktop']);
  })

  test('an embedded target uses its authorized host without process-name special cases', async () => {
    let clicks = 0
    const adapter = windowsAdapter('full')
    adapter.executor.appUnderPoint = async () => ({
      bundleId: 'renderer-helper.exe',
      displayName: 'renderer-helper',
      hostBundleId: 'app.test',
      hostDisplayName: 'Test App',
      hostTrusted: true,
    })
    adapter.executor.click = async () => { clicks++ }
    const allowed = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, grants('full'))
    expect(allowed.isError).toBeUndefined()
    expect(clicks).toBe(1)

    const upgraded = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, makeOverrides({
      allowedApps: [
        { bundleId: 'app.test', displayName: 'Test App', grantedAt: 1, tier: 'full' },
        { bundleId: 'renderer-helper.exe', displayName: 'renderer-helper', grantedAt: 1, tier: 'read' },
      ],
    }))
    expect(upgraded.isError).toBeUndefined()
    expect(clicks).toBe(2)

    const denied = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, makeOverrides({
      allowedApps: [
        { bundleId: 'app.test', displayName: 'Test App', grantedAt: 1, tier: 'full' },
        { bundleId: 'renderer-helper.exe', displayName: 'renderer-helper', grantedAt: 1, tier: 'read' },
      ],
      userDeniedBundleIds: ['renderer-helper.exe'],
    }))
    expect(denied.telemetry?.error_kind).toBe('app_not_granted')
    expect(clicks).toBe(2)

    adapter.executor.appUnderPoint = async () => ({
      bundleId: 'renderer-helper.exe',
      displayName: 'renderer-helper',
      hostBundleId: 'app.test',
      hostDisplayName: 'Test App',
      hostTrusted: false,
    })
    const untrusted = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, grants('full'))
    expect(untrusted.telemetry?.error_kind).toBe('app_not_granted')
    expect(clicks).toBe(2)
  })

  test('policy denial wins through actual and host installation aliases', async () => {
    let clicks = 0
    const adapter = windowsAdapter('full')
    adapter.executor.click = async () => { clicks++ }
    adapter.executor.appUnderPoint = async () => ({
      bundleId: 'renderer-helper.exe',
      displayName: 'renderer-helper',
      hostBundleId: 'app.test',
      hostDisplayName: 'Test App',
      hostTrusted: true,
    })
    adapter.executor.listInstalledApps = async () => [{
      bundleId: 'installed-renderer', path: 'renderer-helper.exe', displayName: 'Netflix',
    }]
    const actualDenied = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, grants('full'))
    expect(actualDenied.telemetry?.error_kind).toBe('app_not_granted')

    adapter.executor.listInstalledApps = async () => [{
      bundleId: 'installed-host', path: 'app.test', displayName: 'Netflix',
    }]
    const hostDenied = await handleToolCall(adapter, 'left_click', { coordinate: [1, 1] }, grants('full'))
    expect(hostDenied.telemetry?.error_kind).toBe('app_not_granted')
    expect(clicks).toBe(0)
  })

  test('open_application accepts an exact granted Windows executable path', async () => {
    const exePath = 'E:\\Plants Vs Zombies Food Version\\game\\植物大战僵尸食物版\\PlantsVsZombiesFood.exe'
    let opened = ''
    const result = await handleToolCall(makeAdapter({
      openApp: async bundleId => { opened = bundleId },
    }), 'open_application', { app: exePath }, makeOverrides({
      allowedApps: [{ bundleId: exePath, displayName: 'PlantsVsZombiesFood', grantedAt: 1, tier: 'full' }],
    }))
    expect(result.isError).toBeUndefined()
    expect(opened).toBe(exePath)
  })

  test('open_application accepts Windows path separator and case variants', async () => {
    const exePath = 'E:\\Plants Vs Zombies Food Version\\game\\植物大战僵尸食物版\\PlantsVsZombiesFood.exe'
    let opened = ''
    const result = await handleToolCall(makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      openApp: async bundleId => { opened = bundleId },
    }), 'open_application', { app: exePath.replace(/\\/g, '/').toUpperCase() }, makeOverrides({
      allowedApps: [{ bundleId: exePath, displayName: 'PlantsVsZombiesFood', grantedAt: 1, tier: 'full' }],
    }))
    expect(result.isError).toBeUndefined()
    expect(opened).toBe(exePath)
  })

  test('window discovery exposes only exact granted executable titles and supports selection', async () => {
    const grantedExe = 'E:/fixture/visible.exe'
    const otherExe = 'E:/other/visible.exe'
    const adapter = windowsAdapter('full')
    let enumerations = 0
    let opaqueSelection: string | undefined
    adapter.executor.listWindows = async () => {
      enumerations++
      const status = { className: 'Fixture', visible: true, minimized: false, foreground: true, dpiAwareness: 2, il: 'medium' }
      return [
        { ...status, hwnd: 10, pid: 20, bundleId: grantedExe.toUpperCase(), windowId: '10:20', title: 'Visible document' },
        { ...status, hwnd: 30, pid: 40, bundleId: otherExe, windowId: '30:40', title: 'Private document' },
      ]
    }
    adapter.executor.openApp = async (_bundleId, _signal, windowId) => { opaqueSelection = windowId }
    const overrides = makeOverrides({
      allowedApps: [{ bundleId: grantedExe, displayName: 'Fixture', grantedAt: 1, tier: 'read' }],
    })
    const tools = buildComputerUseTools(adapter.executor.capabilities, 'pixels')
    expect(tools.find(tool => tool.name === 'list_granted_applications')?.inputSchema.properties).toHaveProperty('include_windows')
    expect(tools.find(tool => tool.name === 'open_application')?.inputSchema.properties).toHaveProperty('window_id')
    expect(tools).toHaveLength(28)
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['list_windows', 'get_window', 'activate_window', 'minimize_window']))
    expect(tools.map(tool => tool.name)).not.toContain('desktop_info')

    const summary = await handleToolCall(adapter, 'list_granted_applications', {}, overrides)
    expect(json(summary)).toMatchObject({ coordinateMode: 'pixels' })
    expect(enumerations).toBe(0)
    const found = await handleToolCall(adapter, 'list_granted_applications', { include_windows: true }, overrides)
    expect(json(found).windows).toEqual([{ windowId: '10:20', title: 'Visible document', app: grantedExe, tier: 'read' }])
    const selected = await handleToolCall(adapter, 'open_application', { app: grantedExe, window_id: '10:20' }, overrides)
    expect(selected.isError).toBeUndefined()
    expect(opaqueSelection).toBe('10:20')

    const list = await handleToolCall(adapter, 'list_windows', { visible_only: false, limit: 1, granted_only: false }, overrides)
    expect(json(list)).toMatchObject({ count: 1, ungrantedCount: 1, windows: [{ hwnd: 10, il: 'medium', dpi_awareness: 'per_monitor', tier: 'read' }] })
    expect(JSON.stringify(list)).not.toContain('Private document')
    const detail = await handleToolCall(adapter, 'get_window', { hwnd: 10 }, overrides)
    expect(json(detail)).toMatchObject({ hwnd: 10, rootHwnd: 10, foreground: true, minimized: false })
    const deniedDetail = await handleToolCall(adapter, 'get_window', { hwnd: 30 }, overrides)
    expect(deniedDetail.structuredContent).toMatchObject({ code: 'app_not_granted', hwnd: 30 })
    expect(JSON.stringify(deniedDetail)).not.toContain(otherExe)
    let activatedHwnd = 0
    adapter.executor.activateWindow = async window => { activatedHwnd = window.hwnd; return true }
    const activation = await handleToolCall(adapter, 'activate_window', { hwnd: 10 }, overrides)
    expect(json(activation)).toMatchObject({ activated: true, hwnd: 10 })
    expect(activatedHwnd).toBe(10)
    const minimizeCalls: string[] = []
    adapter.executor.minimizeWindow = async window => { minimizeCalls.push(window.windowId); return true }
    adapter.executor.minimizeAllWindows = async () => { minimizeCalls.push('all'); return { requested: 2, minimized: 2, remaining: 0, closed: 0 } }
    adapter.executor.getBoundWindowState = () => ({ hwnd: 10, foreground: true, minimized: false, requiresForeground: false })
    expect((await handleToolCall(adapter, 'minimize_window', {}, overrides)).telemetry?.error_kind).toBe('app_not_granted')
    const clickGrant = { ...overrides, allowedApps: [{ ...overrides.allowedApps[0]!, tier: 'click' as const }] }
    expect((await handleToolCall(adapter, 'minimize_window', { window_id: '30:40' }, clickGrant)).telemetry?.error_kind).toBe('app_not_granted')
    expect((await handleToolCall(adapter, 'minimize_window', { all: true }, clickGrant)).telemetry?.error_kind).toBe('grant_flag_required')
    expect(json(await handleToolCall(adapter, 'minimize_window', {}, clickGrant))).toMatchObject({ minimized: true, windowId: '10:20' })
    const desktopGrant = { ...clickGrant, grantFlags: { ...clickGrant.grantFlags, systemKeyCombos: true } }
    expect(json(await handleToolCall(adapter, 'minimize_window', { all: true }, desktopGrant))).toMatchObject({ minimized: 2, remaining: 0, scope: 'desktop' })
    expect(minimizeCalls).toEqual(['10:20', 'all'])
    const diagnostics = await handleToolCall(adapter, 'list_granted_applications', { include_desktop: true }, { ...overrides, screenshotAgeMs: 25 })
    expect(json(diagnostics).desktop_info).toMatchObject({ anchorAgeMs: 25, limits: { batchActions: 100, typeCodeUnits: 100_000 } })
    expect(json(diagnostics).desktop_info.displays[0]).toEqual({ displayId: 0, label: 'display 0', isPrimary: false })

    adapter.executor.listInstalledApps = async () => [{ bundleId: 'alias', path: grantedExe, displayName: 'Fixture' }]
    const deniedOverrides = { ...overrides, userDeniedBundleIds: ['alias'] }
    const denied = await handleToolCall(adapter, 'list_granted_applications', { include_windows: true }, deniedOverrides)
    expect(json(denied).windows).toEqual([])
    expect((await handleToolCall(adapter, 'open_application', { app: grantedExe, window_id: '10:20' }, deniedOverrides)).telemetry?.error_kind).toBe('app_not_granted')
    expect((await handleToolCall(adapter, 'minimize_window', {}, { ...clickGrant, userDeniedBundleIds: ['alias'] })).telemetry?.error_kind).toBe('app_not_granted')
  })

  test('desktop diagnostics separate the current mode from the last image', async () => {
    const adapter = windowsAdapter('full')
    adapter.executor.isWindowBound = () => false
    adapter.executor.getBindingRelease = () => ({
      reason: 'new_foreground',
      at: 100,
      revision: 2,
      appId: 'app.test',
      pid: 20,
      hwnd: 10,
      foreground: null,
    })
    const result = await handleToolCall(adapter, 'list_granted_applications', { include_desktop: true }, makeOverrides({
      lastScreenshot: { ...shot(), captureMode: 'bound_window' },
      screenshotAgeMs: 25,
    }))
    expect(json(result).desktop_info).toMatchObject({
      captureMode: 'full_display',
      anchorAgeMs: 25,
      lastScreenshot: { captureMode: 'bound_window', ageMs: 25 },
      lastBindingRelease: { reason: 'new_foreground', revision: 2 },
    })
  })

  test('unknown and non-granted targets fail closed on Windows', async () => {
    const unknown = await handleToolCall(windowsAdapter('full', null), 'type', { text: 'x' }, grants('full'))
    expect(unknown.telemetry?.error_kind).toBe('state_conflict')
    const other = await handleToolCall(windowsAdapter('full', { bundleId: 'other.app', displayName: 'Other' }), 'left_click', { coordinate: [1, 1] }, grants('full'))
    expect(other.telemetry?.error_kind).toBe('app_not_granted')
  })

  test('Windows text uses whole runs with real control keys and partial-run failure context', async () => {
    const textRuns: string[] = []
    const keys: string[] = []
    const adapter = windowsAdapter('full')
    adapter.executor.type = async text => { textRuns.push(text) }
    adapter.executor.key = async key => { keys.push(key) }
    const result = await handleToolCall(adapter, 'type', { text: 'ab\n中😀\tZ' }, grants('full'))
    expect(result.isError).toBeUndefined()
    expect(textRuns).toEqual(['ab', '中😀', 'Z'])
    expect(keys).toEqual(['return', 'tab'])
  })

  test('Windows run failure reports fully dispatched progress and does not continue', async () => {
    const textRuns: string[] = []
    const adapter = windowsAdapter('full')
    adapter.executor.type = async text => { textRuns.push(text) }
    adapter.executor.key = async () => { throw new Error('focus lost') }
    const result = await handleToolCall(adapter, 'type', { text: 'ab\n中' }, grants('full'))
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('after 2 fully dispatched of 4 graphemes'),
    })
    expect(textRuns).toEqual(['ab'])
  })
})

describe('request_access denial feedback', () => {
  const installed = [{ bundleId: 'app.test', displayName: 'Test App', path: '/test' }]

  test('shortcut approval uses the executable identity even when the responder leaves the tier unset', async () => {
    const chrome = 'E:\\portable\\chrome.exe';
    const spotify = 'E:\\portable\\spotify.exe';
    const adapter = makeAdapter({
      capabilities: { platform: 'win32', screenshotFiltering: 'none' },
      resolveDesktopApp: async reference => {
        const target = reference.includes('First') ? chrome : spotify;
        return { bundleId: target, displayName: 'Unrelated label', path: target };
      },
    });
    const result = await handleToolCall(adapter, 'request_access', {
      apps: ['Desktop\\First.lnk', 'Desktop\\Second.lnk'], reason: 'test shortcuts',
    }, makeOverrides({ allowedApps: [], onPermissionRequest: async request => ({
      granted: request.apps.map(({ resolved }) => ({ bundleId: resolved!.bundleId, displayName: resolved!.displayName, grantedAt: 1 })),
      denied: [], flags: { ...DEFAULT_GRANT_FLAGS },
    }) }));
    const payload = json(result);
    expect(payload.granted).toEqual([{ bundleId: chrome, displayName: 'chrome.exe', grantedAt: 1 }]);
    expect(payload.policyDenied.apps).toMatchObject([{ requestedName: 'Desktop\\Second.lnk' }]);
    adapter.executor.getFrontmostApp = async () => ({ bundleId: chrome, displayName: 'chrome.exe' });
    const click = await handleToolCall(adapter, 'left_click', { coordinate: [20, 30] }, makeOverrides({ allowedApps: payload.granted }));
    expect(click.telemetry?.error_kind).toBe('tier_insufficient');
  })

  test('multiple aliases for one resolved application are granted only once', async () => {
    let requested = 0
    const result = await handleToolCall(makeAdapter({
      listInstalledApps: async () => installed,
    }), 'request_access', { apps: ['Test App', 'app.test'], reason: 'test' }, makeOverrides({
      allowedApps: [],
      onPermissionRequest: async request => {
        requested = request.apps.length
        return {
          granted: request.apps.map(app => ({
            bundleId: app.resolved!.bundleId,
            displayName: app.resolved!.displayName,
            grantedAt: 1,
            tier: 'full' as const,
          })),
          denied: [],
          flags: { ...DEFAULT_GRANT_FLAGS },
          userConsented: true,
        }
      },
    }))
    expect(requested).toBe(1)
    expect(json(result).granted).toHaveLength(1)
  })

  test('restricted-tier aliases also dedupe guidance and telemetry', async () => {
    const result = await handleToolCall(makeAdapter({
      listInstalledApps: async () => [{ bundleId: 'com.microsoft.VSCode', displayName: 'Visual Studio Code', path: '/code' }],
    }), 'request_access', { apps: ['Visual Studio Code', 'com.microsoft.VSCode'], reason: 'test' }, makeOverrides({
      allowedApps: [],
      onPermissionRequest: async request => ({
        granted: request.apps.map(app => ({
          bundleId: app.resolved!.bundleId,
          displayName: app.resolved!.displayName,
          grantedAt: 1,
          tier: 'click' as const,
        })),
        denied: [],
        flags: { ...DEFAULT_GRANT_FLAGS },
        userConsented: true,
      }),
    }))
    const payload = json(result)
    expect(payload.granted).toHaveLength(1)
    expect(payload.tierGuidance.match(/Visual Studio Code/g)).toHaveLength(1)
    expect(result.telemetry?.denied_terminal_count).toBe(1)
  })

  test('an explicit user denial includes guidance not to repeat the dialog', async () => {
    const result = await handleToolCall(makeAdapter({
      listInstalledApps: async () => installed,
    }), 'request_access', { apps: ['Test App'], reason: 'test' }, makeOverrides({
      allowedApps: [],
      onPermissionRequest: async () => ({
        granted: [], denied: [], flags: { ...DEFAULT_GRANT_FLAGS }, userConsented: false,
      }),
    }))
    expect(result.isError).toBeUndefined()
    expect(json(result)).toMatchObject({ userConsented: false })
    expect(json(result).guidance).toContain('Do not show the same permission dialog again')
  })

  test('missing interactive permission UI is an explicit feature-unavailable error', async () => {
    const result = await handleToolCall(makeAdapter({
      listInstalledApps: async () => installed,
    }), 'request_access', { apps: ['Test App'], reason: 'test' }, makeOverrides({
      allowedApps: [],
      onPermissionRequest: async () => ({
        granted: [], denied: [], flags: { ...DEFAULT_GRANT_FLAGS },
        userConsented: false, permissionUIUnavailable: true,
      }),
    }))
    expect(result.isError).toBe(true)
    expect(result.telemetry?.error_kind).toBe('feature_unavailable')
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('not available in this session') })
  })

  test('TCC cancel and retry have distinct model-facing semantics', async () => {
    const adapter = makeAdapter()
    adapter.ensureOsPermissions = async () => ({ granted: false, accessibility: false, screenRecording: false })
    const cancelled = await handleToolCall(adapter, 'request_access', {
      apps: [], reason: 'test',
    }, makeOverrides({
      onPermissionRequest: async () => ({
        granted: [], denied: [], flags: { ...DEFAULT_GRANT_FLAGS }, userConsented: false,
      }),
    }))
    expect(cancelled.isError).toBeUndefined()
    expect(json(cancelled).guidance).toContain('Do not reopen the same permission dialog')

    const retry = await handleToolCall(adapter, 'request_access', {
      apps: [], reason: 'test',
    }, makeOverrides({
      onPermissionRequest: async () => ({
        granted: [], denied: [], flags: { ...DEFAULT_GRANT_FLAGS }, userConsented: undefined,
      }),
    }))
    expect(retry.isError).toBe(true)
    expect(retry.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('call request_access again') })
  })
})

describe('Windows click observation', () => {
  test('a window lost while open settles does not return a desktop image', async () => {
    let bound = false;
    let captures = 0;
    const adapter = makeAdapter({
      capabilities: { platform: 'win32', screenshotFiltering: 'none' },
      isWindowBound: () => bound,
      getBoundWindowState: () => bound ? { hwnd: 20, minimized: false, foreground: true, requiresForeground: false } : null,
      getBoundRevision: () => bound ? 2 : 3,
      openApp: async () => { bound = true; setTimeout(() => { bound = false }, 0) },
      screenshot: async () => { captures++; return shot() },
    });
    const result = await handleToolCall(adapter, 'open_application', { app: 'app.test', settle_ms: 20 }, makeOverrides());
    expect(JSON.stringify(result.content)).toContain('original bound window is no longer available');
    expect(result.screenshot).toBeUndefined();
    expect(captures).toBe(0);
  })

  test('explicit foreground click uses the guarded channel once and requires a focused binding', async () => {
    const frame = { ...shot(), captureMode: 'bound_window' as const, targetRevision: 3 }
    const state = { hwnd: 20, minimized: false, foreground: false, requiresForeground: false }
    const channels: Array<boolean | undefined> = []
    const adapter = makeAdapter({
      capabilities: { platform: 'win32', screenshotFiltering: 'none' },
      isWindowBound: () => true,
      getBoundAppId: () => 'app.test',
      getBoundRevision: () => 3,
      getBoundWindowState: () => state,
      click: async (_x, _y, _button, _count, _modifiers, foreground) => { channels.push(foreground) },
      screenshot: async () => frame,
    })
    const options = makeOverrides({ lastScreenshot: frame, boundRevision: 3 })
    const input = { coordinate: [20, 30], input: 'foreground', screenshot: true, settle_ms: 0 }
    expect((await handleToolCall(adapter, 'left_click', input, options)).telemetry?.error_kind).toBe('state_conflict')
    state.foreground = true
    expect((await handleToolCall(adapter, 'left_click', { ...input, settle_ms: 5001 }, options)).telemetry?.error_kind).toBe('bad_args')
    expect((await handleToolCall(adapter, 'left_click', input, options)).screenshot).toEqual(frame)
    expect(channels).toEqual([true])
  })

  test('reports focus loss before capture or input, then returns the next image or minimized status', async () => {
    const frame = { ...shot(), captureMode: 'bound_window' as const, targetRevision: 3 }
    const state = { hwnd: 20, minimized: false, foreground: false, requiresForeground: true }
    let clicks = 0
    let captures = 0
    const adapter = makeAdapter({
      capabilities: { platform: 'win32', screenshotFiltering: 'none' },
      isWindowBound: () => true,
      getBoundAppId: () => 'app.test',
      getBoundRevision: () => 3,
      getBoundWindowState: () => state,
      click: async () => { if (++clicks === 2) state.minimized = true },
      screenshot: async options => {
        expect(options.observeBoundRevision).toBe(3)
        expect(options.allowDisplayFallback).toBeFalse()
        captures++
        return frame
      },
    })
    const options = makeOverrides({ lastScreenshot: frame, boundRevision: 3 })
    const input = { coordinate: [20, 30], screenshot: true }
    const rejected = await handleToolCall(adapter, 'left_click', input, options)
    expect(rejected.isError).toBeTrue()
    expect(JSON.stringify(rejected.content)).toContain('foreground=false')
    expect(clicks).toBe(0)
    expect(captures).toBe(0)
    state.foreground = true
    const observed = await handleToolCall(adapter, 'left_click', input, options)
    expect(observed.screenshot).toEqual(frame)
    expect(observed.content.some(item => item.type === 'image')).toBeTrue()
    const minimized = await handleToolCall(adapter, 'left_click', input, options)
    expect(minimized.isError).toBeUndefined()
    expect(JSON.stringify(minimized.content)).toContain('minimized=true')
    expect(minimized.screenshot).toBeUndefined()
    expect(clicks).toBe(2)
    expect(captures).toBe(1)
  })
})

describe('Windows display and window coordinate spaces', () => {
  test('pixel input reuses capture geometry without a redundant display enumeration', async () => {
    let enumerations = 0
    const moves: Array<[number, number]> = []
    const adapter = makeAdapter({
      getDisplaySize: async () => { enumerations++; throw new Error('must not enumerate') },
      moveMouse: async (x, y) => { moves.push([x, y]) },
    })
    const result = await handleToolCall(adapter, 'mouse_move', { coordinate: [50, 25] }, makeOverrides({
      lastScreenshot: { ...shot(1000, 500), width: 500, height: 250, originX: -100, originY: -50 },
    }))
    expect(result.isError).toBeUndefined()
    expect(moves).toEqual([[0, 0]])
    expect(enumerations).toBe(0)
  })

  test('normalized input still resolves the current display or bound input surface', async () => {
    let enumerations = 0
    const moves: Array<[number, number]> = []
    const adapter = makeAdapter({
      getDisplaySize: async () => {
        enumerations++
        return { width: 200, height: 100, scaleFactor: 1, displayId: 1, originX: -200, originY: 10 }
      },
      moveMouse: async (x, y) => { moves.push([x, y]) },
    })
    const result = await handleToolCall(adapter, 'mouse_move', { coordinate: [50, 50] }, makeOverrides({ coordinateMode: 'normalized_0_100' }))
    expect(result.isError).toBeUndefined()
    expect(moves).toEqual([[-100, 60]])
    expect(enumerations).toBe(1)
  })

  test('switch_display(auto) exits window mode and requires a fresh screenshot', async () => {
    let unbinds = 0
    let pinned: number | undefined | 'unset' = 'unset'
    const result = await handleToolCall(makeAdapter({
      unbindApp: async () => { unbinds++ },
    }), 'switch_display', { display: 'auto' }, makeOverrides({
      onDisplayPinned: id => { pinned = id },
    }))
    expect(result.isError).toBeUndefined()
    expect(unbinds).toBe(1)
    expect(pinned).toBeUndefined()
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Call screenshot before acting') })
  })

  test('switching a display releases a held button before leaving window mode', async () => {
    const calls: string[] = []
    await handleToolCall(makeAdapter({
      mouseUp: async () => { calls.push('release') },
      unbindApp: async () => { calls.push('unbind') },
    }), 'left_mouse_down', {}, makeOverrides())
    const result = await handleToolCall(makeAdapter({
      mouseUp: async () => { calls.push('release') },
      unbindApp: async () => { calls.push('unbind') },
    }), 'switch_display', { display: 'auto' }, makeOverrides({ onDisplayPinned: () => {} }))
    expect(result.isError).toBeUndefined()
    expect(calls).toEqual(['release', 'unbind'])
  })

  test('open_application releases a held button before rebinding', async () => {
    const calls: string[] = []
    const adapter = makeAdapter({
      mouseUp: async () => { calls.push('release') },
      openApp: async () => { calls.push('open') },
    })
    await handleToolCall(adapter, 'left_mouse_down', {}, makeOverrides())
    const result = await handleToolCall(adapter, 'open_application', { app: 'app.test' }, makeOverrides())
    expect(result.isError).toBeUndefined()
    expect(calls).toEqual(['release', 'open'])
  })

  test('a single named display can leave window mode', async () => {
    let unbinds = 0
    let pinned: number | undefined
    const result = await handleToolCall(makeAdapter({
      listDisplays: async () => [{ width: 100, height: 100, scaleFactor: 1, displayId: 0, originX: 0, originY: 0, label: 'Only display' }],
      unbindApp: async () => { unbinds++ },
    }), 'switch_display', { display: 'Only display' }, makeOverrides({
      onDisplayPinned: id => { pinned = id },
    }))
    expect(result.isError).toBeUndefined()
    expect(pinned).toBe(0)
    expect(unbinds).toBe(1)
  })

  test('Windows foreground path comparison ignores separator and case variants', async () => {
    let clicks = 0
    const adapter = makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      getFrontmostApp: async () => ({ bundleId: 'E:/Apps/Game.exe', displayName: 'Game' }),
      appUnderPoint: async () => ({ bundleId: 'E:/Apps/Game.exe', displayName: 'Game' }),
      click: async () => { clicks++ },
    })
    const result = await handleToolCall(adapter, 'left_click', { coordinate: [10, 10] }, makeOverrides({
      allowedApps: [{ bundleId: 'e:\\apps\\game.exe', displayName: 'Game', grantedAt: 1, tier: 'full' }],
    }))
    expect(result.isError).toBeUndefined()
    expect(clicks).toBe(1)
  })

  test('an authorized shell alias resolves its real foreground executable path', async () => {
    let typed = 0
    const adapter = makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      getFrontmostApp: async () => ({ bundleId: 'C:\\Apps\\Game.exe', displayName: 'Game' }),
      listInstalledApps: async () => [{
        bundleId: 'C:\\Apps\\Game.exe', displayName: 'Game',
        path: 'C:\\Apps\\Game.exe', extraPaths: ['shell:AppsFolder\\Vendor.Game!App'],
      }],
      type: async () => { typed++ },
    })
    const result = await handleToolCall(adapter, 'type', { text: 'x' }, makeOverrides({
      allowedApps: [{ bundleId: 'shell:AppsFolder\\Vendor.Game!App', displayName: 'Game', grantedAt: 1, tier: 'full' }],
    }))
    expect(result.isError).toBeUndefined()
    expect(typed).toBe(1)
  })

  test('an unrelated foreground app remains rejected after alias resolution', async () => {
    let typed = 0
    const adapter = makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      getFrontmostApp: async () => ({ bundleId: 'C:\\Apps\\Other.exe', displayName: 'Other' }),
      listInstalledApps: async () => [{
        bundleId: 'shell:AppsFolder\\Vendor.Game!App', displayName: 'Game',
        path: 'shell:AppsFolder\\Vendor.Game!App', extraPaths: ['c:/apps/game.exe'],
      }],
      type: async () => { typed++ },
    })
    const result = await handleToolCall(adapter, 'type', { text: 'x' }, makeOverrides({
      allowedApps: [{ bundleId: 'shell:AppsFolder\\Vendor.Game!App', displayName: 'Game', grantedAt: 1, tier: 'full' }],
    }))
    expect(result.telemetry?.error_kind).toBe('app_not_granted')
    expect(typed).toBe(0)
  })

  test('deny list path variants remove the normalized grant before input', async () => {
    let typed = 0
    const adapter = makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      getFrontmostApp: async () => ({ bundleId: 'E:\\Apps\\Game.exe', displayName: 'Game' }),
      type: async () => { typed++ },
    })
    const result = await handleToolCall(adapter, 'type', { text: 'x' }, makeOverrides({
      allowedApps: [{ bundleId: 'E:\\Apps\\Game.exe', displayName: 'Game', grantedAt: 1, tier: 'full' }],
      userDeniedBundleIds: ['e:/apps/subdir/../game.exe'],
    }))
    expect(result.telemetry?.error_kind).toBe('allowlist_empty')
    expect(typed).toBe(0)
  })

  test('deny list real executable also rejects its authorized shell alias', async () => {
    let typed = 0
    const adapter = makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      getFrontmostApp: async () => ({ bundleId: 'C:\\Apps\\Game.exe', displayName: 'Game' }),
      listInstalledApps: async () => [{
        bundleId: 'C:\\Apps\\Game.exe', displayName: 'Game',
        path: 'C:\\Apps\\Game.exe', extraPaths: ['shell:AppsFolder\\Vendor.Game!App'],
      }],
      type: async () => { typed++ },
    })
    const result = await handleToolCall(adapter, 'type', { text: 'x' }, makeOverrides({
      allowedApps: [{ bundleId: 'shell:AppsFolder\\Vendor.Game!App', displayName: 'Game', grantedAt: 1, tier: 'full' }],
      userDeniedBundleIds: ['c:/apps/game.exe'],
    }))
    expect(result.telemetry?.error_kind).toBe('app_not_granted')
    expect(typed).toBe(0)
  })

  test('deny list shell alias also rejects its authorized real executable', async () => {
    let typed = 0
    const adapter = makeAdapter({
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host.test' },
      getFrontmostApp: async () => ({ bundleId: 'C:\\Apps\\Game.exe', displayName: 'Game' }),
      listInstalledApps: async () => [{
        bundleId: 'C:\\Apps\\Game.exe', displayName: 'Game',
        path: 'C:\\Apps\\Game.exe', extraPaths: ['shell:AppsFolder\\Vendor.Game!App'],
      }],
      type: async () => { typed++ },
    })
    const result = await handleToolCall(adapter, 'type', { text: 'x' }, makeOverrides({
      allowedApps: [{ bundleId: 'C:\\Apps\\Game.exe', displayName: 'Game', grantedAt: 1, tier: 'full' }],
      userDeniedBundleIds: ['shell:AppsFolder\\Vendor.Game!App'],
    }))
    expect(result.telemetry?.error_kind).toBe('app_not_granted')
    expect(typed).toBe(0)
  })

  test('full exe authorization and opening prefer the running exe over a registry GUID', async () => {
    const requested = 'E:\\game\\植物大战僵尸食物版\\PlantsVsZombiesFood.exe'
    const installed = [
      { bundleId: '{portable-game-guid}', displayName: '植物大战僵尸食物版', path: '' },
      { bundleId: requested, displayName: 'PlantsVsZombiesFood', path: requested },
    ]
    let opened = ''
    const adapter = makeAdapter({
      listInstalledApps: async () => installed,
      openApp: async id => { opened = id },
    })
    const access = await handleToolCall(adapter, 'request_access', {
      apps: [requested], reason: 'test',
    }, makeOverrides({
      allowedApps: [],
      onPermissionRequest: async request => ({
        granted: request.apps.map(app => ({
          bundleId: app.resolved!.bundleId,
          displayName: app.resolved!.displayName,
          grantedAt: 1,
          tier: 'full' as const,
        })),
        denied: [], flags: { ...DEFAULT_GRANT_FLAGS }, userConsented: true,
      }),
    }))
    const grant = json(access).granted[0]
    expect(grant.bundleId).toBe(requested)
    const openedResult = await handleToolCall(adapter, 'open_application', { app: requested }, makeOverrides({ allowedApps: [grant] }))
    expect(openedResult.isError).toBeUndefined()
    expect(opened).toBe(requested)
  })

  const windowsTest = process.platform === 'win32' ? test : test.skip

  test('literal desktop references grant the target executable and never fuzzy match unresolved shortcuts', () => {
    const exact = 'Desktop\\游戏\\App';
    const missing = 'Desktop\\游戏\\Missing';
    const program = { bundleId: 'E:\\apps\\Code.exe', displayName: 'Launcher', path: 'E:\\apps\\Code.exe' };
    const [resolved, denied] = _test.resolveRequestedApps([exact, missing], [
      { bundleId: 'missing', path: 'E:\\games\\missing.exe', displayName: 'Missing' },
      { bundleId: 'vscode', path: program.path, displayName: 'Visual Studio Code' },
    ], new Set(), new Map([[exact, program], [missing, undefined]]));
    expect(resolved?.resolved).toEqual({ ...program, displayName: 'Visual Studio Code' });
    expect(resolved?.proposedTier).toBe('click');
    expect(denied?.resolved).toBeUndefined();
  })

  windowsTest('an existing portable exe needs no registry or running-app cache', () => {
    const [request] = _test.resolveRequestedApps([process.execPath], [], new Set())
    expect(request?.resolved).toMatchObject({ bundleId: process.execPath, path: process.execPath })
    const missing = _test.resolveRequestedApps(['E:\\not-present\\missing-computer-use.exe'], [], new Set())
    expect(missing[0]?.resolved).toBeUndefined()
  })

  windowsTest('portable exe identity never upgrades a known IDE to full access', () => {
    const box = join(process.cwd(), 'test', 'cu-portable-tier')
    const metadataPath = join(box, 'neutral', 'Code.exe')
    const pathOnly = join(box, 'Microsoft VS Code', 'Code.exe')
    mkdirSync(join(box, 'neutral'), { recursive: true })
    mkdirSync(join(box, 'Microsoft VS Code'), { recursive: true })
    writeFileSync(metadataPath, 'fixture')
    writeFileSync(pathOnly, 'fixture')
    try {
      const installed = [{ bundleId: '{vscode-guid}', displayName: 'Visual Studio Code', path: '' }]
      const [fromMetadata, fromPath] = _test.resolveRequestedApps([metadataPath, pathOnly], installed, new Set())
      expect(fromMetadata?.resolved?.bundleId).toBe(metadataPath)
      expect(fromMetadata?.proposedTier).toBe('click')
      expect(fromPath?.resolved?.bundleId).toBe(pathOnly)
      expect(fromPath?.proposedTier).toBe('click')
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })
})


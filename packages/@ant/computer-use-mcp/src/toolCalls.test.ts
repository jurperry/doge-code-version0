import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { ComputerExecutor } from './executor.js'
import {
  handleToolCall,
  resetMouseButtonHeld,
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
    expect(json(result).failed.ok).toBe(false)
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
    const adapter = makeAdapter({ mouseUp: async () => { releases++ } })
    await handleToolCall(adapter, 'left_mouse_down', {}, makeOverrides())
    const result = await handleToolCall(adapter, 'left_mouse_up', {}, makeOverrides({ isAborted: () => true }))
    expect(result.isError).toBe(true)
    expect(releases).toBe(1)
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


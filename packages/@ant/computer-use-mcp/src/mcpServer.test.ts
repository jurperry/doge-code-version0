import { describe, expect, test } from 'bun:test'

import { bindSessionContext } from './mcpServer.js'
import { DEFAULT_GRANT_FLAGS, type ComputerUseHostAdapter, type ComputerUseSessionContext } from './types.js'

function adapter(executorOverrides: Record<string, unknown> = {}): ComputerUseHostAdapter {
  return {
    serverName: 'computer-use-test',
    logger: { silly() {}, debug() {}, info() {}, warn() {}, error() {} },
    executor: {
      capabilities: { screenshotFiltering: 'none', platform: 'win32', hostBundleId: 'host' },
      prepareForAction: async () => [],
      previewHideSet: async () => [],
      getDisplaySize: async () => ({ width: 100, height: 100, scaleFactor: 1, originX: 0, originY: 0, displayId: 0 }),
      listDisplays: async () => [],
      findWindowDisplays: async () => [],
      resolvePrepareCapture: async () => { throw new Error('not used') },
      screenshot: async () => { throw new Error('not used') },
      zoom: async () => { throw new Error('not used') },
      key: async () => {},
      holdKey: async () => {},
      type: async () => {},
      readClipboard: async () => '',
      writeClipboard: async () => {},
      moveMouse: async () => {},
      click: async () => {},
      mouseDown: async () => {},
      mouseUp: async () => {},
      getCursorPosition: async () => ({ x: 0, y: 0 }),
      drag: async () => {},
      scroll: async () => {},
      getFrontmostApp: async () => null,
      appUnderPoint: async () => null,
      listInstalledApps: async () => [],
      getAppIcon: async () => undefined,
      listRunningApps: async () => [],
      openApp: async () => {},
      ...executorOverrides,
    },
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

function context(extra: Partial<ComputerUseSessionContext> = {}): ComputerUseSessionContext {
  return {
    getAllowedApps: () => [{ bundleId: 'app.test', displayName: 'Test', grantedAt: 1, tier: 'full' }],
    getGrantFlags: () => DEFAULT_GRANT_FLAGS,
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => undefined,
    ...extra,
  }
}

describe('bindSessionContext request cancellation', () => {
  test('request signal stops subsequent batch actions and reports real progress', async () => {
    const controller = new AbortController()
    const progress: number[] = []
    const dispatch = bindSessionContext(adapter(), 'pixels', context())
    const pending = dispatch('computer_batch', {
      actions: [{ action: 'wait', duration: 0.02 }, { action: 'wait', duration: 5 }],
    }, controller.signal, event => {
      progress.push(event.progress)
      controller.abort()
    })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Batch aborted after 1 of 2 actions'),
    })
    expect(progress).toEqual([1])
  })

  test('legacy two-argument dispatch still honors the context abort fallback', async () => {
    const dispatch = bindSessionContext(adapter(), 'pixels', context({ isAborted: () => true }))
    await expect(dispatch('computer_batch', {
      actions: [{ action: 'wait', duration: 0 }],
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('request signal is forwarded to the permission dialog', async () => {
    const controller = new AbortController()
    let dialogSignal: AbortSignal | undefined
    const dispatch = bindSessionContext(adapter(), 'pixels', context({
      onPermissionRequest: (_request, signal) => {
        dialogSignal = signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('closed', 'AbortError')), { once: true })
        })
      },
    }))
    const pending = dispatch('request_access', {
      apps: ['missing-app'],
      reason: 'test',
    }, controller.signal)
    for (let i = 0; i < 100 && !dialogSignal; i++) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(dialogSignal).toBeDefined()
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Tool "request_access" failed: closed'),
    })
    expect(dialogSignal?.aborted).toBe(true)
  })
  test('a late screenshot cannot overwrite a newer coordinate anchor', async () => {
    const makeShot = (size: number) => ({
      base64: Buffer.alloc(2048, 1).toString('base64'),
      width: size,
      height: size,
      displayWidth: size,
      displayHeight: size,
      originX: 0,
      originY: 0,
      displayId: 0,
    })
    let calls = 0
    let finishFirst: (() => void) | undefined
    const captured: number[] = []
    const dispatch = bindSessionContext(adapter({
      capabilities: { screenshotFiltering: 'none', platform: 'darwin', hostBundleId: 'host' },
      screenshot: () => {
        calls++
        if (calls === 1) {
          return new Promise(resolve => {
            finishFirst = () => resolve(makeShot(100))
          })
        }
        return Promise.resolve(makeShot(200))
      },
    }), 'pixels', context({
      onScreenshotCaptured: dims => captured.push(dims.width),
    }))

    const first = dispatch('screenshot', {})
    for (let i = 0; i < 100 && !finishFirst; i++) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(finishFirst).toBeDefined()
    await dispatch('screenshot', {})
    finishFirst!()
    await first
    expect(captured).toEqual([200])
  })

  test('a pre-aborted call never starts capture', async () => {
    let captures = 0
    const controller = new AbortController()
    controller.abort()
    const dispatch = bindSessionContext(adapter({
      screenshot: async () => { captures++; throw new Error('must not run') },
    }), 'pixels', context())
    await expect(dispatch('screenshot', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(captures).toBe(0)
  })

  test('open_application replaces the anchor with its screenshot and switch_display clears it', async () => {
    const events: Array<number | string> = []
    let unbinds = 0
    const dispatch = bindSessionContext(adapter({
      screenshot: async () => ({
        base64: Buffer.alloc(2048, 1).toString('base64'),
        width: 100, height: 100, displayWidth: 100, displayHeight: 100,
        originX: 0, originY: 0, displayId: 0,
      }),
      unbindApp: async () => { unbinds++ },
    }), 'pixels', context({
      onDisplayPinned: () => {},
      onScreenshotCaptured: dims => events.push(dims.width),
      onScreenshotCleared: () => events.push('cleared'),
    }))
    await dispatch('screenshot', {})
    await dispatch('open_application', { app: 'app.test' })
    await dispatch('switch_display', { display: 'auto' })
    await dispatch('screenshot', {})
    expect(events).toEqual([100, 'cleared', 100, 'cleared', 100])
    expect(unbinds).toBe(1)
  })

  test('only a successful trailing batch screenshot replaces the coordinate anchor', async () => {
    const captured: number[] = []
    let size = 100
    const dispatch = bindSessionContext(adapter({
      screenshot: async () => ({
        base64: Buffer.alloc(2048, 1).toString('base64'),
        width: size, height: size, displayWidth: size, displayHeight: size,
        originX: 0, originY: 0, displayId: 0,
      }),
    }), 'pixels', context({ onScreenshotCaptured: dims => captured.push(dims.width) }))
    await dispatch('screenshot', {})
    size = 200
    await dispatch('computer_batch', { actions: [{ action: 'screenshot' }, { action: 'wait', duration: 0 }] })
    expect(captured).toEqual([100])
    await dispatch('computer_batch', { actions: [{ action: 'wait', duration: 0 }, { action: 'screenshot' }] })
    expect(captured).toEqual([100, 200])
  })

  test('an older capture cannot overwrite the anchor after a target change', async () => {
    const events: Array<number | string> = []
    let captureCalls = 0
    let finishCapture: (() => void) | undefined
    let finishSwitch: (() => void) | undefined
    const makeShot = (size: number) => ({
      base64: Buffer.alloc(2048, 1).toString('base64'),
      width: size, height: size, displayWidth: size, displayHeight: size,
      originX: 0, originY: 0, displayId: 0,
    })
    const dispatch = bindSessionContext(adapter({
      screenshot: () => {
        captureCalls++
        if (captureCalls === 1) return new Promise(resolve => { finishCapture = () => resolve(makeShot(100)) })
        return Promise.resolve(makeShot(200))
      },
      unbindApp: () => new Promise<void>(resolve => { finishSwitch = resolve }),
    }), 'pixels', context({
      onDisplayPinned: () => {},
      onScreenshotCaptured: dims => events.push(dims.width),
      onScreenshotCleared: () => events.push('cleared'),
    }))
    const oldCapture = dispatch('screenshot', {})
    for (let i = 0; i < 100 && !finishCapture; i++) await new Promise(resolve => setTimeout(resolve, 1))
    const blockedSwitch = await dispatch('switch_display', { display: 'auto' })
    expect(blockedSwitch.telemetry?.error_kind).toBe('state_conflict')
    expect(events).toEqual([])
    finishCapture!()
    await oldCapture
    expect(events).toEqual([])

    const switching = dispatch('switch_display', { display: 'auto' })
    for (let i = 0; i < 100 && !finishSwitch; i++) await new Promise(resolve => setTimeout(resolve, 1))
    const duringSwitch = await dispatch('screenshot', {})
    expect(duringSwitch.isError).toBe(true)
    expect(duringSwitch.telemetry?.error_kind).toBe('state_conflict')
    expect(captureCalls).toBe(1)
    finishSwitch!()
    await switching
    expect(events).toEqual(['cleared'])
    const fresh = await dispatch('screenshot', {})
    expect(fresh.isError).toBeUndefined()
    expect(events).toEqual(['cleared', 200])
  })

  test('an in-flight input blocks a target change instead of using stale coordinates', async () => {
    let finishGate: (() => void) | undefined
    let unbinds = 0
    let gateResolved = false
    const dispatch = bindSessionContext(adapter({
      getFrontmostApp: () => gateResolved
        ? Promise.resolve({ bundleId: 'app.test', displayName: 'Test' })
        : new Promise(resolve => {
          finishGate = () => {
            gateResolved = true
            resolve({ bundleId: 'app.test', displayName: 'Test' })
          }
        }),
      unbindApp: async () => { unbinds++ },
    }), 'pixels', context({ onDisplayPinned: () => {} }))
    const input = dispatch('mouse_move', { coordinate: [1, 1] })
    for (let i = 0; i < 100 && !finishGate; i++) await new Promise(resolve => setTimeout(resolve, 1))
    const blocked = await dispatch('switch_display', { display: 'auto' })
    expect(blocked.telemetry?.error_kind).toBe('state_conflict')
    expect(unbinds).toBe(0)
    finishGate!()
    expect((await input).isError).toBeUndefined()
    const switched = await dispatch('switch_display', { display: 'auto' })
    expect(switched.isError).toBeUndefined()
    expect(unbinds).toBe(1)
  })

  test('automatic unbind blocks the current input and resets the coordinate anchor', async () => {
    const events: Array<number | string> = []
    let bound: string | null = 'app.test'
    let revision = 1
    let transition = false
    let clicks = 0
    const dispatch = bindSessionContext(adapter({
      getBoundAppId: () => bound,
      getBoundRevision: () => revision,
      prepareForTarget: async () => { if (transition) { bound = null; revision++; transition = false } },
      getFrontmostApp: async () => ({ bundleId: 'app.test', displayName: 'Test' }),
      click: async () => { clicks++ },
      screenshot: async () => ({
        base64: Buffer.alloc(2048, 1).toString('base64'),
        width: 100, height: 100, displayWidth: 100, displayHeight: 100,
        originX: 0, originY: 0, displayId: 0, targetRevision: revision,
      }),
    }), 'pixels', context({
      onScreenshotCaptured: dims => events.push(dims.width),
      onScreenshotCleared: () => events.push('cleared'),
    }))
    await dispatch('screenshot', {})
    transition = true
    const click = await dispatch('left_click', { coordinate: [20, 20] })
    expect(click.telemetry?.error_kind).toBe('state_conflict')
    expect(clicks).toBe(0)
    expect(events).toEqual([100, 'cleared'])
    expect((await dispatch('screenshot', {})).isError).toBeUndefined()
    expect(events).toEqual([100, 'cleared', 100])
  })

  test('concurrent unbind rejects old input and rejects stale screenshot revisions', async () => {
    const events: Array<number | string> = []
    let bound: string | null = 'app.test'
    let revision = 1
    let transition = false
    let clicks = 0
    let gateUsed = false
    let finishGate: (() => void) | undefined
    let finishStale: (() => void) | undefined
    let staleCapture = false
    const makeShot = () => ({
      base64: Buffer.alloc(2048, 1).toString('base64'),
      width: 100, height: 100, displayWidth: 100, displayHeight: 100,
      originX: 0, originY: 0, displayId: 0, targetRevision: revision,
    })
    const dispatch = bindSessionContext(adapter({
      getBoundAppId: () => bound,
      getBoundRevision: () => revision,
      prepareForTarget: async () => { if (transition) { bound = null; revision++; transition = false } },
      getFrontmostApp: () => {
        if (gateUsed) return Promise.resolve({ bundleId: 'app.test', displayName: 'Test' })
        return new Promise(resolve => {
          gateUsed = true
          finishGate = () => resolve({ bundleId: 'app.test', displayName: 'Test' })
        })
      },
      click: async () => { clicks++ },
      screenshot: () => {
        if (staleCapture) return new Promise(resolve => { finishStale = () => resolve({ ...makeShot(), targetRevision: 1 }) })
        return Promise.resolve(makeShot())
      },
    }), 'pixels', context({
      onScreenshotCaptured: dims => events.push(dims.width),
      onScreenshotCleared: () => events.push('cleared'),
    }))
    await dispatch('screenshot', {})
    const input = dispatch('left_click', { coordinate: [20, 20] })
    for (let i = 0; i < 100 && !finishGate; i++) await Bun.sleep(1)
    transition = true
    expect((await dispatch('screenshot', {})).telemetry?.error_kind).toBe('state_conflict')
    expect(events).toEqual([100])
    finishGate!()
    expect((await input).telemetry?.error_kind).toBe('state_conflict')
    expect(clicks).toBe(0)
    expect(events).toEqual([100, 'cleared'])

    staleCapture = true
    const stale = dispatch('screenshot', {})
    for (let i = 0; i < 100 && !finishStale; i++) await Bun.sleep(1)
    finishStale!()
    expect((await stale).isError).toBeUndefined()
    expect(events).toEqual([100, 'cleared'])
  })

  test('Windows calls cannot change the selected input route across overlapping dispatchers', async () => {
    let finishClick: (() => void) | undefined
    let expectedRoute = 'broker'
    let route = 'local'
    let hitPid = 30
    let captures = 0
    const preparations: Array<number | undefined> = []
    const shared = adapter({
      getFrontmostApp: async () => ({ bundleId: 'app.test', displayName: 'Test', pid: hitPid }),
      appUnderPoint: async () => ({ bundleId: 'app.test', displayName: 'Test', pid: hitPid }),
      prepareForTarget: async (_signal: AbortSignal | undefined, _purpose: string, authorizedPid?: number) => {
        preparations.push(authorizedPid)
        route = authorizedPid === 30 ? 'broker' : 'local'
      },
      click: () => new Promise<void>(resolve => {
        finishClick = () => {
          expect(route).toBe(expectedRoute)
          resolve()
        }
      }),
      screenshot: async () => {
        route = 'local'
        captures++
        return {
          base64: Buffer.alloc(2048, 1).toString('base64'),
          width: 100, height: 100, displayWidth: 100, displayHeight: 100,
          originX: 0, originY: 0, displayId: 0,
        }
      },
    })
    const first = bindSessionContext(shared, 'pixels', context())
    const second = bindSessionContext(shared, 'pixels', context())
    const elevated = first('left_click', { coordinate: [20, 20] })
    for (let i = 0; i < 100 && !finishClick; i++) await Bun.sleep(1)
    expect((await second('screenshot', {})).telemetry?.error_kind).toBe('state_conflict')
    expect(captures).toBe(0)
    finishClick!()
    expect((await elevated).isError).toBeUndefined()

    expect((await second('screenshot', {})).isError).toBeUndefined()
    expect(captures).toBe(1)
    hitPid = 20
    expectedRoute = 'local'
    finishClick = undefined
    const ordinary = first('left_click', { coordinate: [20, 20] })
    for (let i = 0; i < 100 && !finishClick; i++) await Bun.sleep(1)
    const preparationCount = preparations.length
    hitPid = 30
    expect((await second('left_click', { coordinate: [20, 20] })).telemetry?.error_kind).toBe('state_conflict')
    expect(preparations).toHaveLength(preparationCount)
    expect(route).toBe('local')
    finishClick!()
    expect((await ordinary).isError).toBeUndefined()
  })

  test('open_application failure still invalidates the previous target anchor', async () => {
    const events: Array<number | string> = []
    const dispatch = bindSessionContext(adapter({
      screenshot: async () => ({
        base64: Buffer.alloc(2048, 1).toString('base64'),
        width: 100, height: 100, displayWidth: 100, displayHeight: 100,
        originX: 0, originY: 0, displayId: 0,
      }),
      openApp: async () => { throw new Error('bound, but foreground activation failed') },
    }), 'pixels', context({
      onScreenshotCaptured: dims => events.push(dims.width),
      onScreenshotCleared: () => events.push('cleared'),
    }))
    await dispatch('screenshot', {})
    const result = await dispatch('open_application', { app: 'app.test' })
    expect(result.isError).toBe(true)
    expect(events).toEqual([100, 'cleared'])
  })

  test('a host cleanup failure cannot leave target changes latched', async () => {
    let captures = 0
    const dispatch = bindSessionContext(adapter({
      screenshot: async () => {
        captures++
        return {
          base64: Buffer.alloc(2048, 1).toString('base64'),
          width: 100, height: 100, displayWidth: 100, displayHeight: 100,
          originX: 0, originY: 0, displayId: 0,
        }
      },
    }), 'pixels', context({
      onDisplayPinned: () => {},
      onScreenshotCleared: () => { throw new Error('host cleanup failed') },
    }))
    await expect(dispatch('switch_display', { display: 'auto' })).rejects.toThrow('host cleanup failed')
    expect((await dispatch('screenshot', {})).isError).toBeUndefined()
    expect(captures).toBe(1)
  })
})

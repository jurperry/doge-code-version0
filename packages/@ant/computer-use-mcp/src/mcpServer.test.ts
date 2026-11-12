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
    }, controller.signal, event => progress.push(event.progress))
    setTimeout(() => controller.abort(), 15)
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
})

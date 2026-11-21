import { API_RESIZE_PARAMS, targetImageSize } from '@ant/computer-use-mcp'
import type { ComputerExecutor, DisplayGeometry, ScreenshotResult } from '@ant/computer-use-mcp'
import { CLI_CU_CAPABILITIES, CLI_HOST_BUNDLE_ID } from '../common.js'
import { sleep } from '../../sleep.js'
import { readX11Clipboard, writeX11Clipboard } from './x11/clipboard.js'
import { withX11Desktop, type X11Window } from './x11/desktop.js'
import { encodeX11Jpeg } from './x11/image.js'

export async function isLinuxComputerUseAvailable(): Promise<boolean> {
  if (process.platform !== 'linux' || !Bun.which('xclip')) return false
  try {
    return await withX11Desktop(desktop => desktop.probe())
  } catch {
    return false
  }
}

function windowDisplay(window: X11Window): DisplayGeometry {
  const { x: originX, y: originY, width, height } = window.geometry
  return { displayId: 0, scaleFactor: 1, originX, originY, width, height }
}

const buttonNumber = { left: 1, right: 3, middle: 2 }

async function unsupported(): Promise<never> {
  throw new Error('This action is unavailable in X11 window mode.')
}

export function createLinuxExecutor(
  paste: (keys: (parts: string[]) => Promise<void>, text: string, signal?: AbortSignal) => Promise<void>,
): ComputerExecutor {
  let revision = 0
  let anchor: { window: X11Window; revision: number } | undefined

  function requireAnchor() {
    if (!anchor) throw new Error('Focus an authorized X11 window and take a screenshot before acting.')
    return anchor
  }

  function input(
    target: ReturnType<typeof requireAnchor>,
    action: { point?: { x: number; y: number }; keys?: string[]; buttons?: number[] },
    signal?: AbortSignal,
  ) {
    if (target.revision !== revision) throw new Error('The X11 capture target changed. Take a fresh screenshot.')
    return withX11Desktop(desktop => desktop.sendInput(target.window, action), signal)
  }

  async function screenshot({ allowedBundleIds }: { allowedBundleIds: string[] }): Promise<ScreenshotResult> {
    const previousRevision = revision
    const { window, pixels } = await withX11Desktop(async (desktop) => {
      const window = await desktop.focus()
      if (!window || !allowedBundleIds.includes(window.bundleId)) {
        throw new Error('Focus an authorized X11 window with open_application before taking a screenshot.')
      }
      return { window, pixels: await desktop.capture(window) }
    })
    if (previousRevision !== revision) throw new Error('The X11 capture target changed. Take a fresh screenshot.')
    const size = windowDisplay(window)
    const shot = encodeX11Jpeg(pixels, targetImageSize(size.width, size.height, API_RESIZE_PARAMS))
    anchor = { window, revision: ++revision }
    return {
      ...shot, displayId: 0, displayCount: 1, displayWidth: size.width, displayHeight: size.height,
      originX: size.originX, originY: size.originY, targetRevision: revision,
    }
  }

  return {
    capabilities: { ...CLI_CU_CAPABILITIES, hostBundleId: CLI_HOST_BUNDLE_ID },
    prepareForAction: async () => [],
    previewHideSet: async () => [],
    getDisplaySize: async () => windowDisplay(requireAnchor().window),
    listDisplays: async () => anchor ? [windowDisplay(anchor.window)] : [],
    findWindowDisplays: async () => [],
    resolvePrepareCapture: async opts => ({ ...await screenshot(opts), displayId: 0, hidden: [] }),
    screenshot,
    async zoom(region, allowedBundleIds) {
      const { window } = requireAnchor()
      if (!allowedBundleIds.includes(window.bundleId)) throw new Error('The X11 window is no longer authorized.')
      const x = Math.round(region.x)
      const y = Math.round(region.y)
      const pixels = await withX11Desktop(desktop => desktop.capture(window, {
        x, y, width: Math.round(region.x + region.w) - x, height: Math.round(region.y + region.h) - y,
      }))
      return encodeX11Jpeg(pixels)
    },
    async key(sequence, repeat = 1, signal) {
      const target = requireAnchor()
      const keys = sequence.split('+').map(key => key.trim())
      for (let i = 0; i < repeat; i++) {
        if (i > 0) await sleep(8, signal)
        await input(target, { keys }, signal)
      }
    },
    holdKey: unsupported,
    async type(text, _options, signal) {
      const target = requireAnchor()
      await paste(keys => input(target, { keys }, signal), text, signal)
    },
    readClipboard: readX11Clipboard,
    writeClipboard: writeX11Clipboard,
    moveMouse: (x, y) => input(requireAnchor(), { point: { x, y } }),
    click: (x, y, button, count, keys) => input(requireAnchor(), {
      point: { x, y }, keys, buttons: Array(count).fill(buttonNumber[button]),
    }),
    mouseDown: unsupported,
    mouseUp: unsupported,
    getCursorPosition: () => withX11Desktop(desktop => desktop.cursor()),
    drag: unsupported,
    scroll: (x, y, dx, dy) => input(requireAnchor(), {
      point: { x, y },
      buttons: [
        ...Array(Math.min(20, Math.abs(Math.round(dy)))).fill(dy > 0 ? 5 : 4),
        ...Array(Math.min(20, Math.abs(Math.round(dx)))).fill(dx > 0 ? 7 : 6),
      ],
    }),
    getBoundAppId: () => anchor?.window.bundleId ?? null,
    getBoundRevision: () => revision,
    getFrontmostApp: () => withX11Desktop(desktop => desktop.focus()),
    appUnderPoint: (x, y) => withX11Desktop(desktop => desktop.hit({ x, y })),
    listInstalledApps: () => withX11Desktop(desktop => desktop.windows()),
    listRunningApps: () => withX11Desktop(desktop => desktop.windows()),
    getAppIcon: async () => undefined,
    async openApp(bundleId, signal) {
      anchor = undefined
      revision++
      await withX11Desktop(desktop => desktop.activate(bundleId, signal), signal)
    },
  }
}

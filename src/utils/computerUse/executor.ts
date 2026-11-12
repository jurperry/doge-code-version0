/**
 * CLI `ComputerExecutor` implementation. Wraps two native modules:
 *   - `@ant/computer-use-input` (Rust/enigo) — mouse, keyboard, frontmost app
 *   - `@ant/computer-use-swift` — SCContentFilter screenshots, NSWorkspace apps, TCC
 *
 * Contract: `packages/desktop/computer-use-mcp/src/executor.ts` in the apps
 * repo. The reference impl is Cowork's `apps/desktop/src/main/nest-only/
 * computer-use/executor.ts` — see notable deviations under "CLI deltas" below.
 *
 * ── CLI deltas from Cowork ─────────────────────────────────────────────────
 *
 * No `withClickThrough`. Cowork wraps every mouse op in
 *   `BrowserWindow.setIgnoreMouseEvents(true)` so clicks fall through the
 *   overlay. We're a terminal — no window — so the click-through bracket is
 *   a no-op. The sentinel `CLI_HOST_BUNDLE_ID` never matches frontmost.
 *
 * Terminal as surrogate host. `getTerminalBundleId()` detects the emulator
 *   we're running inside. It's passed as `hostBundleId` to `prepareDisplay`/
 *   `resolvePrepareCapture` so the Swift side exempts it from hide AND skips
 *   it in the activate z-order walk (so the terminal being frontmost doesn't
 *   eat clicks meant for the target app). Also stripped from `allowedBundleIds`
 *   via `withoutTerminal()` so screenshots don't capture it (Swift 0.2.1's
 *   captureExcluding takes an allow-list despite the name — apps#30355).
 *   `capabilities.hostBundleId` stays as the sentinel — the package's
 *   frontmost gate uses that, and the terminal being frontmost is fine.
 *
 * Clipboard via `pbcopy`/`pbpaste`. No Electron `clipboard` module.
 */

import type {
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from '@ant/computer-use-mcp'

import { API_RESIZE_PARAMS, targetImageSize } from '@ant/computer-use-mcp'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { sleep } from '../sleep.js'
import {
  CLI_CU_CAPABILITIES,
  CLI_HOST_BUNDLE_ID,
  getTerminalBundleId,
} from './common.js'
import { drainRunLoop } from './drainRunLoop.js'
import { notifyExpectedEscape } from './escHotkey.js'
import { requireComputerUseInput } from './inputLoader.js'
import { requireComputerUseSwift } from './swiftLoader.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const SCREENSHOT_JPEG_QUALITY = 0.75

/** Logical → physical → API target dims. See `targetImageSize` + COORDINATES.md. */
function computeTargetDims(
  logicalW: number,
  logicalH: number,
  scaleFactor: number,
): [number, number] {
  const physW = Math.round(logicalW * scaleFactor)
  const physH = Math.round(logicalH * scaleFactor)
  return targetImageSize(physW, physH, API_RESIZE_PARAMS)
}

async function readClipboardViaPbpaste(): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout, code } = await execFileNoThrow('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write((Get-Clipboard -Raw))'], {
      useCwd: false,
      stripFinalNewline: false,
    })
    if (code !== 0) {
      throw new Error(`PowerShell Get-Clipboard exited with code ${code}`)
    }
    return stdout
  }
  if (process.platform === 'linux') {
    const { stdout, code } = await execFileNoThrow('xclip', ['-selection', 'clipboard', '-o'], {
      useCwd: false,
      stripFinalNewline: false,
    })
    if (code !== 0) {
      throw new Error(`xclip exited with code ${code}`)
    }
    return stdout
  }
  const { stdout, code } = await execFileNoThrow('pbpaste', [], {
    useCwd: false,
  })
  if (code !== 0) {
    throw new Error(`pbpaste exited with code ${code}`)
  }
  return stdout
}

async function writeClipboardViaPbcopy(text: string): Promise<void> {
  if (process.platform === 'win32') {
    const { code } = await execFileNoThrow('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'], {
      input: text,
      useCwd: false,
      stripFinalNewline: false,
    })
    if (code !== 0) {
      throw new Error(`PowerShell Set-Clipboard exited with code ${code}`)
    }
    return
  }
  if (process.platform === 'linux') {
    const { code } = await execFileNoThrow('xclip', ['-selection', 'clipboard'], {
      input: text,
      useCwd: false,
      stripFinalNewline: false,
    })
    if (code !== 0) {
      throw new Error(`xclip exited with code ${code}`)
    }
    return
  }
  const { code } = await execFileNoThrow('pbcopy', [], {
    input: text,
    useCwd: false,
  })
  if (code !== 0) {
    throw new Error(`pbcopy exited with code ${code}`)
  }
}

type Input = ReturnType<typeof requireComputerUseInput>

/**
 * Single-element key sequence matching "escape" or "esc" (case-insensitive).
 * Used to hole-punch the CGEventTap abort for model-synthesized Escape — enigo
 * accepts both spellings, so the tap must too.
 */
function isBareEscape(parts: readonly string[]): boolean {
  if (parts.length !== 1) return false
  const lower = parts[0]!.toLowerCase()
  return lower === 'escape' || lower === 'esc'
}

/**
 * Instant move, then 50ms — an input→HID→AppKit→NSEvent round-trip before the
 * caller reads `NSEvent.mouseLocation` or dispatches a click. Used for click,
 * scroll, and drag-from; `animatedMove` is reserved for drag-to only. The
 * intermediate animation frames were triggering hover states and, on the
 * decomposed mouseDown/moveMouse path, emitting stray `.leftMouseDragged`
 * events (toolCalls.ts handleScroll's mouse_full workaround).
 */
const MOVE_SETTLE_MS = 50

async function moveAndSettle(
  input: Input,
  x: number,
  y: number,
): Promise<void> {
  await input.moveMouse(x, y, false)
  await sleep(MOVE_SETTLE_MS)
}

/**
 * Release `pressed` in reverse (last pressed = first released). Every release is
 * attempted, then failures are surfaced so a stuck modifier is never reported
 * as a successful hold.
 *
 * Drains via pop() rather than snapshotting length: if a drainRunLoop-
 * orphaned press lambda resolves an in-flight input.key() AFTER finally
 * calls us, that late push is still released on the next iteration. The
 * orphaned flag stops the lambda at its NEXT check, not the current await.
 */
async function releasePressed(input: Input, pressed: string[]): Promise<void> {
  const failures: string[] = []
  let k: string | undefined
  while ((k = pressed.pop()) !== undefined) {
    try {
      await input.key(k, 'release')
    } catch (error) {
      failures.push(`${k}: ${errorMessage(error)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to release held keys; they may still be pressed (${failures.join('; ')})`)
  }
}

/**
 * Bracket `fn()` with modifier press/release. `pressed` tracks which presses
 * actually landed, so a mid-press throw only releases what was pressed — no
 * stuck modifiers. The finally covers both press-phase and fn() throws.
 *
 * Caller must already be inside drainRunLoop() — key() dispatches to the
 * main queue and needs the pump to resolve.
 */
async function withModifiers<T>(
  input: Input,
  mods: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const pressed: string[] = []
  try {
    for (const m of mods) {
      pressed.push(m)
      await input.key(m, 'press')
    }
    return await fn()
  } finally {
    await releasePressed(input, pressed)
  }
}

/**
 * Port of Cowork's `typeViaClipboard`. Sequence:
 *   1. Save the user's clipboard.
 *   2. Write our text.
 *   3. READ-BACK VERIFY — clipboard writes can silently fail. If the
 *      read-back doesn't match, never press Cmd+V (would paste junk).
 *   4. Cmd+V via keys().
 *   5. Sleep 100ms — battle-tested threshold for the paste-effect vs
 *      clipboard-restore race. Restoring too soon means the target app
 *      pastes the RESTORED content.
 *   6. Restore — in a `finally`, so a throw between 2-5 never leaves the
 *      user's clipboard clobbered. Restore failures are swallowed.
 */
async function typeViaClipboard(input: Input, text: string): Promise<void> {
  let saved: string
  try {
    saved = await readClipboardViaPbpaste()
  } catch (error) {
    throw new Error(`Could not read the existing clipboard, so it was left unchanged: ${errorMessage(error)}`)
  }

  let pasteError: unknown
  try {
    await writeClipboardViaPbcopy(text)
    if ((await readClipboardViaPbpaste()) !== text) {
      throw new Error('Clipboard write did not round-trip; paste was not sent.')
    }
    await input.keys([process.platform === 'darwin' ? 'command' : 'ctrl', 'v'])
    await sleep(100)
  } catch (error) {
    pasteError = error
    throw error
  } finally {
    try {
      await writeClipboardViaPbcopy(saved)
    } catch (restoreError) {
      if (pasteError) {
        throw new Error(`Paste failed: ${errorMessage(pasteError)}. Clipboard restore also failed: ${errorMessage(restoreError)}`)
      }
      throw new Error(`Text was pasted, but restoring the previous clipboard failed: ${errorMessage(restoreError)}`)
    }
  }
}

/**
 * Port of Cowork's `animateMouseMovement` + `animatedMove`. Ease-out-cubic at
 * 60fps; distance-proportional duration at 2000 px/sec, capped at 0.5s. When
 * the sub-gate is off (or distance < ~2 frames), falls through to
 * `moveAndSettle`. Called only from `drag` for the press→to motion — target
 * apps may watch for `.leftMouseDragged` specifically (not just "button down +
 * position changed") and the slow motion gives them time to process
 * intermediate positions (scrollbars, window resizes).
 */
async function animatedMove(
  input: Input,
  targetX: number,
  targetY: number,
  mouseAnimationEnabled: boolean,
): Promise<void> {
  if (!mouseAnimationEnabled) {
    await moveAndSettle(input, targetX, targetY)
    return
  }
  const start = await input.mouseLocation()
  const deltaX = targetX - start.x
  const deltaY = targetY - start.y
  const distance = Math.hypot(deltaX, deltaY)
  if (distance < 1) return
  const durationSec = Math.min(distance / 2000, 0.5)
  if (durationSec < 0.03) {
    await moveAndSettle(input, targetX, targetY)
    return
  }
  const frameRate = 60
  const frameIntervalMs = 1000 / frameRate
  const totalFrames = Math.floor(durationSec * frameRate)
  for (let frame = 1; frame <= totalFrames; frame++) {
    const t = frame / totalFrames
    const eased = 1 - Math.pow(1 - t, 3)
    await input.moveMouse(
      Math.round(start.x + deltaX * eased),
      Math.round(start.y + deltaY * eased),
      false,
    )
    if (frame < totalFrames) {
      await sleep(frameIntervalMs)
    }
  }
  // Last frame has no trailing sleep — same HID round-trip before the
  // caller's mouseButton reads NSEvent.mouseLocation.
  await sleep(MOVE_SETTLE_MS)
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createCliExecutor(opts: {
  getMouseAnimationEnabled: () => boolean
  getHideBeforeActionEnabled: () => boolean
}): ComputerExecutor {
  if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') {
    throw new Error(
      `createCliExecutor called on ${process.platform}. Computer control requires macOS, Windows, or Linux.`,
    )
  }

  // On macOS: use native @ant packages via requireComputerUseSwift/Input.
  // On Windows/Linux: use platforms/ abstraction layer.
  const isDarwin = process.platform === 'darwin'

  // Lazy-loaded platforms/ for non-darwin.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const platform = isDarwin ? null : (require('./platforms/index.js') as typeof import('./platforms/index.js')).loadPlatform()

  // Unified adapter: on darwin delegates to @ant packages, on other platforms to platforms/.
  // This lets all 17 call sites in executor use `cu.xxx` without per-site branching.
  const cuNative = isDarwin ? requireComputerUseSwift() : null
  const cu = cuNative ?? {
    apps: {
      prepareDisplay: async () => ({ activated: '', hidden: [] as string[] }),
      previewHideSet: async () => [] as any[],
      findWindowDisplays: async (ids: string[]) => ids.map(b => ({ bundleId: b, displayIds: [] })),
      appUnderPoint: async (x: number, y: number) => {
        const info = platform!.apps.getFrontmostApp()
        return info ? { bundleId: info.id, displayName: info.appName } : null
      },
      listInstalled: async () => (await platform!.apps.listInstalled()).map(a => ({
        bundleId: a.id, displayName: a.displayName, path: a.path,
        extraPaths: (a as any).extraPaths,
      })),
      iconDataUrl: () => null as string | null,
      listRunning: () => platform!.apps.listRunning().map(w => ({
        bundleId: w.id, displayName: w.title,
      })),
      open: async (bundleId: string) => platform!.apps.open(bundleId),
      unhide: async () => {},
    },
    display: {
      getSize: (displayId?: number) => {
        const d = platform!.display.getSize(displayId)
        return { ...d, scaleFactor: d.scaleFactor ?? 1, displayId: d.displayId ?? 0, originX: d.originX ?? 0, originY: d.originY ?? 0 }
      },
      listAll: () => platform!.display.listAll(),
    },
    screenshot: {
      captureExcluding: async (...args: any[]) => platform!.screenshot.captureScreen(args[4], args[2], args[3]),
      captureRegion: async (_a: any, x: number, y: number, w: number, h: number, ...rest: any[]) =>
        platform!.screenshot.captureRegion(x, y, w, h),
    },
    resolvePrepareCapture: async (
      _allowed: string[], _host: string, _q: number,
      targetW: number, targetH: number, displayId?: number,
    ) => {
      const shot = await platform!.screenshot.captureScreen(displayId, targetW, targetH)
      return { ...shot, hidden: [] as string[], displayId: displayId ?? 0 }
    },
  }

  const { getMouseAnimationEnabled, getHideBeforeActionEnabled } = opts
  // Unified input: on darwin → @ant/computer-use-input, on others → platform.input.
  // Uses the same interface so all callsites can use `getInput()` uniformly.
  type Input = ReturnType<typeof requireComputerUseInput>
  // SendMessage carries coordinates inline instead of moving the real cursor,
  // so mouseButton still needs the most recent target position.
  let lastMouseX = 0
  let lastMouseY = 0
  const getInput = (): Input => {
    if (isDarwin) return requireComputerUseInput()
    const p = platform!.input
    return {
      moveMouse: (x: number, y: number, _animated: boolean) => { lastMouseX = x; lastMouseY = y; return p.moveMouse(x, y) },
      key: (k: string, a: 'press' | 'release') => p.key(k, a),
      keys: (parts: string[]) => p.keys(parts),
      // Windows returns the live cursor in bound-window coordinates when an
      // HWND is bound, and in virtual-screen coordinates otherwise.
      mouseLocation: () => p.mouseLocation(),
      // press/release map to the platform's phase primitives when available —
      // the old blanket click() mapping turned executor drag() into three
      // independent full clicks on Windows.
      mouseButton: (btn: 'left' | 'right' | 'middle', a: 'click' | 'press' | 'release', count?: number) => {
        if (a === 'press' && p.mouseDown) return p.mouseDown(lastMouseX, lastMouseY)
        if (a === 'press') throw new Error('Mouse-down is not supported on this platform')
        if (a === 'release') {
          if (p.mouseUp) return p.mouseUp(lastMouseX, lastMouseY)
          throw new Error('Mouse-up is not supported on this platform')
        }
        return p.click(lastMouseX, lastMouseY, btn, count ?? 1)
      },
      mouseScroll: (amount: number, dir: 'vertical' | 'horizontal') => p.scroll(amount, dir, lastMouseX, lastMouseY),
      typeText: (text: string) => p.typeText(text),
      getFrontmostAppInfo: () => {
        const info = platform!.apps.getFrontmostApp()
        return info ? { bundleId: info.id, appName: info.appName } : null
      },
      isSupported: true,
    } as any as Input
  }

  const terminalBundleId = getTerminalBundleId()
  const surrogateHost = terminalBundleId ?? CLI_HOST_BUNDLE_ID
  // Swift 0.2.1's captureExcluding/captureRegion take an ALLOW list despite the
  // name (apps#30355 — complement computed Swift-side against running apps).
  // The terminal isn't in the user's grants so it's naturally excluded, but if
  // the package ever passes it through we strip it here so the terminal never
  // photobombs a screenshot.
  const withoutTerminal = (allowed: readonly string[]): string[] =>
    terminalBundleId === null
      ? [...allowed]
      : allowed.filter(id => id !== terminalBundleId)

  logForDebugging(
    terminalBundleId
      ? `[computer-use] terminal ${terminalBundleId} → surrogate host (hide-exempt, activate-skip, screenshot-excluded)`
      : '[computer-use] terminal not detected; falling back to sentinel host',
  )

  return {
    capabilities: {
      ...CLI_CU_CAPABILITIES,
      hostBundleId: CLI_HOST_BUNDLE_ID,
    },

    // ── Pre-action sequence (hide + defocus) ────────────────────────────

    async prepareForAction(
      allowlistBundleIds: string[],
      displayId?: number,
    ): Promise<string[]> {
      if (!getHideBeforeActionEnabled()) {
        return []
      }
      // prepareDisplay isn't @MainActor (plain Task{}), but its .hide() calls
      // trigger window-manager events that queue on CFRunLoop. Without the
      // pump, those pile up during Swift's ~1s of usleeps and flush all at
      // once when the next pumped call runs — visible window flashing.
      // Electron drains CFRunLoop continuously so Cowork doesn't see this.
      // Worst-case 100ms + 5×200ms safety-net ≈ 1.1s, well under the 30s
      // drainRunLoop ceiling.
      //
      // "Continue with action execution even if switching fails" — the
      // frontmost gate in toolCalls.ts catches any actual unsafe state.
      return drainRunLoop(async () => {
        try {
          const result = await cu.apps.prepareDisplay(
            allowlistBundleIds,
            surrogateHost,
            displayId,
          )
          if (result.activated) {
            logForDebugging(
              `[computer-use] prepareForAction: activated ${result.activated}`,
            )
          }
          return result.hidden
        } catch (err) {
          logForDebugging(
            `[computer-use] prepareForAction failed; continuing to action: ${errorMessage(err)}`,
            { level: 'warn' },
          )
          return []
        }
      })
    },

    async previewHideSet(
      allowlistBundleIds: string[],
      displayId?: number,
    ): Promise<Array<{ bundleId: string; displayName: string }>> {
      return cu.apps.previewHideSet(
        [...allowlistBundleIds, surrogateHost],
        displayId,
      )
    },

    // ── Display ──────────────────────────────────────────────────────────

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      if (!isDarwin && process.platform === 'win32') {
        const { getBoundWindowDimensions } = require('./platforms/win32.js') as typeof import('./platforms/win32.js')
        const bound = getBoundWindowDimensions()
        if (bound) {
          return {
            ...bound,
            scaleFactor: 1,
            displayId: displayId ?? 0,
            originX: 0,
            originY: 0,
          }
        }
      }
      return cu.display.getSize(displayId)
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      return cu.display.listAll()
    },

    async findWindowDisplays(
      bundleIds: string[],
    ): Promise<Array<{ bundleId: string; displayIds: number[] }>> {
      return cu.apps.findWindowDisplays(bundleIds)
    },

    async resolvePrepareCapture(opts: {
      allowedBundleIds: string[]
      preferredDisplayId?: number
      autoResolve: boolean
      doHide?: boolean
    }): Promise<ResolvePrepareCaptureResult> {
      const d = cu.display.getSize(opts.preferredDisplayId)
      const [targetW, targetH] = computeTargetDims(
        d.width,
        d.height,
        d.scaleFactor,
      )
      const raw = await drainRunLoop(() =>
        cu.resolvePrepareCapture(
          withoutTerminal(opts.allowedBundleIds),
          surrogateHost,
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts.preferredDisplayId,
          opts.autoResolve,
          opts.doHide,
        ),
      )
      // Ensure the result has fields expected by toolCalls.ts (hidden, displayId).
      // macOS native returns these from Swift; our cross-platform ComputerUseAPI
      // returns {base64, width, height} — fill in the missing fields.
      return {
        ...raw,
        hidden: (raw as any).hidden ?? [],
        displayId: (raw as any).displayId ?? opts.preferredDisplayId ?? d.displayId,
      }
    },

    /**
     * Pre-size to `targetImageSize` output so the API transcoder's early-return
     * fires — no server-side resize, `scaleCoord` stays coherent. See
     * packages/desktop/computer-use-mcp/COORDINATES.md.
     */
    async screenshot(opts: {
      allowedBundleIds: string[]
      displayId?: number
    }): Promise<ScreenshotResult> {
      const d = cu.display.getSize(opts.displayId)
      const [targetW, targetH] = computeTargetDims(
        d.width,
        d.height,
        d.scaleFactor,
      )
      return drainRunLoop(() =>
        cu.screenshot.captureExcluding(
          withoutTerminal(opts.allowedBundleIds),
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts.displayId,
        ),
      )
    },

    async zoom(
      regionLogical: { x: number; y: number; w: number; h: number },
      allowedBundleIds: string[],
      displayId?: number,
      captureOrigin?: { x: number; y: number },
    ): Promise<{ base64: string; width: number; height: number }> {
      if (!isDarwin && platform) {
        return platform.screenshot.captureRegion(
          regionLogical.x,
          regionLogical.y,
          regionLogical.w,
          regionLogical.h,
          captureOrigin,
        )
      }
      const d = cu.display.getSize(displayId)
      const [outW, outH] = computeTargetDims(
        regionLogical.w,
        regionLogical.h,
        d.scaleFactor,
      )
      return drainRunLoop(() =>
        cu.screenshot.captureRegion(
          withoutTerminal(allowedBundleIds),
          regionLogical.x,
          regionLogical.y,
          regionLogical.w,
          regionLogical.h,
          outW,
          outH,
          SCREENSHOT_JPEG_QUALITY,
          displayId,
        ),
      )
    },

    // ── Keyboard ─────────────────────────────────────────────────────────

    /**
     * xdotool-style sequence e.g. "ctrl+shift+a" → split on '+' and pass to
     * keys(). keys() dispatches to DispatchQueue.main — drainRunLoop pumps
     * CFRunLoop so it resolves. Rust's error-path cleanup (enigo_wrap.rs)
     * releases modifiers on each invocation, so a mid-loop throw leaves
     * nothing stuck. 8ms between iterations — 125Hz USB polling cadence.
     */
    async key(keySequence: string, repeat?: number): Promise<void> {
      // Windows/Linux: route through platform which handles HWND binding
      if (!isDarwin && platform) {
        const parts = keySequence.split('+').filter(p => p.length > 0)
        const n = repeat ?? 1
        for (let i = 0; i < n; i++) {
          if (i > 0) await sleep(8)
          if (isBareEscape(parts)) notifyExpectedEscape()
          await platform.input.keys(parts)
        }
        return
      }
      const input = getInput()
      const parts = keySequence.split('+').filter(p => p.length > 0)
      const isEsc = isBareEscape(parts)
      const n = repeat ?? 1
      await drainRunLoop(async () => {
        for (let i = 0; i < n; i++) {
          if (i > 0) await sleep(8)
          if (isEsc) notifyExpectedEscape()
          await input.keys(parts)
        }
      })
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      const input = getInput()
      // Press/release each wrapped in drainRunLoop; the sleep sits outside so
      // durationMs isn't bounded by drainRunLoop's 30s timeout. `pressed`
      // tracks which presses landed so a mid-press throw still releases
      // everything that was actually pressed.
      //
      // `orphaned` guards against a timeout-orphan race: if the press-phase
      // drainRunLoop times out while the esc-hotkey pump-retain keeps the
      // pump running, the orphaned lambda would continue pushing to `pressed`
      // after finally's releasePressed snapshotted the length — leaving keys
      // stuck. The flag stops the lambda at the next iteration.
      const pressed: string[] = []
      let orphaned = false
      try {
        await drainRunLoop(async () => {
          for (const k of keyNames) {
            if (orphaned) return
            // Bare Escape: notify the CGEventTap so it doesn't fire the
            // abort callback for a model-synthesized press. Same as key().
            if (isBareEscape([k])) {
              notifyExpectedEscape()
            }
            pressed.push(k)
            await input.key(k, 'press')
          }
        })
        await sleep(durationMs)
      } finally {
        orphaned = true
        await drainRunLoop(() => releasePressed(input, pressed))
      }
    },

    async type(text: string, opts: { viaClipboard: boolean }): Promise<void> {
      // Windows/Linux: route through platform which handles HWND binding
      if (!isDarwin && platform) {
        if (opts.viaClipboard) {
          await typeViaClipboard(getInput(), text)
        } else {
          await platform.input.typeText(text)
        }
        return
      }
      const input = getInput()
      if (opts.viaClipboard) {
        await drainRunLoop(() => typeViaClipboard(input, text))
        return
      }
      await input.typeText(text)
    },

    readClipboard: readClipboardViaPbpaste,

    writeClipboard: writeClipboardViaPbcopy,

    // ── Mouse ────────────────────────────────────────────────────────────

    async moveMouse(x: number, y: number): Promise<void> {
      await moveAndSettle(getInput(), x, y)
    },

    /**
     * Move, then click. Modifiers are press/release bracketed via withModifiers
     * — same pattern as Cowork. AppKit computes NSEvent.clickCount from timing
     * + position proximity, so double/triple click work without setting the
     * CGEvent clickState field. key() inside withModifiers needs the pump;
     * the modifier-less path doesn't.
     */
    async click(
      x: number,
      y: number,
      button: 'left' | 'right' | 'middle',
      count: 1 | 2 | 3,
      modifiers?: string[],
    ): Promise<void> {
      const input = getInput()
      await moveAndSettle(input, x, y)
      if (modifiers && modifiers.length > 0) {
        await drainRunLoop(() =>
          withModifiers(input, modifiers, () =>
            input.mouseButton(button, 'click', count),
          ),
        )
      } else {
        await input.mouseButton(button, 'click', count)
      }
    },

    async mouseDown(): Promise<void> {
      await getInput().mouseButton('left', 'press')
    },

    async mouseUp(): Promise<void> {
      await getInput().mouseButton('left', 'release')
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return getInput().mouseLocation()
    },

    /**
     * `from === undefined` → drag from current cursor (training's
     * left_click_drag with start_coordinate omitted). Inner `finally`: the
     * button is ALWAYS released even if the move throws — otherwise the
     * user's left button is stuck-pressed until they physically click.
     * 50ms sleep after press: enigo's move_mouse reads NSEvent.pressedMouseButtons
     * to decide .leftMouseDragged vs .mouseMoved; the synthetic leftMouseDown
     * needs a HID-tap round-trip to show up there.
     *
     * Windows delegates to the platform's whole-gesture drag() when available
     * (single PowerShell for press → eased frames → release; the per-frame
     * composition below costs one process per animation frame).
     */
    async drag(
      from: { x: number; y: number } | undefined,
      to: { x: number; y: number },
    ): Promise<void> {
      if (!isDarwin && platform?.input.drag) {
        const start = from ?? { x: lastMouseX, y: lastMouseY }
        const distance = Math.hypot(to.x - start.x, to.y - start.y)
        // Same curve as animatedMove: 2000 px/sec, capped at 0.5s.
        const durationMs = Math.max(80, Math.min((distance / 2000) * 1000, 500))
        await platform.input.drag(start, to, durationMs)
        lastMouseX = to.x
        lastMouseY = to.y
        return
      }
      const input = getInput()
      if (from !== undefined) {
        await moveAndSettle(input, from.x, from.y)
      }
      await input.mouseButton('left', 'press')
      await sleep(MOVE_SETTLE_MS)
      try {
        await animatedMove(input, to.x, to.y, getMouseAnimationEnabled())
      } finally {
        await input.mouseButton('left', 'release')
      }
    },

    /**
     * Move first, then scroll each axis. Vertical-first — it's the common
     * axis; a horizontal failure shouldn't lose the vertical.
     */
    async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
      const input = getInput()
      await moveAndSettle(input, x, y)
      if (dy !== 0) {
        await input.mouseScroll(dy, 'vertical')
      }
      if (dx !== 0) {
        await input.mouseScroll(dx, 'horizontal')
      }
    },

    // ── App management ───────────────────────────────────────────────────

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      // The package gate needs the effective input target for authorization.
      // Background HWND delivery may legitimately differ from the physical
      // foreground; real-input delivery is separately verified by the Win32 guard.
      if (!isDarwin) {
        try {
          const { getBoundHwnd, getBoundFilePath, getBoundAppId } = require('./platforms/win32.js') as typeof import('./platforms/win32.js')
          if (getBoundHwnd() || getBoundFilePath()) {
            const bundleId = getBoundAppId()
            return bundleId ? { bundleId, displayName: bundleId } : null
          }
        } catch {}
        if (platform) {
          const info = platform.apps.getFrontmostApp()
          if (!info) return null
          return { bundleId: info.id, displayName: info.appName }
        }
      }
      if (isDarwin) {
        const info = getInput().getFrontmostAppInfo()
        if (!info || !info.bundleId) return null
        return { bundleId: info.bundleId, displayName: info.appName }
      }
      return null
    },

    async appUnderPoint(
      x: number,
      y: number,
    ): Promise<{ bundleId: string; displayName: string } | null> {
      return cu.apps.appUnderPoint(x, y)
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      // `ComputerUseInstalledApp` is `{bundleId, displayName, path}`.
      // `InstalledApp` adds optional `iconDataUrl` — left unpopulated;
      // the approval dialog fetches lazily via getAppIcon() below.
      return drainRunLoop(() => cu.apps.listInstalled())
    },

    async getAppIcon(path: string): Promise<string | undefined> {
      return cu.apps.iconDataUrl(path) ?? undefined
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return cu.apps.listRunning()
    },

    async openApp(bundleId: string): Promise<void> {
      if (!isDarwin && platform) {
        // Windows/Linux: platform.apps.open() handles HWND binding + DWM border
        await platform.apps.open(bundleId)
        return
      }
      await cu.apps.open(bundleId)
    },
  }
}

export async function restoreComputerUseClipboard(text: string): Promise<void> {
  await writeClipboardViaPbcopy(text)
}

/**
 * Module-level export (not on the executor object) — called at turn-end from
 * `stopHooks.ts` / `query.ts`, outside the executor lifecycle. Fire-and-forget
 * at the call site; the caller `.catch()`es.
 */
export async function unhideComputerUseApps(
  bundleIds: readonly string[],
): Promise<void> {
  if (bundleIds.length === 0) return
  if (process.platform === 'darwin') {
    const cu = requireComputerUseSwift()
    await cu.apps.unhide([...bundleIds])
  }
  // Non-darwin: no-op. Windows/Linux prepareForAction doesn't hide apps.
}

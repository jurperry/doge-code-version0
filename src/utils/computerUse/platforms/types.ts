/**
 * Cross-platform abstraction types for Computer Use.
 *
 * These interfaces define a unified API surface for input, screenshots,
 * display info, and app management across macOS, Windows, and Linux.
 */

// ---------------------------------------------------------------------------
// Window / App types
// ---------------------------------------------------------------------------

/** Cross-platform window identifier */
export interface WindowHandle {
  id: string        // macOS: bundleId, Windows: HWND string, Linux: window ID
  pid: number
  title: string
  exePath?: string  // Windows/Linux: process executable path
}

export interface ScreenshotResult {
  base64: string
  width: number
  height: number
  displayWidth?: number
  displayHeight?: number
  originX?: number
  originY?: number
  displayId?: number
  displayCount?: number
  targetRevision?: number
}

export interface DisplayInfo {
  width: number
  height: number
  scaleFactor: number
  displayId: number
  isPrimary?: boolean
  originX?: number
  originY?: number
}

export interface InstalledApp {
  id: string          // macOS: bundleId, Windows: exe path or package family, Linux: .desktop name
  displayName: string
  path: string
  /** Additional match tokens for name resolution (Windows: registry install
   *  locations, shortcut targets, live window titles of running apps). */
  extraPaths?: string[]
}

export interface FrontmostAppInfo {
  id: string
  appName: string
  hostId?: string
  hostName?: string
  pid?: number
  hostPid?: number
  hostTrusted?: boolean
  startedAt?: number
  hostStartedAt?: number
}

// ---------------------------------------------------------------------------
// InputPlatform
// ---------------------------------------------------------------------------

/**
 * Input platform interface — two modes:
 *
 * Mode A (Global): moveMouse, click, typeText, key, keys, scroll, mouseLocation
 *   Works on all platforms. Sends input to the foreground window; moves the
 *   real cursor and steals focus.
 *
 * Mode B (Window-bound, optional): sendChar, sendKey, sendClick, sendText
 *   Windows-only via SendMessage/PostMessage. Does NOT steal focus or move
 *   the cursor. Preferred when a target HWND is known.
 */
export interface InputPlatform {
  // --- Mode A: Global input (all platforms) ---
  moveMouse(x: number, y: number): Promise<void>
  click(x: number, y: number, button: 'left' | 'right' | 'middle', count?: number): Promise<void>
  typeText(text: string, signal?: AbortSignal): Promise<void>
  key(name: string, action: 'press' | 'release'): Promise<void>
  keys(combo: string[]): Promise<void>
  scroll(amount: number, direction: 'vertical' | 'horizontal', x?: number, y?: number): Promise<void>
  mouseLocation(): Promise<{ x: number; y: number }>

  // --- Drag primitives (optional; Windows implements both transports) ---
  /** Press-only (no release) — phase primitive for drag composition. */
  mouseDown?(x: number, y: number): Promise<void>
  /** Release-only. */
  mouseUp?(x: number, y: number): Promise<void>
  /** Whole drag gesture (press → eased move → release) in one call —
   *  single-process on Windows, far cheaper than per-frame composition. */
  drag?(from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void>

  // --- Mode B: Window-bound input (Windows only, optional) ---
  sendChar?(hwnd: string, char: string): Promise<void>
  sendKey?(hwnd: string, vk: number, action: 'down' | 'up'): Promise<void>
  sendClick?(hwnd: string, x: number, y: number, button: 'left' | 'right' | 'middle'): Promise<void>
  sendText?(hwnd: string, text: string): Promise<void>
}

// ---------------------------------------------------------------------------
// ScreenshotPlatform
// ---------------------------------------------------------------------------

export interface ScreenshotPlatform {
  /** Full-screen capture. Returns JPEG base64. Optionally downscaled to target dims. */
  captureScreen(displayId?: number, targetW?: number, targetH?: number): Promise<ScreenshotResult>
  /** Region capture. Returns JPEG base64. */
  captureRegion(x: number, y: number, w: number, h: number, origin?: { x: number; y: number }): Promise<ScreenshotResult>
  /** Window capture (Windows: PrintWindow, macOS: SCContentFilter, Linux: xdotool+import). */
  captureWindow?(hwnd: string, expectedPid?: number): Promise<ScreenshotResult | null>
}

// ---------------------------------------------------------------------------
// DisplayPlatform
// ---------------------------------------------------------------------------

export interface DisplayPlatform {
  listAll(): DisplayInfo[]
  getSize(displayId?: number): DisplayInfo
}

// ---------------------------------------------------------------------------
// AppsPlatform
// ---------------------------------------------------------------------------

export interface AppsPlatform {
  listRunning(): WindowHandle[]
  listInstalled(): Promise<InstalledApp[]>
  open(name: string, signal?: AbortSignal, windowId?: string): Promise<void>
  getFrontmostApp(): FrontmostAppInfo | null
  getAppAtPoint?(x: number, y: number): FrontmostAppInfo | null
  findWindowByTitle(title: string): WindowHandle | null
}

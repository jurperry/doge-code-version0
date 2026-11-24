export interface DisplayGeometry {
  displayId: number
  width: number
  height: number
  scaleFactor: number
  originX: number
  originY: number
  label?: string
  isPrimary?: boolean
}

/** How the last image was produced. Omitted on platforms without HWND binding. */
export type CaptureMode = 'bound_window' | 'full_display'

/** Why the previous window anchor was released. */
export type BindingReleaseReason = 'switch_display' | 'new_foreground' | 'capture_unavailable' | 'explicit'

export interface BindingReleaseInfo {
  reason: BindingReleaseReason
  at: number
  revision: number
  appId: string | null
  pid: number | null
  hwnd: number | null
  foreground: FrontmostApp | null
}

export interface ScreenshotResult {
  base64: string
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  originX: number
  originY: number
  displayId?: number
  /** Avoid a second native enumeration just for screenshot notes. */
  displayCount?: number
  targetRevision?: number
  /** Capture space for this image (`bound_window` vs the whole display). */
  captureMode?: CaptureMode
  /** Set when this capture observed its own target being released mid-call. */
  bindingRelease?: BindingReleaseInfo
}

export interface FrontmostApp {
  bundleId: string
  displayName: string
  hostBundleId?: string
  hostDisplayName?: string
  pid?: number
  hostPid?: number
  hostTrusted?: boolean
  startedAt?: number
  hostStartedAt?: number
}

export interface InstalledApp {
  bundleId: string
  displayName: string
  path: string
  /** Additional paths from merged entries (e.g. registry InstallLocation) */
  extraPaths?: string[]
  iconDataUrl?: string
}

export interface WindowsWindow {
  hwnd: number
  pid: number
  windowId: string
  bundleId: string
  title: string
  className: string
  visible: boolean
  minimized: boolean
  foreground: boolean
  dpiAwareness: number | null
  il: string
}

export interface RunningApp {
  bundleId: string
  displayName: string
  pid?: number
}

export interface ResolvePrepareCaptureResult extends ScreenshotResult {
  hidden: string[]
  activated?: string
  displayId: number
  captureError?: string
}

export interface ComputerExecutorCapabilities {
  screenshotFiltering: 'native' | 'none'
  platform: 'darwin' | 'win32' | 'linux'
  hostBundleId: string
}

export type TargetPreparation = 'input' | 'capture' | 'hover'

export interface ComputerExecutor {
  capabilities: ComputerExecutorCapabilities
  prepareForAction(
    allowlistBundleIds: string[],
    displayId?: number,
  ): Promise<string[]>
  previewHideSet(
    allowlistBundleIds: string[],
    displayId?: number,
  ): Promise<Array<{ bundleId: string; displayName: string }>>
  getDisplaySize(displayId?: number): Promise<DisplayGeometry>
  listDisplays(): Promise<DisplayGeometry[]>
  findWindowDisplays(
    bundleIds: string[],
  ): Promise<Array<{ bundleId: string; displayIds: number[] }>>
  resolvePrepareCapture(opts: {
    allowedBundleIds: string[]
    preferredDisplayId?: number
    autoResolve: boolean
    doHide?: boolean
  }): Promise<ResolvePrepareCaptureResult>
  screenshot(opts: {
    allowedBundleIds: string[]
    displayId?: number
    /** Windows can change capture mode only when returning a new image to the model. */
    allowDisplayFallback?: boolean
    /** Follow-up observation must stay in the same binding and preserve its placement. */
    observeBoundRevision?: number
  }): Promise<ScreenshotResult>
  zoom(
    regionLogical: { x: number; y: number; w: number; h: number },
    allowedBundleIds: string[],
    displayId?: number,
    captureOrigin?: { x: number; y: number },
  ): Promise<{ base64: string; width: number; height: number }>
  validateKeyChord?(parts: string[]): void
  key(keySequence: string, repeat?: number, signal?: AbortSignal): Promise<void>
  holdKey(keyNames: string[], durationMs: number, signal?: AbortSignal): Promise<void>
  type(text: string, opts: { viaClipboard: boolean }, signal?: AbortSignal): Promise<void>
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  moveMouse(x: number, y: number): Promise<void>
  click(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle',
    count: 1 | 2 | 3,
    modifiers?: string[],
  ): Promise<void>
  mouseDown(): Promise<void>
  mouseUp(): Promise<void>
  getCursorPosition(): Promise<{ x: number; y: number }>
  drag(
    from: { x: number; y: number } | undefined,
    to: { x: number; y: number },
  ): Promise<void>
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>
  /** Match the execution context to the authorized Windows target when UIPI requires it. */
  prepareForTarget?(signal?: AbortSignal, purpose?: TargetPreparation): Promise<void>
  isWindowBound?(): boolean
  getBoundAppId?(): string | null
  getBoundRevision?(): number | undefined
  getBoundWindowState?(): { hwnd: number; foreground: boolean; minimized: boolean; requiresForeground: boolean } | null
  /** Last automatic/explicit release; used for diagnostics and screenshot notes. */
  getBindingRelease?(): BindingReleaseInfo | null
  getFrontmostApp(): Promise<FrontmostApp | null>
  appUnderPoint(
    x: number,
    y: number,
  ): Promise<FrontmostApp | null>
  listInstalledApps(): Promise<InstalledApp[]>
  getAppIcon(path: string): Promise<string | undefined>
  listRunningApps(): Promise<RunningApp[]>
  listWindows?(visibleOnly?: boolean): Promise<WindowsWindow[]>
  activateWindow?(window: WindowsWindow, signal?: AbortSignal): Promise<boolean>
  getOwnIntegrity?(): string
  openApp(bundleId: string, signal?: AbortSignal, windowId?: string): Promise<void>
  /** Windows: leave HWND-bound mode and use display/global coordinates. */
  unbindApp?(): Promise<void>
}

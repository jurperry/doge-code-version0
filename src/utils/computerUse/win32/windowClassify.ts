/**
 * Window-framework classification for the Windows CU input channel.
 *
 * 向顶层 HWND SendMessage(WM_LBUTTONDOWN/WM_CHAR) 只对「标准 USER 窗口」有效。
 * 以下框架在自绘表面里渲染全部内容、自己消费原始输入，父窗口收到的
 * SendMessage 鼠标/键盘消息不会产生任何应用层效果：
 *
 *   - Chromium（Electron / CEF / WebView2）：Chrome_RenderWidgetHostHWND 消费真实鼠标；
 *   - WPF：HwndWrapper 顶层窗口由 WPF InputManager 驱动，合成鼠标消息无效
 *     （AnyCast 等 WPF 应用即典型）；
 *   - WinUI 3 / UWP：WinUIDesktopWin32WindowClass / ApplicationFrameWindow /
 *     Windows.UI.Core.CoreWindow 由 CoreWindow + 合成器消费输入；
 *   - WinForms：WindowsForms10.* 的控件树由 WinForms 消息循环接管；
 *   - JavaFX：GlassWndClass-*；
 *   - Qt / SDL / GLFW / Unity / Godot / Unreal / Tk：自绘或原生子窗口树，
 *     顶层窗口不转发坐标输入；
 *   - Flutter：FLUTTERVIEW。
 *
 * 绑定窗口时枚举顶层 + 子窗口类名做一次分类，决定输入通道。优先使用
 * SendMessage（不移动用户光标、不抢焦点）；只有框架明确会忽略消息时才走
 * 真实输入（前台卫兵保护）。未知框架保持 SendMessage —— 不凭猜测抢前台。
 */

export type WindowFramework =
  | 'chromium'
  | 'wpf'
  | 'winui'
  | 'winforms'
  | 'javafx'
  | 'flutter'
  | 'unreal'
  | 'tk'
  | 'self-drawn'
  | 'standard'

export interface WindowFrameworkInfo {
  framework: WindowFramework
  /** SendMessage mouse is a no-op at the app layer; use real input. */
  mouseNeedsRealInput: boolean
  /** SendMessage keyboard is a no-op at the app layer; use real input. */
  keyboardNeedsRealInput: boolean
  /** Legacy discriminators kept for diagnostics and existing callers. */
  chromium: boolean
  selfDrawn: boolean
  winForms: boolean
  /** The class that triggered the classification — for debug logging. */
  matchedClass: string | null
}

/** Chromium child/top-level class prefixes (case-insensitive). */
const CHROMIUM_PREFIXES = ['chrome_renderwidgethosthwnd', 'chrome_widgetwin_']

/**
 * WPF's HwndSource class. The suffix is a GUID per window:
 * `HwndWrapper[Anycast.exe;;708a2617-…]`.
 */
const WPF_PREFIX = 'hwndwrapper['

/** WinUI 3 / UWP top-level and child classes. */
const WINUI_EXACT = new Set([
  'winuidesktopwin32windowclass', // WinUI 3 Window
  'applicationframewindow', // UWP application frame host
  'windows.ui.core.corewindow', // UWP CoreWindow
  'microsoft.ui.content.desktopchildsitebridge', // WinUI 3 XAML island host
])

/** JavaFX/Glass top-level class: `GlassWndClass-…`. */
const JAVAFX_PREFIX = 'glasswndclass'

/** Flutter Windows embedder top-level class. */
const FLUTTER_EXACT = new Set(['flutterview'])

/** Unreal Engine top-level class. */
const UNREAL_EXACT = new Set(['unrealwindow'])

/** Tk top-level/child classes (native child widgets own the coordinates). */
const TK_EXACT = new Set(['tktoplevel', 'tkchild'])

/** Self-drawn framework signatures. Matched against top-level AND child
 *  classes, case-insensitive. */
const SELF_DRAWN_EXACT = new Set([
  'sdl_app', // SDL2 games and apps
  'unitywndclass', // Unity player
  'godotwindow', // Godot 4
])
const SELF_DRAWN_PREFIXES = [
  'glfw', // GLFW: GLFW30, GLFW31…
  'sunawt', // Java AWT/Swing: SunAwtFrame / SunAwtDialog / SunAwtWindow…
]

/**
 * True when the class name itself signals a self-drawn framework. Qt's
 * "Qt\d*QWindow…" is the load-bearing case (Android emulator): prefix 'qt'
 * additionally requires 'qwindow' in the name to avoid over-matching.
 */
function isSelfDrawnClass(lower: string): boolean {
  if (SELF_DRAWN_EXACT.has(lower)) return true
  if (lower.startsWith('qt') && lower.includes('qwindow')) return true
  return SELF_DRAWN_PREFIXES.some(p => lower.startsWith(p))
}

function isChromiumClass(lower: string): boolean {
  return CHROMIUM_PREFIXES.some(p => lower.startsWith(p))
}

function realInput(framework: Exclude<WindowFramework, 'standard'>, cls: string): WindowFrameworkInfo {
  return {
    framework,
    mouseNeedsRealInput: true,
    keyboardNeedsRealInput: true,
    chromium: framework === 'chromium',
    selfDrawn: framework === 'self-drawn',
    winForms: framework === 'winforms',
    matchedClass: cls,
  }
}

function standardInput(): WindowFrameworkInfo {
  return {
    framework: 'standard',
    mouseNeedsRealInput: false,
    keyboardNeedsRealInput: false,
    chromium: false,
    selfDrawn: false,
    winForms: false,
    matchedClass: null,
  }
}

/** Classify a window from its top-level + child class names. Pure. */
export function classifyWindowClasses(
  topClass: string,
  childClasses: readonly string[],
  executableBase?: string,
): WindowFrameworkInfo {
  const all = [topClass, ...childClasses]
  const topLower = topClass.toLowerCase()

  // Chromium first: WebView2/CEF children can live under an otherwise
  // unclassified native host, and Chromium must win over self-drawn matches.
  for (const cls of all) {
    if (isChromiumClass(cls.toLowerCase())) return realInput('chromium', cls)
  }

  // WPF and WinUI host their own input stacks; neither exposes per-control
  // child HWNDs, so a top-level SendMessage can never reach the control.
  // Child matches are deliberate: an embedded WPF/WinUI view belongs to the
  // same input stack, and real input is the safe fallback.
  for (const cls of all) {
    const lower = cls.toLowerCase()
    if (lower.startsWith(WPF_PREFIX)) return realInput('wpf', cls)
    if (WINUI_EXACT.has(lower)) return realInput('winui', cls)
  }

  // WinForms only guarantees the framework marker on the top-level window;
  // a WindowsForms10.* child can also appear in native hosts, so keep the
  // existing top-level-only rule.
  if (topLower.startsWith('windowsforms10.')) return realInput('winforms', topClass)

  // The PopCap game uses a generic Win32 class but samples foreground input.
  if (topLower === 'mainwindow' && /^plantsvszombies(?:food)?$/i.test(executableBase ?? '')) {
    return realInput('self-drawn', topClass)
  }

  for (const cls of all) {
    const lower = cls.toLowerCase()
    if (lower.startsWith(JAVAFX_PREFIX)) return realInput('javafx', cls)
    if (FLUTTER_EXACT.has(lower)) return realInput('flutter', cls)
    if (UNREAL_EXACT.has(lower)) return realInput('unreal', cls)
    if (TK_EXACT.has(lower)) return realInput('tk', cls)
    if (isSelfDrawnClass(lower)) return realInput('self-drawn', cls)
  }

  return standardInput()
}

/**
 * Window-framework classification for the Windows CU input channel.
 *
 * 向顶层 HWND SendMessage(WM_LBUTTONDOWN/WM_CHAR) 只对「标准 USER 控件」有效。
 * 自绘框架（Qt/SDL/GLFW/Unity/Java AWT）在自绘表面里渲染全部内容、自己消费
 * 原始输入消息，父窗口收到的 SendMessage 鼠标/键盘消息不会产生任何应用层
 * 效果 —— Android 模拟器（Qt）即典型：adb getevent 显示 0 个触摸事件。
 * Chromium（Electron/CEF）的鼠标同理（旧代码已单列）。WM_CHAR 文本通道在
 * 中文环境下会产生乱码，因此所有窗口的文本统一走真实 Unicode 输入。
 *
 * 绑定窗口时枚举顶层 + 子窗口类名做一次分类，决定输入通道：
 *   - chromium  → 鼠标与文本都走真实输入
 *   - selfDrawn → 鼠标 + 键盘都走真实输入（前台卫兵保护）
 */

export interface WindowFrameworkInfo {
  chromium: boolean
  selfDrawn: boolean
  /** The class that triggered the classification — for debug logging. */
  matchedClass: string | null
}

/** Chromium child-window class prefixes (case-insensitive). */
const CHROMIUM_PREFIXES = ['Chrome_RenderWidgetHostHWND', 'Chrome_WidgetWin_']

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
function isSelfDrawnClass(cls: string): boolean {
  const lower = cls.toLowerCase()
  if (SELF_DRAWN_EXACT.has(lower)) return true
  if (lower.startsWith('qt') && lower.includes('qwindow')) return true
  return SELF_DRAWN_PREFIXES.some(p => lower.startsWith(p))
}

/** Classify a window from its top-level + child class names. Pure. */
export function classifyWindowClasses(
  topClass: string,
  childClasses: readonly string[],
): WindowFrameworkInfo {
  const all = [topClass, ...childClasses]
  for (const cls of all) {
    const lower = cls.toLowerCase()
    if (CHROMIUM_PREFIXES.some(p => lower.startsWith(p.toLowerCase()))) {
      return { chromium: true, selfDrawn: false, matchedClass: cls }
    }
  }
  for (const cls of all) {
    if (isSelfDrawnClass(cls)) {
      return { chromium: false, selfDrawn: true, matchedClass: cls }
    }
  }
  return { chromium: false, selfDrawn: false, matchedClass: null }
}

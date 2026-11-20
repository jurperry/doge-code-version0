import { expect, test } from 'bun:test'
import { classifyWindowClasses } from './windowClassify.js'

function expectReal(framework: string, cls: string, childClasses: string[] = [], matched = cls): void {
  const r = classifyWindowClasses(cls, childClasses)
  expect(r.framework).toBe(framework as never)
  expect(r.mouseNeedsRealInput).toBeTrue()
  expect(r.keyboardNeedsRealInput).toBeTrue()
  expect(r.matchedClass).toBe(matched)
}

test('classifies Qt windows as self-drawn (Android emulator case)', () => {
  // Qt top-level class carries the version: Qt5152QWindowIcon / Qt6QWindowIcon…
  for (const cls of ['Qt5152QWindowIcon', 'Qt6QWindowIcon', 'Qt671QWindowToolSaveBits']) {
    const r = classifyWindowClasses(cls, [])
    expect(r.framework).toBe('self-drawn')
    expect(r.selfDrawn).toBeTrue()
    expect(r.chromium).toBeFalse()
    expect(r.mouseNeedsRealInput).toBeTrue()
    expect(r.matchedClass).toBe(cls)
  }
})

test('classifies other self-drawn engines', () => {
  expectReal('self-drawn', 'SDL_app')
  expectReal('self-drawn', 'GLFW30')
  expectReal('self-drawn', 'UnityWndClass')
  expectReal('self-drawn', 'SunAwtFrame')
  expectReal('self-drawn', 'SomeApp', ['SunAwtDialog'], 'SunAwtDialog')
})

test('classifies Chromium windows via top-level or child classes', () => {
  const top = classifyWindowClasses('Chrome_WidgetWin_1', [])
  expect(top.framework).toBe('chromium')
  expect(top.chromium).toBeTrue()
  expect(top.mouseNeedsRealInput).toBeTrue()

  const child = classifyWindowClasses('Main', ['Chrome_RenderWidgetHostHWND'])
  expect(child.framework).toBe('chromium')
  expect(child.chromium).toBeTrue()

  // Chromium wins over self-drawn if both somehow match.
  const both = classifyWindowClasses('Chrome_WidgetWin_1', ['Qt6QWindowIcon'])
  expect(both.framework).toBe('chromium')
  expect(both.chromium).toBeTrue()
  expect(both.selfDrawn).toBeFalse()
})

test('classifies WPF HwndWrapper windows (AnyCast case)', () => {
  const cls = 'HwndWrapper[Anycast.exe;;708a2617-887b-467d-9bd3-962631470a87]'
  const r = classifyWindowClasses(cls, [])
  expect(r.framework).toBe('wpf')
  expect(r.mouseNeedsRealInput).toBeTrue()
  expect(r.keyboardNeedsRealInput).toBeTrue()
  expect(r.winForms).toBeFalse()
  expect(r.chromium).toBeFalse()
  expect(r.matchedClass).toBe(cls)
})

test('classifies WPF child HwndWrapper under a native host', () => {
  const r = classifyWindowClasses('NativeHost', ['HwndWrapper[App.exe;;00000000-0000-0000-0000-000000000000]'])
  expect(r.framework).toBe('wpf')
  expect(r.mouseNeedsRealInput).toBeTrue()
})

test('classifies WinUI 3 and UWP window classes', () => {
  expectReal('winui', 'WinUIDesktopWin32WindowClass')
  expectReal('winui', 'ApplicationFrameWindow')
  expectReal('winui', 'Windows.UI.Core.CoreWindow')
  expectReal('winui', 'WinUIDesktopWin32WindowClass', ['Microsoft.UI.Content.DesktopChildSiteBridge'])
})

test('classifies WinForms top-level windows', () => {
  const r = classifyWindowClasses('WindowsForms10.Window.8.app.0.34f5582_r7_ad1', [])
  expect(r.framework).toBe('winforms')
  expect(r.winForms).toBeTrue()
  expect(r.mouseNeedsRealInput).toBeTrue()
  expect(r.keyboardNeedsRealInput).toBeTrue()
})

test('WinForms marker on a child alone stays with the native host rule', () => {
  // Child controls are common in native hosts; only the top-level marker is
  // decisive. The unknown top-level keeps the non-intrusive channel.
  const r = classifyWindowClasses('SomeHost', ['WindowsForms10.Window.8.app.0.1'])
  expect(r.framework).toBe('standard')
  expect(r.mouseNeedsRealInput).toBeFalse()
})

test('classifies JavaFX, Flutter, Unreal and Tk windows', () => {
  expectReal('javafx', 'GlassWndClass-GlassWindowClass-3')
  expectReal('flutter', 'FLUTTERVIEW')
  expectReal('unreal', 'UnrealWindow')
  expectReal('tk', 'TkTopLevel')
  expectReal('tk', 'TkChild')
})

test('qt prefix alone does not over-match unrelated apps', () => {
  expect(classifyWindowClasses('QtzViewer', []).framework).toBe('standard')
  expect(classifyWindowClasses('QTAudioBar', []).framework).toBe('standard')
})

test('standard USER windows stay on the SendMessage channel', () => {
  const r = classifyWindowClasses('Notepad', ['Edit', 'RichEditD2DPT'])
  expect(r.framework).toBe('standard')
  expect(r.mouseNeedsRealInput).toBeFalse()
  expect(r.keyboardNeedsRealInput).toBeFalse()
  expect(r.matchedClass).toBeNull()
})

test('unknown framework markers do not over-match', () => {
  for (const cls of ['Avalonia.Win32.WindowImpl', 'HwndHost', 'FLUTTERVIEW_HOST', 'UnrealWindowChild']) {
    expect(classifyWindowClasses(cls, []).framework).toBe('standard')
  }
})

test('classification is case-insensitive', () => {
  expect(classifyWindowClasses('qt6qwindowicon', []).framework).toBe('self-drawn')
  expect(classifyWindowClasses('SDL_APP', []).framework).toBe('self-drawn')
  expect(classifyWindowClasses('hwndwrapper[anycast.exe;;x]', []).framework).toBe('wpf')
  expect(classifyWindowClasses('flutterview', []).framework).toBe('flutter')
})

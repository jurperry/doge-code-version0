import { expect, test } from 'bun:test'
import { classifyWindowClasses } from './windowClassify.js'

test('classifies Qt windows as self-drawn (Android emulator case)', () => {
  // Qt top-level class carries the version: Qt5152QWindowIcon / Qt6QWindowIcon…
  for (const cls of ['Qt5152QWindowIcon', 'Qt6QWindowIcon', 'Qt671QWindowToolSaveBits']) {
    const r = classifyWindowClasses(cls, [])
    expect(r.selfDrawn).toBeTrue()
    expect(r.chromium).toBeFalse()
    expect(r.matchedClass).toBe(cls)
  }
})

test('classifies other self-drawn engines', () => {
  expect(classifyWindowClasses('SDL_app', []).selfDrawn).toBeTrue()
  expect(classifyWindowClasses('GLFW30', []).selfDrawn).toBeTrue()
  expect(classifyWindowClasses('UnityWndClass', []).selfDrawn).toBeTrue()
  expect(classifyWindowClasses('SunAwtFrame', []).selfDrawn).toBeTrue()
  expect(classifyWindowClasses('SomeApp', ['SunAwtDialog']).selfDrawn).toBeTrue()
})

test('classifies Chromium windows via top-level or child classes', () => {
  expect(classifyWindowClasses('Chrome_WidgetWin_1', []).chromium).toBeTrue()
  expect(classifyWindowClasses('Main', ['Chrome_RenderWidgetHostHWND']).chromium).toBeTrue()
  // Chromium wins over self-drawn if both somehow match
  const both = classifyWindowClasses('Chrome_WidgetWin_1', ['Qt6QWindowIcon'])
  expect(both.chromium).toBeTrue()
  expect(both.selfDrawn).toBeFalse()
})

test('qt prefix alone does not over-match unrelated apps', () => {
  expect(classifyWindowClasses('QtzViewer', []).selfDrawn).toBeFalse()
  expect(classifyWindowClasses('QTAudioBar', []).selfDrawn).toBeFalse()
})

test('standard USER windows stay on the SendMessage channel', () => {
  const r = classifyWindowClasses('Notepad', ['Edit', 'RichEditD2DPT'])
  expect(r.chromium).toBeFalse()
  expect(r.selfDrawn).toBeFalse()
  expect(r.matchedClass).toBeNull()
})

test('classification is case-insensitive', () => {
  expect(classifyWindowClasses('qt6qwindowicon', []).selfDrawn).toBeTrue()
  expect(classifyWindowClasses('SDL_APP', []).selfDrawn).toBeTrue()
})

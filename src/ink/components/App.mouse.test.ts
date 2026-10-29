import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import type { ParsedMouse } from '../parse-keypress.js'
import { createSelectionState, startSelection } from '../selection.js'
import { FOCUS_OUT } from '../termio/csi.js'
import App, { handleMouseEvent } from './App.js'

const oldMouseClicksDisabled = process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
beforeEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
})
afterAll(() => {
  if (oldMouseClicksDisabled === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
  } else {
    process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS = oldMouseClicksDisabled
  }
})

function createHarness(consumed = { down: false, move: false, up: false }) {
  const selection = createSelectionState()
  const props = {
    selection,
    stdout: { write: mock(() => {}) },
    onSelectionChange: mock(() => {}),
    onClickAt: mock((_col: number, _row: number) => false),
    onMouseDownAt: mock((_col: number, _row: number, _button: number) => consumed.down),
    onMouseMoveAt: mock((_col: number, _row: number, _button: number) => consumed.move),
    onMouseUpAt: mock((_col: number, _row: number, _button: number) => consumed.up),
    onMouseCancel: mock(() => {}),
    onHoverAt: mock((_col: number, _row: number) => {}),
    getHyperlinkAt: mock((_col: number, _row: number) => undefined),
    onOpenHyperlink: mock((_url: string) => {}),
    onMultiClick: mock((_col: number, _row: number, _count: 2 | 3) => {}),
    onSelectionDrag: mock((_col: number, _row: number) => {}),
  }
  const app = new App(props as any)
  return { app, selection, props }
}

function mouse(action: 'press' | 'release', button: number, col = 6, row = 8): ParsedMouse {
  return { kind: 'mouse', action, button, col, row, sequence: '' }
}

test('consumed gestures never start selection, multi-click, drag, click, or hyperlink handling', () => {
  const { app, selection, props } = createHarness({ down: true, move: true, up: true })

  handleMouseEvent(app, mouse('press', 0))
  handleMouseEvent(app, mouse('press', 0))
  handleMouseEvent(app, mouse('press', 32, 8, 10))
  handleMouseEvent(app, mouse('release', 0, 8, 10))

  expect(props.onMouseDownAt).toHaveBeenNthCalledWith(1, 5, 7, 0)
  expect(props.onMouseDownAt).toHaveBeenNthCalledWith(2, 5, 7, 0)
  expect(props.onMouseMoveAt).toHaveBeenCalledWith(7, 9, 32)
  expect(props.onMouseUpAt).toHaveBeenCalledWith(7, 9, 0)
  expect(selection.anchor).toBeNull()
  expect(selection.isDragging).toBe(false)
  expect(props.onSelectionChange).not.toHaveBeenCalled()
  expect(props.onMultiClick).not.toHaveBeenCalled()
  expect(props.onSelectionDrag).not.toHaveBeenCalled()
  expect(props.onClickAt).not.toHaveBeenCalled()
  expect(props.getHyperlinkAt).not.toHaveBeenCalled()
})

test('uncaptured press and release preserve selection and click behavior', () => {
  const { app, selection, props } = createHarness()

  handleMouseEvent(app, mouse('press', 0))
  expect(selection.anchor).toEqual({ col: 5, row: 7 })
  expect(selection.isDragging).toBe(true)
  expect(props.onSelectionChange).toHaveBeenCalledTimes(1)

  handleMouseEvent(app, mouse('release', 0))
  expect(selection.isDragging).toBe(false)
  expect(props.onClickAt).toHaveBeenCalledWith(5, 7)
  expect(props.getHyperlinkAt).toHaveBeenCalledWith(5, 7)
  expect(props.onSelectionChange).toHaveBeenCalledTimes(2)
})

test('uncaptured drag still uses the existing selection-drag path', () => {
  const { app, props } = createHarness()

  handleMouseEvent(app, mouse('press', 0))
  handleMouseEvent(app, mouse('press', 32, 8, 10))

  expect(props.onMouseMoveAt).toHaveBeenCalledWith(7, 9, 32)
  expect(props.onSelectionDrag).toHaveBeenCalledWith(7, 9)
})

test('no-button motion cancels capture and retains lost-release and hover behavior', () => {
  const { app, selection, props } = createHarness()
  startSelection(selection, 5, 7)

  handleMouseEvent(app, mouse('press', 35, 3, 4))

  expect(props.onMouseCancel).toHaveBeenCalledTimes(1)
  expect(selection.isDragging).toBe(false)
  expect(props.onSelectionChange).toHaveBeenCalledTimes(1)
  expect(props.onHoverAt).toHaveBeenCalledWith(2, 3)
})

test('terminal blur cancels capture and finishes an existing selection', () => {
  const { app, selection, props } = createHarness()
  startSelection(selection, 5, 7)

  app.processInput(FOCUS_OUT)

  expect(props.onMouseCancel).toHaveBeenCalledTimes(1)
  expect(selection.isDragging).toBe(false)
  expect(props.onSelectionChange).toHaveBeenCalledTimes(1)
})

test('a captured press breaks the multi-click chain', () => {
  const consumed = { down: false, move: false, up: false }
  const { app, props } = createHarness(consumed)

  handleMouseEvent(app, mouse('press', 0))
  handleMouseEvent(app, mouse('release', 0))
  expect(props.onClickAt).toHaveBeenCalledTimes(1)

  consumed.down = true
  handleMouseEvent(app, mouse('press', 0))
  consumed.down = false
  handleMouseEvent(app, mouse('press', 0))
  handleMouseEvent(app, mouse('release', 0))

  expect(props.onMultiClick).not.toHaveBeenCalled()
  expect(props.onClickAt).toHaveBeenCalledTimes(2)
})

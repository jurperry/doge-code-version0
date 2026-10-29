import { expect, mock, test } from 'bun:test'
import { createNode, type DOMElement } from '../dom.js'
import Ink from '../ink.js'
import { nodeCache } from '../node-cache.js'
import type { MouseEvent } from './mouse-event.js'

function addNode(
  parent: DOMElement,
  rect: { x: number; y: number; width: number; height: number },
): DOMElement {
  const node = createNode('ink-box')
  node.parentNode = parent
  parent.childNodes.push(node)
  nodeCache.set(node, rect)
  return node
}

function createInk() {
  const ink = Object.create(Ink.prototype) as any
  ink.rootNode = createNode('ink-root')
  nodeCache.set(ink.rootNode, { x: 0, y: 0, width: 80, height: 100 })
  ink.altScreenActive = true
  ink.altScreenMouseTracking = true
  ink.mouseCapture = null
  return ink
}

function record(events: Array<Record<string, unknown>>, name: string) {
  return (event: MouseEvent) => {
    events.push({
      name,
      type: event.type,
      target: event.target,
      currentTarget: event.currentTarget,
      col: event.col,
      row: event.row,
      button: event.button,
      localCol: event.localCol,
      localRow: event.localRow,
    })
  }
}

test('mousedown only captures when a handler prevents default', () => {
  const ink = createInk()
  const child = addNode(ink.rootNode, { x: 10, y: 20, width: 4, height: 4 })
  const events: Array<Record<string, unknown>> = []
  child._eventHandlers = {
    onMouseDown: record(events, 'child'),
    onMouseMove: record(events, 'move'),
  }

  expect(ink.dispatchMouseDown(11, 21, 0)).toBe(false)
  expect(ink.dispatchMouseMove(12, 22, 32)).toBe(false)
  expect(ink.dispatchMouseUp(12, 22, 0)).toBe(false)
  expect(events.map(event => event.type)).toEqual(['mousedown'])
})

test('captured drag and release retain the target and recompute local coordinates', () => {
  const ink = createInk()
  const parent = addNode(ink.rootNode, { x: 10, y: 20, width: 10, height: 10 })
  const child = addNode(parent, { x: 12, y: 23, width: 4, height: 4 })
  const events: Array<Record<string, unknown>> = []
  child._eventHandlers = {
    onMouseDown: (event: MouseEvent) => {
      record(events, 'child')(event)
      event.preventDefault()
    },
    onMouseMove: record(events, 'child'),
    onMouseUp: record(events, 'child'),
  }
  parent._eventHandlers = {
    onMouseDown: record(events, 'parent'),
    onMouseMove: record(events, 'parent'),
    onMouseUp: record(events, 'parent'),
  }

  expect(ink.dispatchMouseDown(15, 26, 8)).toBe(true)
  expect(events).toMatchObject([
    { type: 'mousedown', currentTarget: child, col: 15, row: 26, button: 8, localCol: 3, localRow: 3 },
    { type: 'mousedown', currentTarget: parent, col: 15, row: 26, button: 8, localCol: 5, localRow: 6 },
  ])

  expect(ink.dispatchMouseMove(30, 40, 40)).toBe(true)
  expect(events.slice(2)).toMatchObject([
    { type: 'mousemove', target: child, currentTarget: child, col: 30, row: 40, button: 40, localCol: 18, localRow: 17 },
    { type: 'mousemove', target: child, currentTarget: parent, col: 30, row: 40, button: 40, localCol: 20, localRow: 20 },
  ])

  expect(ink.dispatchMouseUp(31, 41, 0)).toBe(true)
  expect(events.slice(4)).toMatchObject([
    { type: 'mouseup', target: child, currentTarget: child, localCol: 19, localRow: 18 },
    { type: 'mouseup', target: child, currentTarget: parent, localCol: 21, localRow: 21 },
  ])
  expect(ink.dispatchMouseMove(32, 42, 32)).toBe(false)
  expect(ink.dispatchMouseUp(32, 42, 0)).toBe(false)
})

test('cancel notifies the captured node and a new press replaces old capture', () => {
  const ink = createInk()
  const child = addNode(ink.rootNode, { x: 10, y: 20, width: 4, height: 4 })
  const events: Array<Record<string, unknown>> = []
  child._eventHandlers = {
    onMouseDown: (event: MouseEvent) => {
      record(events, 'down')(event)
      event.preventDefault()
    },
    onMouseMove: record(events, 'move'),
    onMouseCancel: record(events, 'cancel'),
  }

  expect(ink.dispatchMouseDown(11, 21, 0)).toBe(true)
  expect(ink.dispatchMouseDown(12, 22, 4)).toBe(true)
  expect(events.map(event => event.type)).toEqual(['mousedown', 'mousecancel', 'mousedown'])
  expect(events[1]).toMatchObject({ col: 11, row: 21, button: 0, localCol: 1, localRow: 1 })

  ink.cancelMouseCapture()
  expect(events.at(-1)).toMatchObject({ type: 'mousecancel', col: 12, row: 22, button: 4 })
  expect(ink.dispatchMouseMove(13, 23, 32)).toBe(false)
})

test('alt-screen exit cancels capture and detached targets are discarded safely', () => {
  const ink = createInk()
  ink.repaint = mock(() => {})
  const child = addNode(ink.rootNode, { x: 10, y: 20, width: 4, height: 4 })
  const onMouseMove = mock(() => {})
  const onMouseCancel = mock(() => {})
  child._eventHandlers = {
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
    onMouseMove,
    onMouseCancel,
  }

  expect(ink.dispatchMouseDown(11, 21, 0)).toBe(true)
  ink.setAltScreenActive(false)
  expect(onMouseCancel).toHaveBeenCalledTimes(1)
  expect(ink.dispatchMouseUp(11, 21, 0)).toBe(false)

  ink.altScreenActive = true
  expect(ink.dispatchMouseDown(11, 21, 0)).toBe(true)
  child.parentNode = undefined
  expect(ink.dispatchMouseMove(30, 40, 32)).toBe(true)
  expect(onMouseMove).not.toHaveBeenCalled()
  expect(ink.dispatchMouseUp(30, 40, 0)).toBe(false)
})

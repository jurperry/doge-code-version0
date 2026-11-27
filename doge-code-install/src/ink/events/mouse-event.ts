import type { DOMElement } from '../dom.js'
import { nodeCache } from '../node-cache.js'
import { TerminalEvent, type EventTarget } from './terminal-event.js'

export type MouseEventType =
  | 'mousedown'
  | 'mousemove'
  | 'mouseup'
  | 'mousecancel'

export class MouseEvent extends TerminalEvent {
  readonly col: number
  readonly row: number
  readonly button: number
  localCol = 0
  localRow = 0

  constructor(type: MouseEventType, col: number, row: number, button: number) {
    super(type)
    this.col = col
    this.row = row
    this.button = button
  }

  override _prepareForTarget(target: EventTarget): void {
    const rect = nodeCache.get(target as DOMElement)
    this.localCol = rect ? this.col - rect.x : this.col
    this.localRow = rect ? this.row - rect.y : this.row
  }
}

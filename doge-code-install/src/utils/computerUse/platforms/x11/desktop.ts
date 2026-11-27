import { readFile, realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { sleep } from '../../../sleep.js'
import {
  reply, withX11, type X11Display, type X11Geometry, type X11Image,
  type X11Input, type X11Pointer, type X11Property, type X11Screen, type X11Shape,
} from './connection.js'

const ATOM = { cardinal: 6, string: 31, window: 33 }
const VIEWABLE = 2
const INPUT_OUTPUT = 1
const GRAB_SUCCESS = 0
const GRAB_ASYNC = 1
const CURRENT_TIME = 0
const EVENT = { keyDown: 2, keyUp: 3, buttonDown: 4, buttonUp: 5, motion: 6 }

const KEY_SYMBOLS: Readonly<Record<string, number>> = {
  ctrl: 0xffe3, control: 0xffe3, alt: 0xffe9, shift: 0xffe1,
  meta: 0xffeb, super: 0xffeb, win: 0xffeb,
  backspace: 0xff08, tab: 0xff09, enter: 0xff0d, return: 0xff0d,
  esc: 0xff1b, escape: 0xff1b, delete: 0xffff, space: 0x20,
  home: 0xff50, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
  pageup: 0xff55, pagedown: 0xff56, end: 0xff57,
}

export type X11Rect = { x: number; y: number; width: number; height: number }
type Geometry = X11Rect & { borderWidth: number }

export type X11Window = {
  id: number
  bundleId: string
  displayName: string
  path: string
  pid: number
  geometry: Geometry
}

export type X11Pixels = { data: Buffer; width: number; height: number }
type Point = { x: number; y: number }
type Input = { point?: Point; keys?: readonly string[]; buttons?: readonly number[] }

function keysym(key: string): number {
  const name = key.toLowerCase()
  const functionKey = /^f([1-9]|1\d|2[0-4])$/.exec(name)
  if (functionKey) return 0xffbd + Number(functionKey[1])
  if (/^[a-z0-9]$/.test(name)) return name.charCodeAt(0)
  if (Object.hasOwn(KEY_SYMBOLS, name)) return KEY_SYMBOLS[name]!
  throw new Error(`Unsupported X11 key: ${key}`)
}

function contains(outer: X11Rect, inner: X11Rect): boolean {
  return inner.width > 0 && inner.height > 0 &&
    outer.x <= inner.x && outer.y <= inner.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
}

class X11Desktop {
  private readonly client: X11Display['client']
  private readonly root: number

  constructor(private readonly display: X11Display, private readonly screen: X11Screen) {
    this.client = display.client
    this.root = screen.root
  }

  async assertNative(): Promise<void> {
    const xwayland = await reply<{ present: boolean }>(cb => this.client.QueryExtension('XWAYLAND', cb))
    if (xwayland.present) throw new Error('A native X11 display is required.')
  }

  async probe(): Promise<boolean> {
    const xtest = await reply<{ present: boolean }>(cb => this.client.QueryExtension('XTEST', cb))
    const wmAtom = await this.atom('_NET_SUPPORTING_WM_CHECK')
    const [wm] = await this.windowIds(this.root, wmAtom)
    return xtest.present && !!wm && (await this.windowIds(wm, wmAtom))[0] === wm
  }

  private atom(name: string): Promise<number> {
    return reply(cb => this.client.InternAtom(false, name, cb))
  }

  private property(id: number, name: number, type: number, length: number): Promise<X11Property> {
    return reply(cb => this.client.GetProperty(0, id, name, type, 0, length, cb))
  }

  private async cardinals(id: number, name: number, type: number, limit: number): Promise<number[]> {
    const value = await this.property(id, name, type, limit)
    if (value.type !== type || value.format !== 32 || value.bytesAfter || value.data.length % 4) return []
    return Array.from({ length: value.data.length / 4 }, (_, index) =>
      this.display.byte_order === 0 ? value.data.readUInt32LE(index * 4) : value.data.readUInt32BE(index * 4))
  }

  private windowIds(id: number, name: number): Promise<number[]> {
    return this.cardinals(id, name, ATOM.window, 4096)
  }

  private async clients(): Promise<Set<number>> {
    return new Set(await this.windowIds(this.root, await this.atom('_NET_CLIENT_LIST')))
  }

  private tree(id: number): Promise<{ parent: number; children: number[] }> {
    return reply(cb => this.client.QueryTree(id, cb))
  }

  private attributes(id: number): Promise<{ mapState: number; klass: number }> {
    return reply(cb => this.client.GetWindowAttributes(id, cb))
  }

  private async geometry(id: number): Promise<Geometry> {
    const [size, origin] = await Promise.all([
      reply<X11Geometry>(cb => this.client.GetGeometry(id, cb)),
      reply<{ destX: number; destY: number }>(cb => this.client.TranslateCoordinates(id, this.root, 0, 0, cb)),
    ])
    return { x: origin.destX, y: origin.destY, width: size.width, height: size.height, borderWidth: size.borderWidth }
  }

  private async inspect(id: number | undefined): Promise<X11Window | null> {
    if (!id || (await this.attributes(id)).mapState !== VIEWABLE) return null
    const [pid] = await this.cardinals(id, await this.atom('_NET_WM_PID'), ATOM.cardinal, 1)
    if (!pid) return null

    let executable: string
    let startTime: string | undefined
    try {
      executable = await realpath(`/proc/${pid}/exe`)
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      // Fields after the parenthesized command start at field 3. The process
      // start tick is field 22, independent of spaces or ')' in the command.
      startTime = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]
    } catch {
      return null
    }
    if (!startTime || !/^\d+$/.test(startTime)) return null

    const [nameAtom, utf8] = await Promise.all([this.atom('_NET_WM_NAME'), this.atom('UTF8_STRING')])
    const title = await this.property(id, nameAtom, utf8, 128)
    const legacyTitle = !title.data.length ? await this.property(id, await this.atom('WM_NAME'), ATOM.string, 128) : undefined
    const label = (title.data.toString('utf8') || legacyTitle?.data.toString('latin1') || basename(executable))
      .trim().replace(/\s+/g, ' ').slice(0, 120)
    return {
      id, pid, path: executable, geometry: await this.geometry(id),
      bundleId: `x11:${id}:${pid}:${startTime}`,
      displayName: `${label} (${basename(executable)}, X11 0x${id.toString(16)})`,
    }
  }

  async windows(): Promise<X11Window[]> {
    const windows: X11Window[] = []
    for (const id of await this.clients()) {
      try {
        const window = await this.inspect(id)
        if (window) windows.push(window)
      } catch (error) {
        // BadWindow is normal when a window closes during enumeration.
        if (!(error instanceof Error && (error as Error & { error: number }).error === 3)) throw error
      }
    }
    return windows
  }

  private async focusId(): Promise<number | undefined> {
    const { focus } = await reply<{ focus: number }>(cb => this.client.GetInputFocus(cb))
    if (focus <= 1) return undefined // None / PointerRoot.
    const clients = await this.clients()
    let id = focus
    while (id && id !== this.root) {
      if (clients.has(id)) return id
      id = (await this.tree(id)).parent
    }
  }

  async focus(): Promise<X11Window | null> {
    return this.inspect(await this.focusId())
  }

  private async hitId({ x, y }: Point): Promise<number | undefined> {
    const clients = await this.clients()
    let parent = this.root
    while (parent) {
      const { child } = await reply<{ child: number }>(
        cb => this.client.TranslateCoordinates(this.root, parent, x, y, cb))
      if (clients.has(child)) return child
      parent = child
    }
  }

  async hit(point: Point): Promise<X11Window | null> {
    return this.inspect(await this.hitId(point))
  }

  async cursor(): Promise<Point> {
    const pointer = await reply<X11Pointer>(cb => this.client.QueryPointer(this.root, cb))
    if (!pointer.sameScreen) throw new Error('The pointer is on another X11 screen.')
    return { x: pointer.rootX, y: pointer.rootY }
  }

  async clipboardOwner(): Promise<boolean> {
    const selection = await this.atom('CLIPBOARD')
    return !!await reply<number>(cb => this.client.GetSelectionOwner(selection, cb))
  }

  async activate(bundleId: string, signal?: AbortSignal): Promise<void> {
    const id = Number(/^x11:(\d+):\d+:\d+$/.exec(bundleId)?.[1])
    if (!(await this.clients()).has(id) || (await this.inspect(id))?.bundleId !== bundleId) {
      throw new Error('The authorized X11 window is no longer open.')
    }
    this.client.SendClientMessage(this.root, id, await this.atom('_NET_ACTIVE_WINDOW'), 32, [2, CURRENT_TIME, 0, 0, 0])
    for (let step = 0; step < 25; step++) {
      signal?.throwIfAborted()
      if (await this.focusId() === id) return
      await sleep(20, signal)
    }
    throw new Error('The X11 window manager did not focus the authorized window.')
  }

  private async withServerGrab<T>(operation: () => Promise<T>): Promise<T> {
    this.client.GrabServer()
    try {
      return await operation()
    } finally {
      if (!this.client.stream?.destroyed) {
        this.client.UngrabServer()
        await this.client.sync()
      }
    }
  }

  private async requireTarget(target: X11Window): Promise<void> {
    const current = await this.focus()
    const old = target.geometry
    const now = current?.geometry
    if (current?.bundleId !== target.bundleId || !now ||
        now.x !== old.x || now.y !== old.y || now.width !== old.width ||
        now.height !== old.height || now.borderWidth !== old.borderWidth) {
      throw new Error('The X11 window or its geometry changed. Focus the authorized window and take a new screenshot.')
    }
  }

  async sendInput(target: X11Window, action: Input): Promise<void> {
    const xtest = await reply<X11Input>(cb => this.client.require('xtest', cb))
    await this.withServerGrab(async () => {
      await this.requireTarget(target)
      const { point, buttons = [] } = action
      if (point) {
        const position = { ...point, width: 1, height: 1 }
        if (!contains(await this.geometry(this.root), position) || !contains(target.geometry, position)) {
          throw new Error('The coordinates are outside the authorized X11 window.')
        }
        if (await this.hitId(point) !== target.id) {
          throw new Error('Another window covers these coordinates. No input was sent.')
        }
      }

      const symbols = (action.keys ?? []).map(keysym)
      const codes = symbols.length ? await this.keycodes(symbols) : []
      if (codes.length) {
        const status = await reply<number>(cb => this.client.GrabKeyboard(this.root, 0, CURRENT_TIME, GRAB_ASYNC, GRAB_ASYNC, cb))
        if (status !== GRAB_SUCCESS) throw new Error('Another client has grabbed the keyboard. No input was sent.')
        this.client.UngrabKeyboard(CURRENT_TIME)
      }
      if (point) {
        const status = await reply<number>(
          cb => this.client.GrabPointer(this.root, 0, 0, GRAB_ASYNC, GRAB_ASYNC, 0, 0, CURRENT_TIME, cb))
        if (status !== GRAB_SUCCESS) throw new Error('Another client has grabbed the pointer. No input was sent.')
        this.client.UngrabPointer(CURRENT_TIME)
        xtest.FakeInput(EVENT.motion, 0, CURRENT_TIME, this.root, point.x, point.y)
        const actual = await this.cursor()
        if (actual.x !== point.x || actual.y !== point.y) {
          throw new Error('The X11 pointer could not reach the target. No click or scroll was sent.')
        }
      }
      for (const code of codes) xtest.FakeInput(EVENT.keyDown, code, CURRENT_TIME, 0, 0, 0)
      for (const button of buttons) {
        xtest.FakeInput(EVENT.buttonDown, button, CURRENT_TIME, 0, 0, 0)
        xtest.FakeInput(EVENT.buttonUp, button, CURRENT_TIME, 0, 0, 0)
      }
      for (const code of codes.reverse()) xtest.FakeInput(EVENT.keyUp, code, CURRENT_TIME, 0, 0, 0)
    })
  }

  private async keycodes(symbols: number[]): Promise<number[]> {
    const start = this.display.min_keycode
    const rows = await reply<number[][]>(
      cb => this.client.GetKeyboardMapping(start, this.display.max_keycode - start + 1, cb))
    return symbols.map(symbol => {
      const row = rows.findIndex(values => values.includes(symbol))
      if (row === -1) throw new Error(`The current X11 keyboard map does not provide keysym 0x${symbol.toString(16)}.`)
      return row + start
    })
  }

  async capture(target: X11Window, requested?: X11Rect): Promise<X11Pixels> {
    const { x, y, width, height } = target.geometry
    const region = requested ?? { x: 0, y: 0, width, height }
    if (!contains({ x: 0, y: 0, width, height }, region)) {
      throw new Error('The zoom region is outside the authorized X11 window.')
    }
    if (region.width * region.height > 16_777_216) throw new Error('The X11 capture is too large.')
    return this.withServerGrab(async () => {
      await this.requireTarget(target)
      await this.assertVisible(target.id, { ...region, x: x + region.x, y: y + region.y })
      const image = await reply<X11Image>(cb =>
        this.client.GetImage(2, target.id, region.x, region.y, region.width, region.height, 0xffffffff, cb))
      const visual = this.screen.depths[image.depth]?.[image.visualId]
      if (this.display.image_byte_order !== 0 || !visual ||
          (image.depth !== 24 && image.depth !== 32) ||
          visual.red_mask !== 0xff0000 || visual.green_mask !== 0xff00 || visual.blue_mask !== 0xff ||
          image.data.length !== region.width * region.height * 4) {
        throw new Error('This X11 pixel format is unsupported.')
      }
      return { data: image.data, width: region.width, height: region.height }
    })
  }

  private async assertVisible(id: number, region: X11Rect): Promise<void> {
    if (!contains(await this.geometry(this.root), region)) {
      throw new Error('The X11 capture region is partially off screen.')
    }
    const shapePresent = await reply<{ present: boolean }>(cb => this.client.QueryExtension('SHAPE', cb))
    const shape = shapePresent.present
      ? await reply<X11Shape>(cb => this.client.require('shape', cb)) : undefined

    // GetImage can read obscuring pixels. Check every ancestor and all mapped
    // siblings above it (including unmanaged popups) while the server is grabbed.
    let child = id
    while (child !== this.root) {
      if (shape) {
        const extents = await reply<{ boundingShaped: boolean; clipShaped: boolean }>(cb => shape.QueryExtents(child, cb))
        if (extents.boundingShaped || extents.clipShaped) {
          throw new Error('The X11 capture region belongs to a nonrectangular window.')
        }
      }
      if (!contains(await this.geometry(child), region)) {
        throw new Error('An X11 parent window clips the capture region.')
      }
      const { parent } = await this.tree(child)
      const { children } = await this.tree(parent)
      const index = children.indexOf(child)
      if (index < 0) throw new Error('The X11 window stacking order could not be verified.')
      for (const sibling of children.slice(index + 1)) {
        const attributes = await this.attributes(sibling)
        if (attributes.mapState !== VIEWABLE || attributes.klass !== INPUT_OUTPUT) continue
        const { x, y, width, height, borderWidth } = await this.geometry(sibling)
        if (region.x < x + width + borderWidth && x - borderWidth < region.x + region.width &&
            region.y < y + height + borderWidth && y - borderWidth < region.y + region.height) {
          throw new Error('Another window covers the X11 capture region. Uncover the authorized window and retry.')
        }
      }
      child = parent
    }
  }
}

export function withX11Desktop<T>(operation: (desktop: X11Desktop) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withX11(async (display, screen) => {
    const desktop = new X11Desktop(display, screen)
    await desktop.assertNative()
    return operation(desktop)
  }, signal)
}

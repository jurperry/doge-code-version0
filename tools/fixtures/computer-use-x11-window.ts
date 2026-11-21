import assert from 'node:assert/strict'
import { rename, writeFile } from 'node:fs/promises'
import x11 from 'x11'
import { reply, withX11, type X11Client, type X11Display, type X11Property, type X11Reply, type X11Shape } from '../../src/utils/computerUse/platforms/x11/connection.js'

interface FixtureClient extends X11Client {
  AllocID(): number
  CreateWindow(id: number, parent: number, x: number, y: number, width: number, height: number,
    border: number, depth: number, klass: number, visual: number, options: Record<string, number>): void
  MapWindow(id: number): void
  ChangeProperty(mode: number, id: number, property: number, type: number, format: number, data: Buffer | number[]): void
  ConvertSelection(id: number, selection: number, target: number, property: number, time: number): void
}

interface FixtureShape extends X11Shape {
  Rectangles(operation: number, kind: number, id: number, x: number, y: number, rectangles: number[][]): void
  Mask(operation: number, kind: number, id: number, x: number, y: number, pixmap: number): void
}

type FixtureEvent = {
  type: number
  wid: number
  keycode: number
  buttons: number
  x: number
  y: number
  time: number
  requestor: number
  property: number
}

export async function setFixtureShape(id: number, shaped: boolean): Promise<void> {
  await withX11(async ({ client }) => {
    const shape = await reply<X11Shape>(cb => client.require('shape', cb)) as FixtureShape
    if (shaped) shape.Rectangles(0, 0, id, 0, 0, [[0, 0, 250, 230]])
    else shape.Mask(0, 0, id, 0, 0, 0)
    await client.sync()
  })
}

async function fixtureWindow(
  display: X11Display,
  name: string,
  color: number,
  geom: string,
  statePath: string,
  topmost: boolean,
): Promise<void> {
  const client = display.client as FixtureClient
  const id = client.AllocID()
  const [width, height, x, y] = geom.match(/\d+/g)!.map(Number)
  const atom = (name: string) => reply<number>(cb => client.InternAtom(false, name, cb))
  const [pid, title, utf8, selection, dataAtom, wmState, above] = await Promise.all([
    atom('_NET_WM_PID'), atom('_NET_WM_NAME'), atom('UTF8_STRING'), atom('CLIPBOARD'),
    atom('DOGE_FIXTURE_PASTE'), atom('_NET_WM_STATE'), atom('_NET_WM_STATE_ABOVE'),
  ])
  const minKeycode = display.min_keycode
  const keymap = await reply<number[][]>(
    cb => client.GetKeyboardMapping(minKeycode, display.max_keycode - minKeycode + 1, cb))
  let text = ''
  let clicks = 0
  let editing = false

  async function save(): Promise<void> {
    await writeFile(statePath + '.tmp', JSON.stringify({ id, clicks, text }))
    await rename(statePath + '.tmp', statePath)
  }
  async function handleEvent(event: FixtureEvent): Promise<void> {
    if (event.type === 4 && event.wid === id) { // ButtonPress
      if (event.x >= 20 && event.x < 145 && event.y >= 22 && event.y < 62) clicks++
      editing = event.x >= 20 && event.x < 170 && event.y >= 92 && event.y < 124
      await save()
    }
    if (event.type === 2 && event.wid === id && editing) { // KeyPress
      const keysym = keymap[event.keycode - minKeycode]?.[0]
      if (keysym === 0x76 && (event.buttons & 4)) {
        client.ConvertSelection(id, selection, utf8, dataAtom, event.time)
      } else if (keysym === 0xff08) {
        text = Array.from(text).slice(0, -1).join('')
        await save()
      }
    }
    if (event.type === 31 && event.requestor === id && event.property === dataAtom) { // SelectionNotify
      const value = await reply<X11Property>(cb => client.GetProperty(1, id, dataAtom, utf8, 0, 4096, cb))
      text += value.data.toString('utf8')
      await save()
    }
  }

  let events = Promise.resolve()
  client.on('event', (event: FixtureEvent) => {
    events = events.then(() => handleEvent(event)).catch(error => {
      console.error(error)
      process.exit(1)
    })
  })
  client.CreateWindow(id, display.screen[0]!.root, x!, y!, width!, height!, 0, 0, 0, 0, {
    backgroundPixel: color, eventMask: (1 << 0) | (1 << 2), // KeyPress | ButtonPress.
  })
  client.ChangeProperty(0, id, pid, 6, 32, [process.pid])
  client.ChangeProperty(0, id, title, utf8, 8, Buffer.from(name))
  client.ChangeProperty(0, id, 39, 31, 8, Buffer.from(name)) // WM_NAME / STRING
  // ICCCM WM_NORMAL_HINTS / WM_SIZE_HINTS with the USPosition flag.
  client.ChangeProperty(0, id, 40, 41, 32, [1, x!, y!, width!, height!, ...Array(13).fill(0)])
  if (topmost) client.ChangeProperty(0, id, wmState, 4, 32, [above])
  client.MapWindow(id)
  await client.sync()
  await save()
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2)
  const display = await reply<X11Display>((cb: X11Reply<X11Display>) => {
    const client = x11.createClient({ disableBigRequests: true, shm: false }, cb)
    client.on('error', (error: Error) => {
      console.error(error)
      process.exit(1)
    })
  })
  if (mode === 'window') {
    const [name, color, geometry, path, topmost] = args
    await fixtureWindow(display, name!, Number(color), geometry!, path!, topmost === '1')
  } else {
    assert.equal(mode, 'grab')
    const client = display.client
    const root = display.screen[0]!.root
    assert.equal(await reply<number>(cb => client.GrabKeyboard(root, 0, 0, 1, 1, cb)), 0)
    assert.equal(await reply<number>(cb => client.GrabPointer(root, 0, 0, 1, 1, 0, 0, 0, cb)), 0)
    await writeFile(args[0]!, '')
  }
}

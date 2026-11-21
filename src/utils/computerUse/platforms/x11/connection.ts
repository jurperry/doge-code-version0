import type { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import type { Socket } from 'node:net'

export type X11Reply<T> = (error: Error | null, value: T) => boolean

export interface X11Property {
  type: number
  format: number
  bytesAfter: number
  data: Buffer
}

export interface X11Geometry {
  width: number
  height: number
  borderWidth: number
}

export interface X11Pointer {
  sameScreen: boolean
  rootX: number
  rootY: number
}

export interface X11Image {
  depth: number
  visualId: number
  data: Buffer
}

export interface X11Input {
  FakeInput(type: number, detail: number, time: number, root: number, x: number, y: number): void
}

export interface X11Shape {
  QueryExtents(id: number, cb: X11Reply<{ boundingShaped: boolean; clipShaped: boolean }>): void
}

// The published X11 client is JavaScript. Describe only the protocol calls
// used by the window backend, so payload and reply casts stay at this boundary.
export interface X11Client extends EventEmitter {
  stream?: Socket
  sync(): Promise<void>
  InternAtom(existingOnly: boolean, name: string, cb: X11Reply<number>): void
  GetProperty(remove: number, id: number, property: number, type: number, offset: number, length: number, cb: X11Reply<X11Property>): void
  QueryExtension(name: string, cb: X11Reply<{ present: boolean }>): void
  require(name: 'shape', cb: X11Reply<X11Shape>): void
  require(name: 'xtest', cb: X11Reply<X11Input>): void
  GetGeometry(id: number, cb: X11Reply<X11Geometry>): void
  QueryTree(id: number, cb: X11Reply<{ parent: number; children: number[] }>): void
  TranslateCoordinates(source: number, destination: number, x: number, y: number, cb: X11Reply<{ child: number; destX: number; destY: number }>): void
  GetWindowAttributes(id: number, cb: X11Reply<{ mapState: number; klass: number }>): void
  GetInputFocus(cb: X11Reply<{ focus: number }>): void
  QueryPointer(root: number, cb: X11Reply<X11Pointer>): void
  GetSelectionOwner(selection: number, cb: X11Reply<number>): void
  SendClientMessage(destination: number, id: number, atom: number, format: 32, data: number[]): void
  GrabServer(): void
  UngrabServer(): void
  GrabKeyboard(id: number, ownerEvents: number, time: number, pointerMode: number, keyboardMode: number, cb: X11Reply<number>): void
  UngrabKeyboard(time: number): void
  GrabPointer(id: number, ownerEvents: number, mask: number, pointerMode: number, keyboardMode: number, confineTo: number, cursor: number, time: number, cb: X11Reply<number>): void
  UngrabPointer(time: number): void
  GetKeyboardMapping(start: number, count: number, cb: X11Reply<number[][]>): void
  GetImage(format: number, id: number, x: number, y: number, width: number, height: number, mask: number, cb: X11Reply<X11Image>): void
}

export interface X11Screen {
  root: number
  depths: Record<number, Record<number, {
    red_mask: number
    green_mask: number
    blue_mask: number
  }>>
}

export interface X11Display {
  client: X11Client
  isLocalSocket: boolean
  byte_order: number
  image_byte_order: number
  min_keycode: number
  max_keycode: number
  screen: X11Screen[]
}

type X11Module = {
  createClient(options: { display: string; disableBigRequests: true; shm: false }, cb: X11Reply<X11Display>): X11Client
}

export function reply<T>(send: (cb: X11Reply<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => send((error, value) => {
    if (error) reject(error)
    else resolve(value)
    // The library also emits errors when a request handler does not consume them.
    return true
  }))
}

/**
 * Give each operation its own bounded connection. Destroying the socket also
 * releases server and device grabs if the X server stops replying.
 */
export async function withX11<T>(
  operation: (display: X11Display, screen: X11Screen) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  const match = /^(?:(?:unix|local)\/?)?:(\d{1,5})(?:\.(\d{1,3}))?$/.exec(process.env.DISPLAY ?? '')
  if (!match || process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
    throw new Error('A local native X11 display is required.')
  }
  const [, displayNumber, screenNumber = '0'] = match
  const socket = await stat(`/tmp/.X11-unix/X${displayNumber}`).catch(() => undefined)
  if (!socket?.isSocket()) throw new Error('The local X11 socket is unavailable.')

  const { default: x11 } = await import('x11') as { default: X11Module }
  const timeout = AbortSignal.timeout(5000)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  stop.throwIfAborted()
  let client: X11Client | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(stop.reason)
      stop.addEventListener('abort', onAbort, { once: true })
      client = x11.createClient({
        display: `unix/:${displayNumber}.${screenNumber}`, disableBigRequests: true, shm: false,
      }, (error, display) => {
        if (error) {
          reject(error)
        } else if (stop.aborted || !display.isLocalSocket) {
          display.client.stream?.destroy()
          reject(stop.aborted ? stop.reason : new Error('A local X11 socket is required.'))
        } else {
          const screen = display.screen[Number(screenNumber)]
          if (!screen) reject(new Error('The selected X11 screen does not exist.'))
          else operation(display, screen).then(resolve, reject)
        }
        return true
      })
      client.on('error', reject)
      client.once('end', () => reject(new Error('The X11 connection closed.')))
    })
  } finally {
    if (onAbort) stop.removeEventListener('abort', onAbort)
    client?.stream?.destroy()
  }
}

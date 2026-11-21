import { expect, test } from 'bun:test'
import { decode } from 'jpeg-js'
import { encodeX11Jpeg } from './image.js'

test('X11 screenshot encoding preserves color and fits the API size budget', () => {
  const pixels = { width: 32, height: 16, data: Buffer.alloc(32 * 16 * 4) }
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] = 25
    pixels.data[i + 1] = 40
    pixels.data[i + 2] = 215
  }
  const shot = encodeX11Jpeg(pixels, [16, 16])
  const image = decode(Buffer.from(shot.base64, 'base64'))
  expect([shot.width, shot.height, image.width, image.height]).toEqual([16, 8, 16, 8])
  expect(image.data[0]).toBeGreaterThan(200)
  expect(image.data[1]).toBeLessThan(55)
  expect(image.data[2]).toBeLessThan(40)
  expect(encodeX11Jpeg(pixels, [128, 128])).toMatchObject({ width: 32, height: 16 })
})

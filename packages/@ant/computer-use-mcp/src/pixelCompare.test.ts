import { describe, expect, test } from 'bun:test'

import { comparePixelAtLocation, validateClickTarget } from './pixelCompare.js'

const logger = { debug() {}, info() {}, warn() {}, error() {}, silly() {} }
const shot = (base64: string) => ({
  base64,
  width: 100,
  height: 100,
  displayWidth: 100,
  displayHeight: 100,
  originX: 0,
  originY: 0,
})

describe('PixelCompare unavailable and mismatch semantics', () => {
  test('null crop means genuinely skipped, not a changed target', async () => {
    expect(await comparePixelAtLocation(() => null, shot('last'), shot('fresh'), 50, 50)).toBeNull()
    expect(await validateClickTarget(
      () => null,
      shot('last'),
      50,
      50,
      async () => shot('fresh'),
      logger,
    )).toEqual({ valid: true, skipped: true })
  })

  test('identical and different raw buffers retain their real comparison result', async () => {
    const crop = (base64: string) => Buffer.from(base64)
    expect(await comparePixelAtLocation(crop, shot('same'), shot('same'), 50, 50)).toBe(true)
    expect(await comparePixelAtLocation(crop, shot('past'), shot('next'), 50, 50)).toBe(false)
    const mismatch = await validateClickTarget(crop, shot('past'), 50, 50, async () => shot('next'), logger)
    expect(mismatch.valid).toBe(false)
    expect(mismatch.skipped).toBe(false)
    expect(mismatch.warning).toContain('Take a new screenshot')
  })

  test('identical JPEG dimensions do not hide changes to underlying target geometry', async () => {
    const crop = () => Buffer.alloc(9, 100)
    const original = shot('same')
    const resized = { ...original, displayWidth: original.displayWidth * 2 }
    expect(await comparePixelAtLocation(crop, original, resized, 50, 50)).toBe(false)
  })

  test('cold start, fresh capture failure and crop exceptions all skip', async () => {
    expect(await validateClickTarget(() => null, undefined, 50, 50, async () => shot('fresh'), logger))
      .toEqual({ valid: true, skipped: true })
    expect(await validateClickTarget(() => null, shot('last'), 50, 50, async () => null, logger))
      .toEqual({ valid: true, skipped: true })
    expect(await validateClickTarget(() => { throw new Error('decode failed') }, shot('last'), 50, 50, async () => shot('fresh'), logger))
      .toEqual({ valid: true, skipped: true })
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isImageFilePath,
  resolvePastedImageLines,
  tryReadImageFromPath,
} from './imagePaste.js'

// 1x1 red pixel PNG (68 bytes), well under all size/dimension limits.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// PNG header declaring 3000x3000 with no pixel data: over the 2000px client
// dimension cap and undecodable by any image processor, so the resizer throws
// whether or not sharp / the native processor is installed.
function oversizedPngHeader(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(13, 0)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(3000, 0)
  ihdr.writeUInt32BE(3000, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([sig, len, Buffer.from('IHDR'), ihdr, Buffer.alloc(4)])
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doge-image-paste-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('tryReadImageFromPath', () => {
  test('oversized/unprocessable image resolves to null instead of rejecting', async () => {
    const path = join(dir, 'big.png')
    writeFileSync(path, oversizedPngHeader())
    await expect(tryReadImageFromPath(path)).resolves.toBeNull()
  })

  test('BMP image with no available processor resolves to null', async () => {
    const path = join(dir, 'shot.png')
    writeFileSync(path, Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(52)]))
    await expect(tryReadImageFromPath(path)).resolves.toBeNull()
  })

  test('small valid image pastes through as base64', async () => {
    const path = join(dir, 'tiny.png')
    writeFileSync(path, TINY_PNG)
    const result = await tryReadImageFromPath(path)
    expect(result).not.toBeNull()
    expect(result!.path).toBe(path)
    expect(result!.mediaType).toBe('image/png')
    expect(result!.base64).toBe(TINY_PNG.toString('base64'))
  })

  test('missing file returns null', async () => {
    await expect(
      tryReadImageFromPath(join(dir, 'missing.png')),
    ).resolves.toBeNull()
  })

  test('non-image text returns null', async () => {
    await expect(tryReadImageFromPath('hello world')).resolves.toBeNull()
  })
})

describe('resolvePastedImageLines', () => {
  test('mixed paste: failed images and text fall back to text lines in order', async () => {
    const goodPath = join(dir, 'tiny.png')
    const badPath = join(dir, 'big.png')
    writeFileSync(goodPath, TINY_PNG)
    writeFileSync(badPath, oversizedPngHeader())

    const { images, textLines } = await resolvePastedImageLines([
      goodPath,
      'hello world',
      badPath,
    ])

    expect(images.map(i => i.path)).toEqual([goodPath])
    expect(textLines).toEqual(['hello world', badPath])
  })

  test('all images failing degrades everything to text without rejecting', async () => {
    const badPath = join(dir, 'big.png')
    writeFileSync(badPath, oversizedPngHeader())

    await expect(resolvePastedImageLines([badPath])).resolves.toEqual({
      images: [],
      textLines: [badPath],
    })
  })

  test('empty input yields empty results', async () => {
    await expect(resolvePastedImageLines([])).resolves.toEqual({
      images: [],
      textLines: [],
    })
  })
})

describe('isImageFilePath', () => {
  test('matches supported extensions only', () => {
    expect(isImageFilePath(join(dir, 'a.png'))).toBe(true)
    expect(isImageFilePath(join(dir, 'a.bmp'))).toBe(false)
    expect(isImageFilePath('hello world')).toBe(false)
  })
})

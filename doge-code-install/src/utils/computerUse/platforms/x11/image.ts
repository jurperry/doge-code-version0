import { encode } from 'jpeg-js'
import type { X11Pixels } from './desktop.js'

/** Resize X11 BGRX pixels to the API image budget and encode a JPEG. */
export function encodeX11Jpeg(
  pixels: X11Pixels,
  maxSize: readonly [number, number] = [pixels.width, pixels.height],
): { width: number; height: number; base64: string } {
  const scale = Math.min(1, maxSize[0] / pixels.width, maxSize[1] / pixels.height)
  const width = Math.max(1, Math.round(pixels.width * scale))
  const height = Math.max(1, Math.round(pixels.height * scale))
  const rgba = Buffer.allocUnsafe(width * height * 4)
  const scaleX = pixels.width / width
  const scaleY = pixels.height / height
  for (let y = 0; y < height; y++) {
    const sourceY = (y + 0.5) * scaleY - 0.5
    const top = Math.floor(sourceY)
    const bottom = Math.min(top + 1, pixels.height - 1)
    const yWeight = sourceY - top
    for (let x = 0; x < width; x++) {
      const sourceX = (x + 0.5) * scaleX - 0.5
      const left = Math.floor(sourceX)
      const right = Math.min(left + 1, pixels.width - 1)
      const xWeight = sourceX - left
      const topLeft = (top * pixels.width + left) * 4
      const topRight = (top * pixels.width + right) * 4
      const bottomLeft = (bottom * pixels.width + left) * 4
      const bottomRight = (bottom * pixels.width + right) * 4
      const dest = (y * width + x) * 4
      for (let channel = 0; channel < 3; channel++) {
        const sourceChannel = 2 - channel
        const upper = pixels.data[topLeft + sourceChannel]! * (1 - xWeight) +
          pixels.data[topRight + sourceChannel]! * xWeight
        const lower = pixels.data[bottomLeft + sourceChannel]! * (1 - xWeight) +
          pixels.data[bottomRight + sourceChannel]! * xWeight
        rgba[dest + channel] = Math.round(upper * (1 - yWeight) + lower * yWeight)
      }
      rgba[dest + 3] = 255
    }
  }
  const jpeg = encode({ width, height, data: rgba }, 80)
  return { width, height, base64: jpeg.data.toString('base64') }
}

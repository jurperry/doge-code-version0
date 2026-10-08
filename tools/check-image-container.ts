/**
 * validateImageContainer 契约单测（0.2.125 工作流容错）：
 * shell 重定向类破坏（UTF-16 交错/CRLF 插入/截断/垃圾填充）必须确定性拒绝，
 * 合法 PNG/JPEG/GIF 不得误伤。用法：bun run tools/check-image-container.ts
 */
import { validateImageContainer } from '../src/utils/imageResizer.js'

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
// 1x1 黑色 JPEG（libjpeg 常见最小样本）
const JPEG_1x1 = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=', 'base64')
const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

let pass = 0
const check = (name: string, buf: Buffer, expectOk: boolean) => {
  const r = validateImageContainer(buf)
  const ok = r.ok === expectOk
  if (!ok) {
    console.error(`FAIL ${name}: ok=${r.ok} reason=${r.reason}`)
    process.exit(1)
  }
  pass += 1
  if (!expectOk) console.log(`reject ✓ ${name} → ${r.reason}`)
}

check('valid PNG 1x1', PNG_1x1, true)
check('valid JPEG 1x1', JPEG_1x1, true)
check('valid GIF 1x1', GIF_1x1, true)

// 事故形态：IHDR 完好、IDAT/IEND 垃圾填充
const mangledIdat = Buffer.from(PNG_1x1)
mangledIdat.fill(7, 45)
check('PNG garbage IDAT/IEND', mangledIdat, false)

// PowerShell `>` UTF-16LE 重编码（每字节后插 0x00）
const utf16 = Buffer.from(PNG_1x1.toString('binary'), 'utf16le')
check('PNG utf-16 re-encode', utf16, false)

// CRLF 行尾翻译（0x0A → 0x0D 0x0A 插入）
const crlfParts: Buffer[] = []
for (const b of PNG_1x1) crlfParts.push(Buffer.from(b === 0x0a ? [0x0d, 0x0a] : [b]))
check('PNG CRLF insertion', Buffer.concat(crlfParts), false)

// 截断（缺 IEND）
check('PNG truncated', PNG_1x1.subarray(0, 40), false)
// 尾部追加垃圾
check('PNG trailing garbage', Buffer.concat([PNG_1x1, Buffer.alloc(16, 9)]), false)
// 签名区垃圾
const sigGarbage = Buffer.from(PNG_1x1)
sigGarbage.fill(7, 0, 8)
check('PNG signature garbage', sigGarbage, false)
// JPEG 截断（缺 EOI）
check('JPEG truncated', JPEG_1x1.subarray(0, JPEG_1x1.length - 3), false)
// WebP 形状但 size 错
const webpBad = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('WEBP')])
check('WebP size mismatch', webpBad, false)

console.log(`check-image-container: ${pass} assertions passed`)

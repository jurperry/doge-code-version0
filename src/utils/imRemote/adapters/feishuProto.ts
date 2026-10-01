/**
 * Minimal hand-rolled codec for Feishu's pbbp2 WebSocket frame protobuf
 * (the wire format behind the official SDK WSClient's proto-buf/pbbp2.js).
 *
 * Only the two messages the long-connection protocol uses are modeled:
 *
 *   message Header { string key = 1; string value = 2; }
 *   message Frame {
 *     uint64 SeqID = 1;          // always written, even when 0
 *     uint64 LogID = 2;          // always written, even when 0
 *     int32  service = 3;        // always written, even when 0
 *     int32  method = 4;         // 0 = control, 1 = data — always written
 *     repeated Header headers = 5;
 *     string payloadEncoding = 6;  // optional (present-only)
 *     string payloadType = 7;      // optional (present-only)
 *     bytes  payload = 8;          // optional (present-only)
 *     string LogIDNew = 9;         // optional (present-only)
 *   }
 *
 * Field numbers and wire types were extracted from the official generated
 * pbbp2.js (larksuite/node-sdk) and are pinned by golden vectors in
 * test/feishu-ws-probe.ts — change anything here and that probe goes red.
 * Unknown fields are skipped on decode so protocol additions don't break us.
 */

export type FeishuWsFrame = {
  SeqID: number
  LogID: number
  service: number
  method: number
  headers: Array<{ key: string; value: string }>
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  LogIDNew?: string
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Growable protobuf writer — byte buffer + varint helpers. */
class ProtoWriter {
  private buf = new Uint8Array(256)
  private len = 0

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + extra) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  byte(b: number): void {
    this.ensure(1)
    this.buf[this.len++] = b & 0xff
  }

  varint(value: number): void {
    let v = Math.max(0, Math.floor(value))
    while (v > 0x7f) {
      this.byte((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    this.byte(v)
  }

  tag(id: number, wireType: number): void {
    this.varint((id << 3) | wireType)
  }

  bytes(payload: Uint8Array): void {
    this.varint(payload.length)
    this.ensure(payload.length)
    this.buf.set(payload, this.len)
    this.len += payload.length
  }

  string(value: string): void {
    this.bytes(textEncoder.encode(value))
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

/** Cursor-based protobuf reader with unknown-field skipping. */
class ProtoReader {
  private pos = 0

  constructor(private buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  varint(): number {
    let result = 0
    let shift = 0
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new Error('feishu proto: truncated varint')
      const b = this.buf[this.pos++]
      result += (b & 0x7f) * Math.pow(2, shift)
      if ((b & 0x80) === 0) return result
      shift += 7
    }
    throw new Error('feishu proto: varint too long')
  }

  length(): number {
    const n = this.varint()
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('feishu proto: bad length')
    return n
  }

  bytes(): Uint8Array {
    const n = this.length()
    const out = this.buf.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  string(): string {
    return textDecoder.decode(this.bytes())
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint()
        return
      case 1:
        this.pos += 8
        return
      case 2: {
        // 不能写成 this.pos += this.length()：+= 先读左值再求右值，
        // length() 消费掉的长度前缀字节会被丢掉，跳过字段恒差 1 字节
        // （真实服务器带 id≥10 扩展字段，错位后整帧报废——mock 帧无
        // 未知字段所以探针测不出来）。
        const n = this.length()
        this.pos += n
        return
      }
      case 5:
        this.pos += 4
        return
      default:
        throw new Error('feishu proto: unknown wire type ' + wireType)
    }
  }
}

function encodeHeader(h: { key: string; value: string }, w: ProtoWriter): void {
  // Header is length-delimited inside Frame field 5: fork a nested writer so
  // the length prefix covers exactly the nested fields.
  const nested = new ProtoWriter()
  if (h.key !== undefined) {
    nested.tag(1, 2)
    nested.string(h.key)
  }
  if (h.value !== undefined) {
    nested.tag(2, 2)
    nested.string(h.value)
  }
  w.tag(5, 2)
  w.bytes(nested.finish())
}

export function encodeFeishuFrame(frame: FeishuWsFrame): Uint8Array {
  const w = new ProtoWriter()
  // Fields 1-4 are unconditionally written — byte-identical to the official
  // generated encoder, which always emits them even at value 0.
  w.tag(1, 0)
  w.varint(frame.SeqID)
  w.tag(2, 0)
  w.varint(frame.LogID)
  w.tag(3, 0)
  w.varint(frame.service)
  w.tag(4, 0)
  w.varint(frame.method)
  if (frame.headers?.length) {
    for (const h of frame.headers) encodeHeader(h, w)
  }
  if (frame.payloadEncoding !== undefined) {
    w.tag(6, 2)
    w.string(frame.payloadEncoding)
  }
  if (frame.payloadType !== undefined) {
    w.tag(7, 2)
    w.string(frame.payloadType)
  }
  if (frame.payload !== undefined) {
    w.tag(8, 2)
    w.bytes(frame.payload)
  }
  if (frame.LogIDNew !== undefined) {
    w.tag(9, 2)
    w.string(frame.LogIDNew)
  }
  return w.finish()
}

export function decodeFeishuFrame(input: Uint8Array): FeishuWsFrame {
  const r = new ProtoReader(input)
  const frame: FeishuWsFrame = {
    SeqID: 0,
    LogID: 0,
    service: 0,
    method: 0,
    headers: [],
  }
  while (!r.done) {
    const tag = r.varint()
    const id = Math.floor(tag / 8)
    const wireType = tag % 8
    switch (id) {
      case 1:
        frame.SeqID = r.varint()
        break
      case 2:
        frame.LogID = r.varint()
        break
      case 3:
        frame.service = r.varint()
        break
      case 4:
        frame.method = r.varint()
        break
      case 5: {
        const nested = new ProtoReader(r.bytes())
        const header = { key: '', value: '' }
        while (!nested.done) {
          const hTag = nested.varint()
          const hId = Math.floor(hTag / 8)
          const hWt = hTag % 8
          if (hId === 1 && hWt === 2) header.key = nested.string()
          else if (hId === 2 && hWt === 2) header.value = nested.string()
          else nested.skip(hWt)
        }
        frame.headers.push(header)
        break
      }
      case 6:
        frame.payloadEncoding = r.string()
        break
      case 7:
        frame.payloadType = r.string()
        break
      case 8:
        frame.payload = r.bytes()
        break
      case 9:
        frame.LogIDNew = r.string()
        break
      default:
        r.skip(wireType)
    }
  }
  return frame
}

/** Header lookup helper — first match wins, mirroring the SDK. */
export function feishuHeaderValue(frame: FeishuWsFrame, key: string): string | undefined {
  return frame.headers.find(h => h.key === key)?.value
}

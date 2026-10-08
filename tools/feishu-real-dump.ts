// 只读探针：用真实凭据连飞书长连接，dump 前 6 个入站帧的 hex 与解码结果。
// 不发送任何业务消息（只按协议回 ping/ACK）。运行：bun run test/feishu-real-dump.ts
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  decodeFeishuFrame,
  encodeFeishuFrame,
  feishuHeaderValue,
} from '../src/utils/imRemote/adapters/feishuProto.js'

const raw = JSON.parse(
  await readFile(join(homedir(), '.doge', 'im-remote.json'), 'utf8'),
) as any
const { appId, appSecret } = raw.feishu
console.log(`appId=${appId.slice(0, 7)}… platform=${raw.platform}`)

const res = await fetch('https://open.feishu.cn/callback/ws/endpoint', {
  method: 'POST',
  headers: { 'content-type': 'application/json', locale: 'zh' },
  body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
  signal: AbortSignal.timeout(15_000),
})
const json: any = await res.json()
console.log(`negotiate code=${json.code} msg=${json.msg ?? ''}`)
if (json.code !== 0) process.exit(1)
console.log(`ClientConfig=${JSON.stringify(json.data.ClientConfig)}`)

const ws = new WebSocket(json.data.URL)
ws.binaryType = 'arraybuffer'
let frames = 0
ws.addEventListener('open', () => {
  const serviceId = Number(new URL(json.data.URL).searchParams.get('service_id') ?? '0')
  console.log('open; sending ping')
  ws.send(
    encodeFeishuFrame({
      SeqID: 0,
      LogID: 0,
      service: serviceId,
      method: 0,
      headers: [{ key: 'type', value: 'ping' }],
    }),
  )
})
ws.addEventListener('message', ev => {
  const data =
    ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as any)
  frames++
  const hexStr = Buffer.from(data).toString('hex')
  // 原始帧落盘（诊断 + 后续单测夹具），避免终端复制丢字节
  Bun.write(join(import.meta.dir, `real-frame-${frames}.bin`), data)
  console.log(`\n--- frame #${frames} (${data.length}B) hex[0:120]=${hexStr.slice(0, 240)}`)
  // 逐字段步进：定位解析断点
  {
    let pos = 0
    const rdVarint = (): number => {
      let result = 0
      let shift = 0
      for (let i = 0; i < 12; i++) {
        const b = data[pos++]
        result += (b & 0x7f) * Math.pow(2, shift)
        if ((b & 0x80) === 0) return result
        shift += 7
      }
      return -1
    }
    try {
      while (pos < data.length) {
        const fieldStart = pos
        const tag = rdVarint()
        const id = Math.floor(tag / 8)
        const wt = tag % 8
        let desc = ''
        if (wt === 0) desc = 'varint=' + rdVarint()
        else if (wt === 2) {
          const n = rdVarint()
          desc = `len=${n}`
          pos += n
        } else if (wt === 1) {
          pos += 8
          desc = 'fixed64'
        } else if (wt === 5) {
          pos += 4
          desc = 'fixed32'
        } else desc = 'WT?' + wt
        console.log(
          `  @${fieldStart} id=${id} wt=${wt} ${desc} (next@${pos}, total=${data.length})`,
        )
        if (pos > data.length) {
          console.log(`  !!! OVERRUN at field id=${id}`)
          break
        }
      }
    } catch (e) {
      console.log(`  stepper error @${pos}: ${String(e)}`)
    }
  }
  try {
    const f = decodeFeishuFrame(data)
    console.log(
      `method=${f.method} service=${f.service} seq=${f.SeqID} log=${f.LogID} headers=${JSON.stringify(f.headers)} payloadType=${f.payloadType ?? ''} payload=${f.payload ? Buffer.from(f.payload).toString('utf8').slice(0, 300) : '(none)'}`,
    )
    // 数据帧按协议回 ACK
    if (f.method === 1 && feishuHeaderValue(f, 'type') === 'event') {
      ws.send(
        encodeFeishuFrame({
          ...f,
          headers: [...f.headers, { key: 'biz_rt', value: '0' }],
          payload: new TextEncoder().encode(JSON.stringify({ code: 200 })),
        }),
      )
      console.log('(acked)')
    }
  } catch (err) {
    console.log(`DECODE FAIL: ${String(err)}`)
  }
  if (frames >= 6) {
    ws.close()
    setTimeout(() => process.exit(0), 300)
  }
})
ws.addEventListener('close', () => console.log('closed'))
ws.addEventListener('error', e => console.log('error', String(e)))
setTimeout(() => {
  console.log('timeout exit')
  process.exit(0)
}, 20_000)

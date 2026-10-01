import { networkInterfaces, type NetworkInterfaceInfoIPv4 } from 'os'
import type {
  ImAdapter,
  ImAdapterHandlers,
  ImInboundMessage,
  ImOption,
} from '../types.js'
import { WEB_CHAT_PAGE_HTML } from '../webPage.js'

/**
 * QR 扫码网页频道适配器：daemon 在 0.0.0.0:<port> 起 HTTP + WS，下发内嵌
 * 手机聊天页（webPage.ts），手机扫二维码（http://<局域网IP>:<port>/#t=<token>）
 * 后即在页内远程驱动会话——微信/飞书/浏览器扫都可用，零 IM 凭据。
 *
 * 授权模型：令牌即门禁（QR 含 token，扫到即授权，等同拿到电脑钥匙）；
 * 无 allowedUsers 概念。重置令牌 = 旧链接全部失效。页面 WS 走同源
 * /?token= 鉴权，token 校验在 upgrade 前完成。
 */

type PageSocket = import('bun').ServerWebSocket<{ clientId: string }>

type PageFrameIn =
  | { t: 'hello'; clientId: string }
  | { t: 'msg'; text: string }

export class WebChatAdapter implements ImAdapter {
  readonly platform = 'web'

  private handlers: ImAdapterHandlers | null = null
  private server: ReturnType<typeof Bun.serve> | null = null
  private sockets = new Set<PageSocket>()

  constructor(
    private readonly config: { port: number; token: string },
    private readonly log: (line: string) => void,
  ) {}

  start(handlers: ImAdapterHandlers): Promise<void> {
    this.handlers = handlers
    // 0.0.0.0：手机要跨设备访问。Windows 首次监听会弹防火墙授权——由
    // 设置页提示用户允许。EADDRINUSE 由调用方捕获并降级为跳过该频道。
    this.server = Bun.serve({
      hostname: '0.0.0.0',
      port: this.config.port,
      idleTimeout: 120,
      fetch: (req, server) => {
        const url = new URL(req.url)
        if (url.pathname === '/' || url.pathname === '/index.html') {
          // 带 token 的请求升级为 WS；纯 GET / 下发聊天页（页面本身无
          // 敏感性，令牌在 URL hash 里不会发到服务器）。
          if (
            url.searchParams.get('token') === this.config.token &&
            server.upgrade(req, { data: { clientId: 'anon' } })
          ) {
            return undefined
          }
          return new Response(WEB_CHAT_PAGE_HTML, {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }
        return new Response('not found', { status: 404 })
      },
      websocket: {
        message: (ws, raw) => this.handlePageFrame(ws, String(raw)),
        open: ws => {
          this.sockets.add(ws)
          this.log(`web 频道页面已连接（当前 ${this.sockets.size} 个）`)
        },
        close: ws => {
          this.sockets.delete(ws)
        },
      },
    })
    this.log(`web 频道已监听 0.0.0.0:${this.config.port}`)
    return Promise.resolve()
  }

  private handlePageFrame(ws: PageSocket, raw: string): void {
    let frame: PageFrameIn
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (frame.t === 'hello' && typeof frame.clientId === 'string') {
      ws.data = { clientId: frame.clientId.slice(0, 64) }
      this.pushTo(ws, { t: 'im', text: '🐶 已连接 Doge Code 远程控制。发送 /help 查看指令，直接输入文字即驱动会话。' })
      return
    }
    if (frame.t === 'msg' && typeof frame.text === 'string') {
      const text = frame.text.trim()
      if (!text) return
      const msg: ImInboundMessage = {
        userId: ws.data.clientId,
        userName: '网页端',
        chatId: 'web',
        text,
      }
      this.handlers?.onMessage(msg)
    }
  }

  private pushTo(ws: PageSocket, frame: object): void {
    try {
      ws.send(JSON.stringify(frame))
    } catch {}
  }

  get connectedCount(): number {
    return this.sockets.size
  }

  async sendText(text: string): Promise<void> {
    for (const ws of this.sockets) this.pushTo(ws, { t: 'im', text })
  }

  async sendOptions(text: string, options: ImOption[]): Promise<void> {
    for (const ws of this.sockets) this.pushTo(ws, { t: 'im', text, options })
  }

  stop(): void {
    for (const ws of this.sockets) {
      try {
        ws.close()
      } catch {}
    }
    this.sockets.clear()
    this.server?.stop(true)
    this.server = null
  }
}

/** 虚拟/回环网卡特征——地址不在物理网口上，手机扫了也到不了（多网卡机器
 *  上 VMware/WSL 地址常排在物理网卡前面，二维码主地址直接变成死链）。
 *  中英文 Windows 网卡名都要盖住：蓝牙 PAN 与 Wi-Fi Direct 拿到可路由
 *  地址时会以 192.168 优先级抢主位。 */
const VIRTUAL_NIC_RE =
  /^(vEthernet|VMware|VirtualBox|Loopback|ZeroTier|Tailscale|Docker|WSL|vgate|蓝牙|Bluetooth|本地连接\*|Local Area Connection\*|Wi-Fi Direct)/i

/**
 * 网卡地址排序键：越小越优先做二维码主地址；null = 排除。
 * 0 = 192.168.x（家用/办公最常见）、1 = 10.x、2 = 172.16–31、
 * 3 = 100.64–127（CGNAT，垫底备选）、4 = 其余；127/8 回环与
 * 169.254/16 链路本地（未获地址的网卡）一律排除。
 */
export function nicPriority(name: string, address: string): number | null {
  if (VIRTUAL_NIC_RE.test(name)) return null
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(address)
  if (!m) return null
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 127 || a === 169) return null
  if (a === 192 && b === 168) return 0
  if (a === 10) return 1
  if (a === 172 && b >= 16 && b <= 31) return 2
  if (a === 100 && b >= 64 && b <= 127) return 3
  return 4
}

/** LAN candidate URLs for the QR code, primary first (multi-NIC safe).
 * nics 参数仅供测试注入；生产走真实 networkInterfaces()。 */
export function webUrlCandidates(
  port: number,
  token: string,
  nics: Record<string, NetworkInterfaceInfoIPv4[]> = networkInterfaces() as Record<string, NetworkInterfaceInfoIPv4[]>,
): string[] {
  const ranked: { url: string; key: number; seq: number }[] = []
  let seq = 0
  for (const [name, list] of Object.entries(nics)) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue
      const key = nicPriority(name, nic.address)
      if (key === null) continue
      ranked.push({ url: `http://${nic.address}:${port}/#t=${token}`, key, seq: seq++ })
    }
  }
  return ranked.sort((x, y) => x.key - y.key || x.seq - y.seq).map((r) => r.url)
}

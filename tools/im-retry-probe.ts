// 客户端重试链探针：先 attach（无配置）→ 后补配置 + 起 daemon → 应最终连上。
// 运行：bun run tools/im-retry-probe.ts（自清理）
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'

const ROOT = join(import.meta.dir, '..')
const sandbox = await mkdtemp(join(tmpdir(), 'im-retry-'))
const configPath = join(sandbox, 'im-remote.json')

process.env.DOGE_IM_REMOTE_CONFIG = configPath
process.env.DOGE_IM_REMOTE_STATUS = join(sandbox, 'status.json')

const { imRemote } = await import('../src/utils/imRemote/client.js')

let prompts = 0
imRemote.setHandlers({
  onPrompt: () => {
    prompts++
  },
})

// ① 无配置时 attach —— 应失败但留下重试
const first = await imRemote.attach('headless', 'probe')
console.log(`first attach (no config): ${first} isConnected=${imRemote.isConnected()}`)
if (first) {
  console.log('E2E FAIL: should not attach without config')
  process.exit(1)
}

// ② 模拟 daemon 起来 + 配置写入（daemon 用同一沙箱）
const mock = Bun.serve({
  port: 55999,
  fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()
    if (method === 'getUpdates') return Response.json({ ok: true, result: [] })
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 1 } })
    return Response.json({ ok: true, result: {} })
  },
})
await writeFile(
  configPath,
  JSON.stringify({
    version: 1, enabled: true, platform: 'telegram',
    telegram: { botToken: 'PROBE', apiBase: 'http://127.0.0.1:55999' },
    allowedUsers: ['7'], autoMode: true, summaryEvery: 10,
    port: 4821, token: 'probe-token-probe-token!',
  }),
)
const daemon = spawn(process.execPath, [join(ROOT, 'src/bootstrap-entry.ts'), 'im'], {
  env: { ...process.env },
  stdio: 'ignore',
})
console.log('daemon spawned, waiting for retry to connect…')

// ③ 等重试（8s 间隔）+ hello
let ok = false
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  if (imRemote.isConnected()) {
    ok = true
    break
  }
}
console.log(`retry attach connected: ${ok}`)
try {
  const { readFile } = await import('fs/promises')
  console.log('status file:', (await readFile(join(sandbox, 'status.json'), 'utf8')).slice(0, 160))
} catch (e) {
  console.log('status file missing:', String(e).slice(0, 120))
}
// 原生 WS 直连对照：排除 client 逻辑
const rawOk = await new Promise<boolean>((resolve) => {
  try {
    const ws = new WebSocket('ws://127.0.0.1:4821/?token=probe-token-probe-token!')
    const t = setTimeout(() => resolve(false), 3000)
    ws.onopen = () => {
      clearTimeout(t)
      ws.send(JSON.stringify({ t: 'hello', sessionId: 'raw-probe', kind: 'headless', label: 'raw', cwd: sandbox, pid: process.pid }))
      setTimeout(() => {
        ws.close()
        resolve(true)
      }, 500)
    }
    ws.onerror = () => {
      clearTimeout(t)
      resolve(false)
    }
  } catch {
    resolve(false)
  }
})
console.log('raw ws connect:', rawOk)
// 手动再 attach 一次：区分定时器问题 vs 连接逻辑问题
const manual = await imRemote.attach('headless', 'probe')
console.log(`manual attach after config: ${manual} isConnected=${imRemote.isConnected()}`)
daemon.kill()
mock.stop(true)
await rm(sandbox, { recursive: true, force: true }).catch(() => {})
console.log(ok ? 'E2E OK' : 'E2E FAIL: retry never connected')
process.exit(ok ? 0 : 1)

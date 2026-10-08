/**
 * 压缩复现驱动：以 App 同款方式（-p --input-format stream-json 持久 stdin）
 * 发两轮提问——自动压缩在第 2 轮 query 迭代开始时才有机会触发。
 * 用法：bun run tools/compact-repro-driver.ts <cliEntry> <sandboxDir> <port> <overridePct>
 */
const [cliEntry, sandboxDir, portArg, overridePct] = process.argv.slice(2)
const port = Number(portArg)
const lines: string[] = []
const log = (s: string) => console.log(s)

const proc = Bun.spawn(
  [
    'bun', 'run', cliEntry,
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ],
  {
    cwd: `${sandboxDir}/run`,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: sandboxDir,
      CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'openai',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: 'test-key',
      ANTHROPIC_MODEL: 'glm-5.3-flash',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(overridePct ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: overridePct } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  },
)

const send = (text: string) => proc.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
const deadline = Date.now() + 90_000
let sawResult = 0

const timeout = setTimeout(() => {
  void Bun.write(`${sandboxDir}/run/stream.ndjson`, lines.join('\n') + '\n')
  log(`DRIVER_TIMEOUT lines=${lines.length}`)
  proc.kill()
  process.exit(2)
}, 90_000)

// 逐行读 stdout，result 计数；两轮 result 后退出
const buf = { text: '' }
void (async () => {
  const decoder = new TextDecoder()
  const stream = proc.stdout as ReadableStream<Uint8Array>
  const reader2 = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader2.read()
      if (done) break
      buf.text += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.text.indexOf('\n')) >= 0) {
        const line = buf.text.slice(0, nl).trim()
        buf.text = buf.text.slice(nl + 1)
        if (!line) continue
        lines.push(line)
        let parsed: { type?: string; subtype?: string } = {}
        try { parsed = JSON.parse(line) } catch { continue }
        if (parsed.type === 'result') {
          sawResult += 1
          if (sawResult === 1) {
            log(`DRIVER_RESULT_1 at line ${lines.length}`)
            setTimeout(() => send('第二问：请再数一次'), 300)
          } else if (sawResult === 2) {
            log(`DRIVER_RESULT_2 at line ${lines.length}`)
            clearTimeout(timeout)
            await Bun.write(`${sandboxDir}/run/stream.ndjson`, lines.join('\n') + '\n')
            proc.kill()
            process.exit(0)
          }
        }
      }
    }
  } catch (e) {
    log(`DRIVER_READ_ERR ${e}`)
  }
})()

await Bun.sleep(800)
// PAD=1：首问带 55 万字符填充——真实输入侧 ~150k（低于 200k 窗口的
// 167k 阈值），mock 的 4x 虚报 ~600k 超窗，恰好构成事故形态
//（2026-10-05 会话 83734af8：真实 ~330k、虚报 1.31M > 1M 窗口）
const pad = process.env.PAD === '1' ? '填充'.repeat(275000) : ''
send(`第一问：你好，请数到三。${pad}`)

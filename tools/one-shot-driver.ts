/**
 * 单发提问驱动：发一条 prompt、等一个 result、落盘 stream.ndjson 后退出。
 * 用法：bun run tools/one-shot-driver.ts <exe> <sandboxDir> <port> <promptFile> [extraEnv...]
 */
const [exe, sandboxDir, portArg, promptFile] = process.argv.slice(2)
const port = Number(portArg)
const prompt = await Bun.file(promptFile).text()
const lines: string[] = []
const log = (s: string) => console.log(s)

const proc = Bun.spawn([exe, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'], {
  cwd: `${sandboxDir}/run`,
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: sandboxDir,
    CLAUDE_CODE_COMPATIBLE_API_PROVIDER: process.env.API_PROVIDER ?? 'openai',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: 'test-key',
    ANTHROPIC_MODEL: 'glm-5.3-flash',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  },
  stdout: 'pipe',
  stderr: 'pipe',
  stdin: 'pipe',
})

const timeout = setTimeout(async () => {
  await Bun.write(`${sandboxDir}/run/stream.ndjson`, lines.join('\n') + '\n')
  log(`DRIVER_TIMEOUT lines=${lines.length}`)
  proc.kill()
  process.exit(2)
}, 120_000)

const buf = { text: '' }
const decoder = new TextDecoder()
void (async () => {
  const reader = proc.stdout.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf.text += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.text.indexOf('\n')) >= 0) {
        const line = buf.text.slice(0, nl).trim()
        buf.text = buf.text.slice(nl + 1)
        if (!line) continue
        lines.push(line)
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'result') {
            log(`DRIVER_RESULT at line ${lines.length} is_error=${parsed.is_error}`)
            clearTimeout(timeout)
            await Bun.write(`${sandboxDir}/run/stream.ndjson`, lines.join('\n') + '\n')
            proc.kill()
            process.exit(0)
          }
        } catch { /* non-JSON */ }
      }
    }
  } catch (e) {
    log(`DRIVER_READ_ERR ${e}`)
    process.exit(3)
  }
})()

setTimeout(() => {
  proc.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`)
}, 600)

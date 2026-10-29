/**
 * Manual Windows clipboard encoding check. Overwrites the system clipboard.
 * Usage: bun tools/verify-windows-clipboard.ts --force
 */
import { execa } from 'execa'
import { setClipboard } from '../src/ink/termio/osc.ts'

if (process.platform !== 'win32') {
  console.log('skip: Windows only')
  process.exit(0)
}
if (!process.argv.includes('--force')) {
  console.error('This test overwrites the clipboard. Re-run with --force.')
  process.exit(2)
}

const SAMPLE = '中文测试😀 café 日本語\n第二行 mixed ASCII'
const LARGE = '中文测试😀 café 日本語 mixed ASCII\n'.repeat(2000).slice(0, 60_000)
const ORDER = ['第一版', '第二版 with ASCII', '第三版😀 最终值']

async function readClipboard(): Promise<string> {
  const result = await execa('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))',
  ])
  return Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
}

async function waitFor(expected: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await readClipboard()
    if (last === expected) return last
    await Bun.sleep(100)
  }
  return last
}

async function check(name: string, text: string, timeoutMs = 5000): Promise<void> {
  await setClipboard(text)
  const got = await waitFor(text, timeoutMs)
  if (got !== text) {
    console.error(`FAIL ${name}: expected ${text.length} chars, got ${got.length}`)
    process.exit(1)
  }
  console.log(`PASS ${name} (${text.length} chars)`)
}

// Avoid a false pass from clipboard content left by an earlier run.
const SENTINEL = 'doge-clipboard-sentinel'
await execa('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Set-Clipboard -Value '${SENTINEL}'`,
])
if ((await readClipboard()) !== SENTINEL) {
  console.error('FAIL reset: could not seed the clipboard')
  process.exit(1)
}

await check('unicode/multiline', SAMPLE)
await check('large selection', LARGE, 10_000)
for (const text of ORDER) await setClipboard(text)
const expected = ORDER.at(-1)!
const ordered = await waitFor(expected, 10_000)
if (ordered !== expected) {
  console.error(`FAIL copy order: got ${JSON.stringify(ordered)}`)
  process.exit(1)
}
// A late stale write would only show up after the latest value lands.
await Bun.sleep(600)
const stable = await readClipboard()
if (stable !== expected) {
  console.error(`FAIL copy order stability: got ${JSON.stringify(stable)}`)
  process.exit(1)
}
console.log(`PASS copy order (${ORDER.length} writes, stable)`)

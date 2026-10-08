// 临时功能验证（验证后删除）：/provider 表单三处行为回归——
// ① 打开首步是 Provider name（此前错开在 API format）
// ② 各填写区序号显示全局步骤号（此前恒为 1.）
// ③ ↑/↓ 过界切换步骤、草稿不丢（含选择列表步骤的过界切换）
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { Stream } from 'stream'

const TMP = join(process.cwd(), 'test', 'verify-provider-form-config')
process.env.CLAUDE_CONFIG_DIR = TMP
process.env.NODE_ENV = 'test'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class FakeStdout extends Stream {
  frames: string[] = []
  columns = 120
  rows = 40
  isTTY = true
  write(chunk: string | Uint8Array): boolean {
    this.frames.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }
}

class FakeStdin extends Stream {
  private pending: string[] = []
  isTTY = true
  isRaw = false
  setRawMode(enabled: boolean) {
    this.isRaw = enabled
    return this
  }
  setEncoding(_enc: string) { return this }
  resume() { return this }
  pause() { return this }
  ref() {}
  unref() {}
  // Ink reads stdin via the 'readable' event + read() pattern (App.tsx), so
  // queue input and signal readability instead of emitting 'data'.
  read(_size?: number): string | null {
    return this.pending.shift() ?? null
  }
  pushKeys(keys: string) {
    this.pending.push(keys)
    this.emit('readable')
  }
}

// Ink positions text with cursor-forward sequences rather than real spaces,
// so translate those to spaces before stripping other ANSI sequences.
const ESC = String.fromCharCode(27)
function stripAnsi(s: string): string {
  return s
    .replace(new RegExp(ESC + String.raw`\[(\d*)C`, 'g'), (_m: string, n: string) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(new RegExp(ESC + String.raw`\[[0-9;?]*[A-Za-z]`, 'g'), '')
    .replace(new RegExp(ESC + String.raw`\][^${String.fromCharCode(7)}]*${String.fromCharCode(7)}`, 'g'), '')
    .replace(new RegExp(ESC + '[()][B0]', 'g'), '')
    .replace(new RegExp(ESC + '[>=<][0-9a-zA-Z]*', 'g'), '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

const stdout = new FakeStdout()
const stdin = new FakeStdin()

const { render } = await import('../src/ink.js')
const React = await import('react')
const { AppStateProvider } = await import('../src/state/AppState.js')
const { KeybindingSetup } = await import('../src/keybindings/KeybindingProviderSetup.js')
const { ProviderForm } = await import('../src/commands/provider/provider-form.js')

const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '(pass)' : '(FAIL)'} ${msg}`)
  if (!cond) failures.push(msg)
}

// Full-content frames only; Ink also emits tiny terminal-control frames.
function contentFrames(): string[] {
  return stdout.frames.filter(f => stripAnsi(f).replace(/\s/g, '').length > 20)
}
function lastText(): string {
  const frames = contentFrames()
  return stripAnsi(frames.at(-1) ?? '')
}

const instance = await render(
  React.createElement(AppStateProvider, null,
    React.createElement(KeybindingSetup, null,
      React.createElement(ProviderForm, { onDone: () => {} }))),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

const sendKeys = async (keys: string, waitMs = 250) => {
  stdin.pushKeys(keys)
  await sleep(waitMs)
}
const DOWN = ESC + '[B'
const UP = ESC + '[A'

// Ink renders diffs: characters unchanged from the previous frame are skipped,
// so contiguous-string assertions are unreliable. Step switches are asserted
// via the rewritten "Step N/11: Title" tail (matches /N\s+Title/), which also
// pins the step number shown in the header.
const isStep = (text: string, n: number, title: string) =>
  new RegExp(`(^|\\s)${n}\\s+${title}`).test(text)

// ① 打开首步 = Provider name
let text = lastText()
check(text.includes('Add Provider'), '表单渲染出 Add Provider 标题')
check(text.includes('Step 1/11: Provider name'), '首步标题为 Step 1/11: Provider name')
check(text.includes('↑/↓ to switch steps'), '标题行带 ↑/↓ 切换提示')

// ② name 步骤序号 1.（输入框前缀）
check(/(^|\s)1\.\s+/.test(text), 'name 步骤序号显示 1.')

// ③ ↓ 从 name（单选项输入区）直接切到 API format
await sendKeys(DOWN)
text = lastText()
check(isStep(text, 2, 'API format'), `↓ 应切到 Step 2: API format，实际帧: ${text.slice(0, 120)}`)

// provider 步骤是 3 项选择列表：↓ 两次在列表内移动（焦点到最后项），第三次过界切步骤
await sendKeys(DOWN) // anthropic → openai
await sendKeys(DOWN) // openai → responses（最后一项）
await sendKeys(DOWN) // 过界 → Base URL
text = lastText()
check(isStep(text, 3, 'Base URL'), `选择列表过界 ↓ 应切到 Step 3: Base URL，实际帧: ${text.slice(0, 120)}`)

// ② Base URL 是第 3 步，输入区序号应为 3（修复前恒为 1；差分帧里 "." 可能被跳过）
check(/❯ 3/.test(text) || /(^|\s)3\.\s+/.test(text), `Base URL 输入区序号显示 3，实际帧: ${text.slice(0, 120)}`)

// ③ ↑ 回 provider 步骤（焦点回到 anthropic），再 ↑ 过界回 name
await sendKeys(UP)
text = lastText()
check(isStep(text, 2, 'API format'), '↑ 应回 Step 2: API format')
await sendKeys(UP) // anthropic 是第一项，直接过界
text = lastText()
check(isStep(text, 1, 'Provider name'), `↑ 过界应回 Step 1: Provider name，实际帧: ${text.slice(0, 120)}`)

// ③ 草稿保留已人工验证：debug 时逐键输入后 ↓/↑ 切换回 name，帧中输入行
// 仍显示已输入内容（goToStep 把 typedRef 草稿写回 values）。fake stdin 一
// 次注入整串字符与真实逐键行为不同，断言不稳定，故不在此自动化。

// 连续 ↓ 一路切到 review（第 11 步）；选择步骤需要多次 ↓（先列表内后过界）
let reachedReview = false
for (let i = 0; i < 30; i++) {
  await sendKeys(DOWN, 120)
  if (lastText().includes('Save and activate')) { reachedReview = true; break }
}
check(reachedReview, '一路 ↓ 能到达 review 步骤（含 Save and activate）')
text = lastText()
check(/(^|\s)11\s+Review/.test(text) || text.includes('Save and activate'), '到达第 11 步 Review')

// review 是最后一步：继续 ↓ 不会越界离开 review
await sendKeys(DOWN)
await sendKeys(DOWN)
text = lastText()
check(text.includes('Save and activate'), 'review 是最后一步，↓ 停留不越界')

instance.unmount()
await sleep(100)

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.length}`)
if (failures.length > 0) process.exitCode = 1

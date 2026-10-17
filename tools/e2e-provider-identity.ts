// E2E（可重复运行）：/provider 表单「同名 provider 重复」回归——编辑
// "deepseek offical" 并把主模型改名、保存激活后：
//  ① 同名 profile 原地替换（不新增第二条）
//  ② 旧模型名从 savedModels 清除（菜单不留幽灵行）
//  ③ .credentials.json 与 .claude.json 两份存储一致
//  ④ settings.json 基线模型前进
// 方法：进程内 Ink 渲染 ProviderForm + fake stdin（同 e2e-provider-form.ts
// 范式；PTY 通道有键入丢失史，真值走磁盘文件）。
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { Stream } from 'stream'

const TMP = join(process.cwd(), 'test', 'verify-provider-identity-config')
process.env.CLAUDE_CONFIG_DIR = TMP
// 注意：不能设 NODE_ENV=test —— saveGlobalConfig 在 test 下写内存桩不落盘，
// .claude.json 镜像断言会假失败；用禁流量变量控制网络副作用
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))

const OLD_MODEL = 'deepseek-flash[1m]'
const NEW_MODEL = 'deepseek-flash-v2[1m]'
const deepseek = (model: string) => ({
  model,
  providerName: 'deepseek offical',
  provider: 'anthropic' as const,
  baseURL: 'http://127.0.0.1:9/anthropic',
  apiKey: 'sk-test',
  authTokenType: 'ANTHROPIC_AUTH_TOKEN' as const,
  contextWindow: 1000000,
})
const endpoint = {
  provider: 'anthropic',
  baseURL: 'http://127.0.0.1:9/anthropic',
  apiKey: 'sk-test',
  authTokenType: 'ANTHROPIC_AUTH_TOKEN',
  model: OLD_MODEL,
  savedModels: [OLD_MODEL, 'kimi-k3[1m]', 'glm-5.3[1m]', 'deepseek-v4.1-old[1m]'],
  modelProfiles: [
    deepseek('deepseek-v4.1-old[1m]'), // 旧同名条目（bug 现场的残留形态）
    deepseek(OLD_MODEL), // 当前激活的同名条目
    { model: 'kimi-k3[1m]', providerName: 'kimi offical', provider: 'anthropic', baseURL: 'http://127.0.0.1:9/anthropic', apiKey: 'k2', authTokenType: 'ANTHROPIC_AUTH_TOKEN', contextWindow: 1000000 },
    { model: 'glm-5.3[1m]', providerName: 'glm official', provider: 'anthropic', baseURL: 'http://127.0.0.1:9/anthropic', apiKey: 'k1', authTokenType: 'DOGE_API_KEY', contextWindow: 1000000 },
  ],
}
writeFileSync(join(TMP, '.credentials.json'), JSON.stringify({ customApiEndpoint: endpoint }, null, 2))
writeFileSync(join(TMP, '.claude.json'), JSON.stringify({ customApiEndpoint: endpoint }, null, 2))
writeFileSync(join(TMP, 'settings.json'), JSON.stringify({ model: OLD_MODEL, cleanupPeriodDays: 9999 }, null, 2))

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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
  setRawMode(enabled: boolean) { this.isRaw = enabled; return this }
  setEncoding(_enc: string) { return this }
  resume() { return this }
  pause() { return this }
  ref() {}
  unref() {}
  read(_size?: number): string | null { return this.pending.shift() ?? null }
  pushKeys(keys: string) { this.pending.push(keys); this.emit('readable') }
}

const ESC = String.fromCharCode(27)
const DOWN = ESC + '[B'
function stripAnsi(s: string): string {
  return s
    .replace(new RegExp(ESC + String.raw`\[(\d*)C`, 'g'), (_m, n) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(new RegExp(ESC + String.raw`\[[0-9;?]*[A-Za-z]`, 'g'), '')
    .replace(new RegExp(ESC + String.raw`\][^${String.fromCharCode(7)}]*${String.fromCharCode(7)}`, 'g'), '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '(pass)' : '(FAIL)'} ${msg}`)
  if (!cond) failures.push(msg)
}

const stdout = new FakeStdout()
const stdin = new FakeStdin()

const { render } = await import('../src/ink.js')
const React = await import('react')
const { AppStateProvider } = await import('../src/state/AppState.js')
const { KeybindingSetup } = await import('../src/keybindings/KeybindingProviderSetup.js')
const { ProviderForm } = await import('../src/commands/provider/provider-form.js')
const { readCustomApiStorage, getModelProfile } = await import('../src/utils/customApiStorage.js')
// saveGlobalConfig 在 enableConfigs() 前被锁（真实 CLI 启动链会调用）
const { enableConfigs } = await import('../src/utils/config.js')
enableConfigs()

// 前置断言：读路径归一化已经把同名重复合并（迁移等价逻辑），编辑锚点是
// 激活的那条 deepseek —— 这正是 /provider 菜单 getModelProfile(model) 的取值
const before = readCustomApiStorage()
check(before.modelProfiles?.length === 3, `读时归一化合并同名条目（3 条，实际 ${before.modelProfiles?.length}）`)
const existing = getModelProfile(OLD_MODEL)
check(existing?.model === OLD_MODEL && existing?.providerName === 'deepseek offical', '编辑锚点 = 激活的 deepseek 条目')

let doneMsg = ''
const instance = await render(
  React.createElement(AppStateProvider, null,
    React.createElement(KeybindingSetup, null,
      React.createElement(ProviderForm, { existing, onDone: (msg: string) => { doneMsg = msg ?? '' } }))),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
)
await sleep(600)

const sendKeys = async (keys: string, waitMs = 250) => { stdin.pushKeys(keys); await sleep(waitMs) }

// name/provider/baseURL/apiKey/authTokenType：预填值 Enter 直接接受
for (let i = 0; i < 5; i++) await sendKeys('\r')
// model：清预填、键入新名（Ink 受控输入的中间帧不重绘，提交值以 review 为准）
for (let i = 0; i < 22; i++) await sendKeys('\x7f', 50)
await sendKeys(NEW_MODEL, 400)
await sendKeys('\r')
// contextWindow/opus/sonnet/haiku：空提交跳过
for (let i = 0; i < 4; i++) await sendKeys('\r')
// review：11 项，↓×10 到 Save and activate
for (let i = 0; i < 10; i++) await sendKeys(DOWN, 120)
await sendKeys('\r', 800)

check(doneMsg.includes(`Provider saved and activated: ${NEW_MODEL}`), `保存激活消息含新模型（实际: ${doneMsg}）`)

// ---- 真值断言：磁盘文件 ----
const readEp = (f: string): any => JSON.parse(readFileSync(join(TMP, f), 'utf8')).customApiEndpoint
for (const f of ['.credentials.json', '.claude.json']) {
  const ep = readEp(f)
  const ds = (ep.modelProfiles || []).filter(p => p.providerName === 'deepseek offical')
  check(ds.length === 1 && ds[0].model === NEW_MODEL, `${f}: "deepseek offical" 仅 1 条且 model=${NEW_MODEL}`)
  check((ep.modelProfiles || []).length === 3, `${f}: 总 profile 数 3（实际 ${(ep.modelProfiles || []).length}）`)
  const sorted = (a: string[]) => [...a].map(s => s.replace(/\[[12]m\]$/i, '')).sort().join(',')
  check(
    (ep.savedModels || []).length === 3 &&
      sorted(ep.savedModels) === sorted([NEW_MODEL, 'kimi-k3[1m]', 'glm-5.3[1m]']),
    `${f}: savedModels 清旧名且含新名（实际 ${JSON.stringify(ep.savedModels)}）`,
  )
  check(ep.model === NEW_MODEL, `${f}: 顶层激活模型前进`)
}
const settings = JSON.parse(readFileSync(join(TMP, 'settings.json'), 'utf8'))
check(settings.model === NEW_MODEL, `settings.json 基线模型前进（实际 ${settings.model}）`)

instance.unmount()
await sleep(100)

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.length}`)
if (failures.length > 0) process.exitCode = 1

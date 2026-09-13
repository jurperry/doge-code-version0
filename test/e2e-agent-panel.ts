// 临时功能验证（验证后保留供回归）：统一 agent 面板渲染回归——
// ① main 行以实心 ● 渲染、面板不再出现 figures.circle 的 Windows 回退 "( )"
// ② teammate 行标签带模型：sub-agent-<人名>-<模型>（如 sub-agent-alice-opus）
// ③ local agent 行保持 sub-agent-<模型>-<描述>
// ④ 未查看行为空心 ○，正在查看的 agent 行变实心 ●（isViewed 路径）
// 面板组件是 React Compiler 编译产物，本 e2e 兼作 _c 缓存槽手工编辑后的
// 渲染冒烟（槽位改坏会在渲染时崩溃）。
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { Stream } from 'stream'

const TMP = join(process.cwd(), 'test', 'verify-agent-panel-config')
process.env.CLAUDE_CONFIG_DIR = TMP
process.env.NODE_ENV = 'test'
// useMainLoopModel 的解析链会走 auth（自定义 provider 直接读 env key）。
// 沙箱内不发任何请求，这个假 key 只让解析链走通。
process.env.DOGE_API_KEY = 'sk-e2e-dummy'
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
  read(_size?: number): string | null { return null }
}

const ESC = String.fromCharCode(27)
function stripAnsi(s: string): string {
  return s
    .replace(new RegExp(ESC + String.raw`\[(\d*)C`, 'g'), (_m: string, n: string) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(new RegExp(ESC + String.raw`\[[0-9;?]*[A-Za-z]`, 'g'), '')
    .replace(new RegExp(ESC + String.raw`\][^${String.fromCharCode(7)}]*${String.fromCharCode(7)}]`, 'g'), '')
    .replace(new RegExp(ESC + '[()][B0]', 'g'), '')
    .replace(new RegExp(ESC + '[>=<][0-9a-zA-Z]*', 'g'), '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
}

const stdout = new FakeStdout()
const stdin = new FakeStdin()

const { render } = await import('../src/ink.js')
const React = await import('react')
const { AppStateProvider, useAppStateStore } = await import('../src/state/AppState.js')
const { CoordinatorTaskPanel } = await import('../src/components/CoordinatorAgentStatus.js')
const { BLACK_CIRCLE, WHITE_CIRCLE } = await import('../src/constants/figures.js')

const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '(pass)' : '(FAIL)'} ${msg}`)
  if (!cond) failures.push(msg)
}

// Capture the vanilla store from inside the tree so the e2e can inject tasks.
const storeHolder: { store: ReturnType<typeof useAppStateStore> | null } = { store: null }
function CaptureStore() {
  storeHolder.store = useAppStateStore()
  return null
}

const instance = await render(
  React.createElement(AppStateProvider, null,
    React.createElement(CaptureStore),
    React.createElement(CoordinatorTaskPanel)),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
)
await sleep(500)

function allText(): string {
  return stripAnsi(stdout.frames.join('\n'))
}

// ① main 行 + 实心圆点，无 "( )" 回退
let text = allText()
check(/main-/.test(text), `面板渲染出 main-<模型> 行，实际: ${text.slice(0, 120)}`)
check(text.includes(BLACK_CIRCLE), `main 行使用实心圆点 ${BLACK_CIRCLE}`)
check(!text.includes('( )'), '面板未出现 figures.circle 的 Windows 回退 "( )"')

// 注入一个 teammate 任务（model: opus）与一个 local agent 任务（model: glm-4.7）
const now = Date.now()
storeHolder.store!.setState(prev => ({
  ...prev,
  tasks: {
    ...prev.tasks,
    'tm-e2e': {
      id: 'tm-e2e',
      type: 'in_process_teammate',
      status: 'running',
      description: 'alice: research the login flow',
      startTime: now - 5_000,
      outputFile: '/tmp/out',
      outputOffset: 0,
      notified: false,
      identity: {
        agentId: 'alice@e2e',
        agentName: 'alice',
        teamName: 'e2e-team',
        color: 'red',
        planModeRequired: false,
        parentSessionId: 's-e2e',
      },
      prompt: 'research',
      model: 'opus',
      awaitingPlanApproval: false,
      permissionMode: 'default',
      pendingUserMessages: [],
      isIdle: false,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
    },
    'ag-e2e': {
      id: 'ag-e2e',
      type: 'local_agent',
      status: 'running',
      description: 'explore src',
      startTime: now - 3_000,
      endTime: undefined,
      outputFile: '/tmp/out2',
      outputOffset: 0,
      notified: false,
      retain: false,
      evictAfter: undefined,
      pendingMessages: [],
      progress: undefined,
      model: 'glm-4.7',
    },
  },
}))
await sleep(400)
text = allText()

// ② teammate 行带模型名
check(text.includes('sub-agent-alice-opus'), `teammate 行标签为 sub-agent-alice-opus，实际片段: ${text.slice(-300)}`)
// ③ local agent 行保持模型形式
check(text.includes('sub-agent-glm-4.7'), 'local agent 行标签为 sub-agent-glm-4.7')
// ④ 未查看的行为空心圆 ○
check(text.includes(WHITE_CIRCLE), `未查看行使用空心圆 ${WHITE_CIRCLE}`)

// 查看该 teammate → 其行变实心（isViewed），main 行变空心
storeHolder.store!.setState(prev => ({
  ...prev,
  viewingAgentTaskId: 'tm-e2e',
  viewSelectionMode: 'viewing-agent',
}))
await sleep(400)
text = stripAnsi(stdout.frames.slice(-6).join('\n'))
check(text.includes('sub-agent-alice-opus'), '查看态下 teammate 行仍在')
check(text.includes(WHITE_CIRCLE), '查看态下 main 行（未查看）使用空心圆')

instance.unmount()
rmSync(TMP, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')

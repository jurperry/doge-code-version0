// 临时功能验证（验证后保留供回归）：统一 agent 面板键盘链路 e2e——
// 真实 PromptInput + 真实键位系统（KeybindingSetup + GlobalKeybindingHandlers）
// + store 注入的运行中 local_agent：
// ① 面板选中态（footerSelection='tasks'）下 ↓ 移动行索引
// ② 选中 sub-agent 行按 Enter 进入查看（viewingAgentTaskId 置位、不走提交路径）
// ③ Enter 不会被 TextInput/typeahead 吃掉（onSubmit 零调用）
// ④ ctrl+t 切换任务面板聚焦（footerSelection tasks↔null，统一面板语义）
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { Stream } from 'stream'

const TMP = join(process.cwd(), 'test', 'verify-agent-keys-config')
process.env.CLAUDE_CONFIG_DIR = TMP
process.env.NODE_ENV = 'test'
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
  read(_size?: number): string | null {
    return this.pending.shift() ?? null
  }
  pushKeys(keys: string) {
    this.pending.push(keys)
    this.emit('readable')
  }
}

const ESC = String.fromCharCode(27)
const stdout = new FakeStdout()
const stdin = new FakeStdin()

const { render } = await import('../src/ink.js')
const React = await import('react')
const { AppStateProvider, useAppStateStore } = await import('../src/state/AppState.js')
const { KeybindingSetup } = await import('../src/keybindings/KeybindingProviderSetup.js')
const { GlobalKeybindingHandlers } = await import('../src/hooks/useGlobalKeybindings.js')
const PromptInput = (await import('../src/components/PromptInput/PromptInput.js')).default
const { getVisibleAgentTasks } = await import('../src/components/CoordinatorAgentStatus.js')

const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '(pass)' : '(FAIL)'} ${msg}`)
  if (!cond) failures.push(msg)
}

const storeHolder: { store: ReturnType<typeof useAppStateStore> | null } = { store: null }
function CaptureStore() {
  storeHolder.store = useAppStateStore()
  return null
}

const submitted: string[] = []
const noop = () => {}
const inputState = { value: '' }
const fakeContext = {
  getAppState: () => storeHolder.store!.getState(),
  setAppState: noop,
  options: { commands: [], tools: [], isNonInteractiveSession: false },
} as never

const [, setScreen] = [null, noop] as const
function Harness() {
  return React.createElement(
    GlobalKeybindingHandlers,
    {
      screen: 'prompt' as never,
      setScreen: setScreen as never,
      showAllInTranscript: false,
      setShowAllInTranscript: noop as never,
      messageCount: 0,
    },
  )
}

const baseProps = {
  debug: false,
  ideSelection: undefined,
  toolPermissionContext: { mode: 'default' },
  setToolPermissionContext: noop,
  apiKeyStatus: 'ok' as never,
  commands: [] as never[],
  agents: [] as never[],
  isLoading: false,
  verbose: false,
  messages: [] as never[],
  onAutoUpdaterResult: noop,
  autoUpdaterResult: null,
  input: inputState.value,
  onInputChange: (v: string) => { inputState.value = v },
  mode: 'prompt' as never,
  onModeChange: noop,
  stashedPrompt: undefined,
  setStashedPrompt: noop,
  submitCount: 0,
  onShowMessageSelector: noop,
  mcpClients: [] as never[],
  pastedContents: {},
  setPastedContents: noop as never,
  vimMode: 'INSERT' as never,
  setVimMode: noop as never,
  showBashesDialog: false as const,
  setShowBashesDialog: noop as never,
  onExit: noop,
  getToolUseContext: (() => fakeContext) as never,
  onSubmit: (async (text: string) => { submitted.push(text) }) as never,
  isSearchingHistory: false,
  setIsSearchingHistory: noop as never,
  helpOpen: false,
  setHelpOpen: noop as never,
}

const instance = await render(
  React.createElement(AppStateProvider, null,
    React.createElement(KeybindingSetup, null,
      React.createElement(CaptureStore),
      React.createElement(Harness),
      React.createElement(PromptInput, baseProps as never))),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
)
await sleep(700)

const store = () => storeHolder.store!.getState()
const sendKeys = async (keys: string, waitMs = 250) => {
  stdin.pushKeys(keys)
  await sleep(waitMs)
}

// 注入一个运行中的 local_agent（模型 glm-4.7），任务 pill 与面板行随之出现
storeHolder.store!.setState(prev => ({
  ...prev,
  tasks: {
    ...prev.tasks,
    'ag-keys': {
      id: 'ag-keys',
      type: 'local_agent',
      status: 'running',
      description: 'explore src',
      startTime: Date.now() - 1_000,
      endTime: undefined,
      outputFile: '/tmp/out',
      outputOffset: 0,
      notified: false,
      retain: false,
      evictAfter: undefined,
      pendingMessages: [],
      progress: undefined,
      model: 'glm-4.7',
    } as never,
  },
}))
await sleep(300)

check(getVisibleAgentTasks(store().tasks).length === 1, '注入的 sub-agent 行可见')

// ① ctrl+t 聚焦任务面板（统一面板语义：tasks↔null 切换）
await sendKeys('\x14', 400) // ctrl+t
check(store().footerSelection === 'tasks', `ctrl+t 后 footerSelection='tasks'，实际: ${String(store().footerSelection)}`)
check(store().coordinatorTaskIndex === 0, '聚焦后索引重置到 main 行')

// ② ↓ 移到 sub-agent 行
await sendKeys(ESC + '[B', 300) // ↓
check(store().coordinatorTaskIndex === 1, `↓ 后索引=1（sub-agent 行），实际: ${store().coordinatorTaskIndex}`)

// ③ Enter 进入查看该 agent 的任务
await sendKeys('\r', 300)
check(store().viewingAgentTaskId === 'ag-keys', `Enter 后 viewingAgentTaskId='ag-keys'，实际: ${String(store().viewingAgentTaskId)}`)
check(store().viewSelectionMode === 'viewing-agent', `viewSelectionMode='viewing-agent'，实际: ${store().viewSelectionMode}`)
// TextInput 在面板选中时失焦——Enter 若被输入框吃到会触发提交，这里零提交即证明
check(submitted.length === 0, `Enter 未触发消息提交（onSubmit 调用数 ${submitted.length}）`)

// ④ 再按 ctrl+t 取消聚焦（在查看态下也能取消）
await sendKeys('\x14', 400)
check(store().footerSelection === null, `再按 ctrl+t 取消聚焦，实际: ${String(store().footerSelection)}`)

// ⑤ x 键（footer:close 默认绑定）清除终态 sub-agent 行：
// 先退出查看态并把任务置为 completed，x 应 evictAfter=0 隐藏该行，
// 且 'x' 不落入输入框（面板选中时 TextInput 失焦）
storeHolder.store!.setState(prev => ({
  ...prev,
  viewingAgentTaskId: undefined,
  viewSelectionMode: 'none' as never,
  tasks: {
    ...prev.tasks,
    'ag-keys': { ...prev.tasks['ag-keys'], status: 'completed' as never, notified: true },
  },
}))
await sleep(200)
check(getVisibleAgentTasks(store().tasks).some(t => t.id === 'ag-keys'), '终态 sub-agent 行仍在面板（宽限期内可见）')

await sendKeys('\x14', 400) // ctrl+t 重新聚焦
check(store().coordinatorTaskIndex === 0, '重新聚焦后索引回到 main 行')
await sendKeys(ESC + '[B', 300) // ↓ 到 sub-agent 行
check(store().coordinatorTaskIndex === 1, `↓ 后索引=1，实际: ${store().coordinatorTaskIndex}`)
await sendKeys('x', 300)
check(!getVisibleAgentTasks(store().tasks).some(t => t.id === 'ag-keys'), `x 后终态行被清除（evictAfter=0），实际可见行: ${getVisibleAgentTasks(store().tasks).map(t => t.id).join(',')}`)
check(inputState.value === '', `x 未落入输入框，实际: "${inputState.value}"`)

// ⑥ teammate 模式下 Enter 走面板高亮行（coordinatorTaskIndex），
// 不再被已退役的 teammateFooterIndex 隐形游标劫持：
// 注入运行中 in_process_teammate（startTime 晚于已隐藏的 ag-keys），
// ↓ 选中其行后 Enter 应进入该 teammate 的查看态
storeHolder.store!.setState(prev => ({
  ...prev,
  tasks: {
    ...prev.tasks,
    'tm-keys': {
      id: 'tm-keys',
      type: 'in_process_teammate',
      status: 'running',
      description: 'research stuff',
      startTime: Date.now() - 500,
      endTime: undefined,
      outputFile: '/tmp/out-tm',
      outputOffset: 0,
      notified: false,
      evictAfter: undefined,
      identity: {
        agentId: 'tm-keys@e2e-team',
        agentName: 'tm-keys',
        teamName: 'e2e-team',
        planModeRequired: false,
        parentSessionId: 'sess-e2e',
      },
      prompt: 'do research',
      awaitingPlanApproval: false,
      permissionMode: 'default',
      pendingUserMessages: [],
    } as never,
  },
}))
await sleep(300)
check(getVisibleAgentTasks(store().tasks).some(t => t.id === 'tm-keys'), '注入的 teammate 行可见')
// x 清除最后一行后 pill 自动失焦（无可运行行）——ctrl+t 重新聚焦；
// 有运行中任务时 hasBgTaskPill 使聚焦索引重置为 -1（bg-tasks 伪行），需两次 ↓ 到 teammate 行
await sendKeys('\x14', 400)
check(store().footerSelection === 'tasks', `ctrl+t 重新聚焦任务面板，实际: ${String(store().footerSelection)}`)
await sendKeys(ESC + '[B' + ESC + '[B', 400)
check(store().coordinatorTaskIndex === 1, `↓↓ 后索引=1（teammate 行），实际: ${store().coordinatorTaskIndex}`)
await sendKeys('\r', 300)
check(store().viewingAgentTaskId === 'tm-keys', `teammate 模式 Enter 打开高亮 teammate，实际: ${String(store().viewingAgentTaskId)}`)
check(store().viewSelectionMode === 'viewing-agent', `viewSelectionMode='viewing-agent'，实际: ${store().viewSelectionMode}`)
check(submitted.length === 0, `Enter 未触发消息提交（onSubmit 调用数 ${submitted.length}）`)

// ⑦ 再按 ctrl+t 取消聚焦收尾
await sendKeys('\x14', 400)
check(store().footerSelection === null, `收尾 ctrl+t 取消聚焦，实际: ${String(store().footerSelection)}`)

instance.unmount()
rmSync(TMP, { recursive: true, force: true })

// 查看态下的面板 tick/引导定时器会让进程滞留——验证完成后显式退出
if (failures.length > 0) {
  console.error(`\n${failures.length} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
process.exit(0)

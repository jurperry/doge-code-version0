// /resume 渲染回归（验证后保留）：agent-teams 会话的转录条目带 teamName 戳，
// 在新进程未 opt-in（无 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS）时 /resume 仍须
// 按 teammate 消息渲染，不得回退为原始 <teammate-message> XML。
// 场景：
//  ① 带戳信封 + 旗标关 → 渲染 @name 头，无原始 XML
//  ② 带戳协议噪音（idle_notification/teammate_terminated/shutdown_approved）→ 全部隐藏
//  ③ 无戳信封 + 旗标关（用户粘贴的文本）→ 字面透传，不劫持渲染
//  ④ 无戳信封 + 旗标开（实时会话）→ 渲染 @name 头
//  ⑤ 带戳 task_assignment → 渲染任务分派框
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { Stream } from 'stream'

const TMP = join(process.cwd(), 'test', 'tmp-teammate-render-config')
process.env.CLAUDE_CONFIG_DIR = TMP
process.env.NODE_ENV = 'test'
process.env.DOGE_API_KEY = 'sk-e2e-dummy'
delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
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

const { render } = await import('../src/ink.js')
const React = await import('react')
const { AppStateProvider } = await import('../src/state/AppState.js')
const { Message } = await import('../src/components/Message.js')

const failures: string[] = []
const check = (cond: boolean, msg: string) => {
  console.log(`${cond ? '(pass)' : '(FAIL)'} ${msg}`)
  if (!cond) failures.push(msg)
}

type RenderedMessage = {
  type: 'user'
  message: { role: 'user'; content: { type: 'text'; text: string }[] }
  uuid: string
  timestamp: string
  teamName?: string
}

function makeMessage(text: string, teamName?: string): RenderedMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...(teamName ? { teamName } : {}),
  }
}

async function renderFrame(messages: RenderedMessage[], isTranscriptMode = false): Promise<string> {
  const stdout = new FakeStdout()
  const instance = await render(
    React.createElement(
      AppStateProvider,
      null,
      ...messages.map(m =>
        React.createElement(Message as never, {
          key: m.uuid,
          message: m,
          lookups: {},
          addMargin: false,
          tools: [],
          commands: [],
          verbose: false,
          inProgressToolUseIDs: new Set(),
          progressMessagesForMessage: [],
          shouldAnimate: false,
          shouldShowDot: false,
          isTranscriptMode,
          isStatic: true,
        }),
      ),
    ),
    { stdout: stdout as never, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(400)
  instance.unmount()
  // ANSI 转义序列会干扰子串匹配——剥离控制序列后比对纯文本
  // eslint-disable-next-line no-control-regex
  return stdout.frames.join('').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

// Ink 对多段 JSX 文本子节点按段输出，段间空白不稳定——涉及跨段文本一律忽略空白比对
const squish = (s: string) => s.replace(/\s+/g, '')

const envelope = (id: string, color: string | undefined, summary: string | undefined, body: string) =>
  `<teammate-message teammate_id="${id}"${color ? ` color="${color}"` : ''}${summary ? ` summary="${summary}"` : ''}>\n${body}\n</teammate-message>`

// ① 带戳信封 + 旗标关 → teammate 渲染
{
  const text = envelope('integration-researcher', 'yellow', '集成层分析报告', '集成层报告正文：/agent-teams 命令流程分析')
  const frame = await renderFrame([makeMessage(text, 'agent-teams-analysis')])
  check(frame.includes('@integration-researcher'), '① 带戳消息渲染 @integration-researcher 头')
  check(frame.includes('集成层分析报告'), '① summary 摘要可见')
  check(!frame.includes('<teammate-message'), '① 无原始 <teammate-message> XML 泄漏')
  // 非 transcript 模式正文按设计折叠（内容已在模型上下文里），transcript 模式须完整可见
  const transcriptFrame = await renderFrame([makeMessage(text, 'agent-teams-analysis')], true)
  check(transcriptFrame.includes('集成层报告正文'), '① transcript 模式正文完整可见')
}

// ② 带戳协议噪音 → 全部隐藏
{
  const noise = [
    envelope('bob', 'blue', undefined, '{"type":"idle_notification","from":"bob","timestamp":"2026-09-13T14:01:10.984Z","idleReason":"available"}'),
    envelope('system', undefined, undefined, '{"type":"teammate_terminated","message":"bob has shut down."}'),
    envelope('bob', 'blue', undefined, '{"type":"shutdown_approved","requestId":"shutdown-1@bob","from":"bob","timestamp":"2026-09-13T14:55:34.689Z"}'),
  ].join('\n\n')
  const frame = await renderFrame([makeMessage(noise, 'agent-teams-analysis')])
  check(!frame.includes('idle_notification'), '② idle_notification 隐藏')
  check(!frame.includes('teammate_terminated'), '② teammate_terminated 隐藏')
  check(!frame.includes('shutdown_approved'), '② shutdown_approved 隐藏')
  check(!frame.includes('<teammate-message'), '② 无原始 XML 泄漏')
}

// ③ 无戳信封 + 旗标关 → 字面透传（用户粘贴场景不劫持）
{
  const text = envelope('some-teammate', 'blue', undefined, 'hello')
  const frame = await renderFrame([makeMessage(text)])
  check(frame.includes('<teammate-message'), '③ 无戳消息在旗标关时字面透传（不劫持）')
}

// ④ 无戳信封 + 旗标开 → teammate 渲染（实时会话行为保持）
{
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  const text = envelope('live-teammate', 'green', undefined, 'live report body')
  const frame = await renderFrame([makeMessage(text)])
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  check(frame.includes('@live-teammate'), '④ 旗标开时无戳消息仍按 teammate 渲染')
  check(!frame.includes('<teammate-message'), '④ 无原始 XML 泄漏')
}

// ⑤ 带戳 task_assignment → 任务分派框
{
  const assignment = envelope('team-lead', undefined, undefined, '{"type":"task_assignment","taskId":"2","subject":"现场复现关闭协议","description":"验证关闭链路","assignedBy":"team-lead","timestamp":"2026-09-13T14:53:56.008Z"}')
  const frame = await renderFrame([makeMessage(assignment, 'agent-teams-analysis')])
  check(squish(frame).includes(squish('Task #2 assigned by team-lead')), '⑤ task_assignment 渲染任务分派框')
  check(!frame.includes('<teammate-message'), '⑤ 无原始 XML 泄漏')
}

// ⑥ 渲染管线 normalizeMessages 不得丢 teamName 戳——真实 /resume 链路必经
//    （组件直渲染测不到这一层：白名单重建曾把戳丢掉，resume 仍裸显 XML）
{
  const { normalizeMessages } = await import('../src/utils/messages.js')
  const text = envelope('pipe-teammate', 'green', '管线透传摘要', '管线正文')
  const normalized = normalizeMessages([makeMessage(text, 'agent-teams-analysis') as never])
  check(normalized.length === 1 && (normalized[0] as { teamName?: string }).teamName === 'agent-teams-analysis', '⑥ normalizeMessages 保留 teamName 戳')
  const frame = await renderFrame(normalized as never)
  check(frame.includes('@pipe-teammate'), '⑥ 管线归一后仍渲染 @pipe-teammate 头')
  check(!frame.includes('<teammate-message'), '⑥ 管线归一后无原始 XML 泄漏')
}

rmSync(TMP, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
process.exit(0)

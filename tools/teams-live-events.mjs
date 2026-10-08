/**
 * agent-teams in-process 队友的实时事件黑盒（0.2.128）：
 *  - lead 的 result 提前发出后，teammate 的 task_progress 仍持续流出
 *    （print.ts 邮箱轮询循环排水——此前事件积压在 1000 上限队列里冻结面板）
 *  - 队友开工/空闲发 is_idle 标记（壳侧占用锁口径）
 *  - 空闲通知走邮箱驱动 lead 下一回合（链路存活）
 * 用法：bun tools/teams-live-events.mjs（源码直跑，无需预编译）
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function sse(frames) {
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('') + '\n'
}
function textFrame(text) {
  return sse([
    ['message_start', { type: 'message_start', message: { id: `m_${Date.now()}`, type: 'message', role: 'assistant', model: 'mock-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
}
function toolUseFrame({ id, name, input }) {
  return sse([
    ['message_start', { type: 'message_start', message: { id: `m_${Date.now()}`, type: 'message', role: 'assistant', model: 'mock-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }],
    ['message_stop', { type: 'message_stop' }],
  ])
}

const home = mkdtempSync(join(tmpdir(), 'doge-teams-'))
const cwd = join(home, 'project')
mkdirSync(cwd, { recursive: true })
writeFileSync(join(cwd, 'README.md'), '# demo\nhello teammate\n')

const server = await new Promise(resolveSrv => {
  const srv = createServer((req, res) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', async () => {
      if (req.url.includes('count_tokens')) { res.writeHead(200).end('{"input_tokens":5}'); return }
      let body
      try { body = JSON.parse(raw || '{}') } catch { res.writeHead(400).end(); return }
      const system = JSON.stringify(body.system ?? [])
      const teammate = system.includes('Agent Teammate Communication')
      const lastUser = (body.messages ?? []).filter(m => m.role === 'user').at(-1)
      const hadToolResult = Array.isArray(lastUser?.content) && lastUser.content.some(b => b.type === 'tool_result')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      if (teammate) {
        if (hadToolResult) {
          res.end(textFrame('TEAMMATE_ROUND_DONE'))
        } else {
          // 首轮延迟：确保 lead 的 result 先落地，随后的工具进度事件
          // 只能靠邮箱轮询循环的排水到达 stdout（本轮修复点）
          await sleep(4000)
          res.end(toolUseFrame({ id: 'toolu_read_1', name: 'Read', input: { file_path: 'README.md' } }))
        }
        return
      }
      // lead：建队 → 派发 teammate → 收到 spawn 结果后收尾；
      // 邮箱驱动的回合（含 teammate-message XML）回确认。按 tool_use_id
      // 精确分阶段（结果文本形态不可靠）
      const msgs = JSON.stringify(body.messages ?? [])
      if (msgs.includes('teammate-message')) { res.end(textFrame('LEAD_ACK')); return }
      if (msgs.includes('"tool_use_id":"toolu_agent_1"')) { res.end(textFrame('Spawned, ending turn.')); return }
      if (msgs.includes('"tool_use_id":"toolu_team_1"')) {
        res.end(toolUseFrame({
          id: 'toolu_agent_1', name: 'Agent',
          input: { subagent_type: 'general-purpose', name: 'worker', description: 'demo worker', prompt: 'Read README.md then report.', team_name: 'demo-team' },
        }))
        return
      }
      res.end(toolUseFrame({ id: 'toolu_team_1', name: 'TeamCreate', input: { team_name: 'demo-team', description: 'demo' } }))
    })
  })
  srv.listen(0, '127.0.0.1', () => resolveSrv(srv))
})

const proc = spawn(process.execPath, [
  'run', join(ROOT, 'src', 'bootstrap-entry.ts'),
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'bypassPermissions', '--model', 'mock-model',
], {
  cwd, windowsHide: true,
  env: {
    ...process.env,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    DOGE_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}/`,
    ANTHROPIC_MODEL: 'mock-model',
    CLAUDE_CONFIG_DIR: join(home, '.doge'),
    USER_TYPE: 'external',
  },
})
const events = []
let buf = ''
proc.stdout.on('data', data => {
  buf += data
  let end
  while ((end = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, end); buf = buf.slice(end + 1)
    if (line.trim().startsWith('{')) { try { events.push(JSON.parse(line)) } catch {} }
  }
})
let stderr = ''
proc.stderr.on('data', d => { stderr += d })
const send = msg => proc.stdin.write(JSON.stringify(msg) + '\n')
send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
const until = (fn, ms, step = 250) => new Promise(r => { const t0 = Date.now(); const tick = () => { if (fn()) return r(true); if (Date.now() - t0 > ms) return r(false); setTimeout(tick, step) }; tick() })
await until(() => events.some(e => e.type === 'control_response'))
send({ type: 'user', message: { role: 'user', content: 'Start the demo team.' }, session_id: '', parent_tool_use_id: null })

try {
  const t0 = Date.now()
  assert.ok(await until(() => events.some(e => e.subtype === 'task_started' && e.task_type === 'in_process_teammate'), 30000), `teammate task_started missing; stderr=${stderr.slice(-400)}`)
  console.log('PASS teammate task_started (in_process_teammate)')

  assert.ok(await until(() => events.some(e => e.type === 'result'), 30000), 'lead result missing')
  const resultIdx = events.findIndex(e => e.type === 'result')
  const afterResult = () => events.slice(resultIdx + 1)
  console.log(`PASS lead result emitted early (teammate still working) at ${Date.now() - t0}ms`)

  // 核心断言：result 之后、lead 邮箱回合之前，teammate 的工具进度已流出
  assert.ok(await until(() => afterResult().some(e => e.subtype === 'task_progress' && e.last_tool_name === 'Read'), 40000),
    `post-result teammate tool progress missing (mailbox-poll drain broken); got: ${events.filter(e => e.subtype === 'task_progress').map(e => [e.last_tool_name, e.is_idle]).join(',')} stderr=${stderr.slice(-400)}`)
  console.log('PASS teammate tool progress streams AFTER the lead result (mailbox-poll drain)')

  assert.ok(await until(() => afterResult().some(e => e.subtype === 'task_progress' && e.is_idle === true), 40000), 'is_idle marker missing')
  console.log('PASS teammate idle marker (is_idle=true) emitted')

  const leadAckOk = await until(() => afterResult().some(e => e.type === 'assistant' && !e.parent_tool_use_id && JSON.stringify(e.message ?? {}).includes('LEAD_ACK')), 60000)
  if (!leadAckOk) {
    // 现场留档：mock 请求序列 + 事件摘要（test/ 下，便于排查邮箱链路）
    writeFileSync(join(ROOT, 'test', 'teams-debug.json'), JSON.stringify({
      stderrTail: stderr.slice(-2000),
      events: events.map(e => ({ t: e.subtype ?? e.type, taskType: e.task_type, tool: e.last_tool_name, idle: e.is_idle, text: JSON.stringify(e.message ?? {}).slice(0, 160) })),
    }, null, 2))
  }
  assert.ok(leadAckOk, 'mailbox-driven lead turn missing (dump at test/teams-debug.json)')
  console.log('PASS mailbox idle notification drives the next lead turn')

  const progress = events.filter(e => e.subtype === 'task_progress' && e.task_type === undefined)
  const toolProgress = events.filter(e => e.subtype === 'task_progress' && e.last_tool_name === 'Read')
  assert.ok(toolProgress.some(e => (e.usage?.tool_uses ?? 0) >= 1 && (e.usage?.total_tokens ?? 0) > 0), 'tool progress carries usage counters')
  console.log('PASS tool progress carries usage counters')
  console.log(`ALL PASS (${progress.length} progress events)`)
} finally {
  proc.kill()
  await new Promise(r => proc.on('close', r)).catch(() => {})
  await new Promise(r => server.close(r))
  rmSync(home, { recursive: true, force: true })
}

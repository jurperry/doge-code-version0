import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createQuestionServer, fixtureQuestions } from './auto-question-fixture.js'

const repo = resolve(import.meta.dir, '..')
const output = join(repo, 'test', 'auto-question-e2e')
mkdirSync(output, { recursive: true })
const slow = process.argv.includes('--timeout')
const providers = slow ? ['anthropic'] : ['anthropic', 'openai', 'responses']
const humanAnswers = { 'Implementation choice?': 'First', 'Verification choices?': 'First check' }

async function run(provider: string, action: 'human' | 'timeout' | 'interrupt' | 'no-host') {
  const root = join(output, `${provider}-${action}`)
  const cwd = join(root, 'project')
  const config = join(root, '.doge')
  const temp = join(root, 'tmp')
  for (const path of [cwd, config, temp]) mkdirSync(path, { recursive: true })
  const fixture = await createQuestionServer(provider)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ model: 'auto-question-test', cleanupPeriodDays: 36500, claudeMdExcludes: ['**/AGENTS.md', '**/CLAUDE.md'] }))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|DOGE_|CLAUDE_CODE_)/.test(key)) delete env[key]
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_TMPDIR: temp, TEMP: temp, TMP: temp, TMPDIR: temp,
    ANTHROPIC_MODEL: 'auto-question-test', ANTHROPIC_BASE_URL: fixture.baseURL, DOGE_API_KEY: 'sk-local-test', CLAUDE_CODE_COMPATIBLE_API_PROVIDER: provider,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DOGE_PLAYWRIGHT_MCP: '0' })
  const command = process.env.CLI_EXE ?? process.execPath
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } } }))
  const args = [...(process.env.CLI_EXE ? [] : [join(repo, 'src/bootstrap-entry.ts')]), '-p', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--include-partial-messages']
  if (action !== 'no-host') args.push('--input-format', 'stream-json', '--permission-prompt-tool', 'stdio')
  else args.push('Ask the question and continue after the answer.')
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const frames: any[] = []
  let buffer = '', stderr = '', card: any, askedAt = 0, cancelledAt = 0
  const send = (value: any) => child.stdin.write(JSON.stringify(value) + '\n')
  let timer: ReturnType<typeof setTimeout>
  try {
    const result = await new Promise<any>((resolveResult, reject) => {
      timer = setTimeout(() => reject(new Error(`${provider}/${action}: timed out; ${stderr.slice(-700)}`)), action === 'timeout' ? 340000 : 45000)
      child.once('error', reject)
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('exit', code => { if (!frames.some(f => f.type === 'result')) reject(new Error(`${provider}/${action}: exit ${code}; ${stderr.slice(-700)}`)) })
      child.stdout.on('data', chunk => {
        buffer += chunk
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
          let frame: any; try { frame = JSON.parse(raw) } catch { continue }
          frames.push(frame)
          if (frame.type === 'control_response' && frame.response.request_id === 'init') send({ type: 'user', message: { role: 'user', content: 'Ask the question and continue after the answer.' } })
          if (frame.type === 'control_request' && frame.request.subtype === 'can_use_tool') {
            card = frame; askedAt = Date.now()
            assert.equal(frame.request.tool_name, 'AskUserQuestion')
            assert.ok(Math.abs(frame.request.auto_question.deadline_ms - askedAt - 300000) < 1500)
            assert.equal(frame.request.input.answers, undefined)
            if (action === 'human') send({ type: 'control_response', response: { request_id: frame.request_id, subtype: 'success', response: { behavior: 'allow', updatedInput: { ...frame.request.input, answers: humanAnswers } } } })
            if (action === 'interrupt') send({ type: 'control_request', request_id: 'stop', request: { subtype: 'interrupt' } })
          }
          if (frame.type === 'control_cancel_request' && frame.request_id === card?.request_id) cancelledAt = Date.now()
          if (frame.type === 'result') resolveResult(frame)
        }
      })
      if (action !== 'no-host') send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
      else {
        // No-host must be cancellable while waiting rather than returning
        // the model's draft. Killing is a real process-exit boundary.
        const stop = setInterval(() => {
          if (!stderr.includes('等待用户回答')) return
          clearInterval(stop)
          assert.equal(fixture.requests.length, 1)
          resolveResult({ interrupted: true })
        }, 100)
        child.once('exit', () => clearInterval(stop))
      }
    })
    if (action === 'interrupt' || action === 'no-host') assert.equal(fixture.requests.length, 1, 'interruption cannot continue the model turn')
    else {
      assert.equal(result.is_error, false, result.result)
      assert.match(result.result, /AUTO_QUESTION_DONE/)
      const results = frames.filter(frame => frame.type === 'user' && frame.tool_use_result?.answers)
      assert.equal(results.length, 1)
      assert.deepEqual(results[0].tool_use_result.answers, action === 'human' ? humanAnswers : {
        'Implementation choice?': 'Second (Recommended)', 'Verification choices?': 'Second check （推荐）, Third check (推荐)',
      })
      assert.equal(results[0].tool_use_result.answerSource, action === 'human' ? 'user' : 'auto_recommended')
      if (action === 'timeout') {
        assert.ok(cancelledAt - askedAt >= 299000, `not a real five-minute wait: ${cancelledAt - askedAt}`)
        assert.ok(cancelledAt >= card.request.auto_question.deadline_ms, 'CLI did not wait until its authoritative deadline')
        // A late host response after cancellation cannot create another result.
        send({ type: 'control_response', response: { request_id: card.request_id, subtype: 'success', response: { behavior: 'allow', updatedInput: { ...fixtureQuestions, answers: humanAnswers } } } })
        await new Promise(resolve => setTimeout(resolve, 150))
        assert.equal(fixture.requests.length, 2)
      }
    }
    console.log(`PASS ${provider}/${action}: ${fixture.requests.length} API requests${action === 'timeout' ? `; real wait=${cancelledAt - askedAt}ms` : ''}`)
  } finally {
    clearTimeout(timer!)
    if (child.exitCode === null) {
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { child.kill() } }
      else child.kill('SIGKILL')
    }
    fixture.server.closeAllConnections(); await new Promise<void>(resolve => fixture.server.close(() => resolve()))
    writeFileSync(join(output, `${provider}-${action}.json`), JSON.stringify({ frames, requests: fixture.requests, stderr, askedAt, cancelledAt }, null, 2))
    rmSync(root, { recursive: true, force: true })
  }
}
for (const provider of providers) await run(provider, slow ? 'timeout' : 'human')
if (!slow) { await run('anthropic', 'interrupt'); await run('anthropic', 'no-host') }

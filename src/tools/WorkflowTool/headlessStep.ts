/** Cross-provider process transport. Lifecycle/recording belongs to the engine. */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { modelProfileEnvPatch, type ModelProfile } from '../../utils/customApiStorage.js'
import { errorMessage } from '../../utils/errors.js'
import { killPosixProcessTree } from '../../utils/processTree.js'
import { AgentUsageTracker } from '../../utils/agentUsage.js'
import { WORKFLOW_STEP_CHILD_ENV } from './stepChildEnv.js'

export interface StepOutcome {
  status: 'completed' | 'failed' | 'stopped'
  output: string
  error?: string
  tokens?: number
}

/** Resolve against the selected provider without mutating the parent's env. */
export function profileStepModel(profile: ModelProfile, requested?: string): string {
  const model = requested?.trim()
  if (!model || model === 'inherit') return profile.model
  const tier = /^(opus|sonnet|haiku)(\[\d+m\])?$/i.exec(model)
  if (!tier) return model
  const mapped = tier[1]!.toLowerCase() === 'opus' ? profile.defaultOpusModel
    : tier[1]!.toLowerCase() === 'sonnet' ? profile.defaultSonnetModel : profile.defaultHaikuModel
  const resolved = mapped || profile.model
  return tier[2] && !/\[\d+m\]$/i.test(resolved) ? resolved + tier[2] : resolved
}

export function spawnHeadlessStep(opts: {
  prompt: string
  model: string
  agent?: string
  profile: ModelProfile
  permissionMode: string
  cwd: string
  signal: AbortSignal
  timeoutSec?: number
  onMessage: (message: Record<string, any>) => Promise<void>
}): Promise<StepOutcome> {
  const { prompt, model, agent, profile, permissionMode, cwd, signal, timeoutSec, onMessage } = opts
  if (signal.aborted) return Promise.resolve({ status: 'stopped', output: '', error: '步骤被用户停止' })
  return new Promise(resolve => {
    const exe = process.env.DOGE_WORKFLOW_EXECUTABLE ?? process.execPath
    // Sending long prompts on stdin avoids Windows' 32KB command-line limit.
    // The parent records these messages as a sidechain, so the child must not
    // create an independent conversation that appears in /resume or the sidebar.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence',
      '--model', model, '--permission-mode', permissionMode,
      ...(agent ? ['--agent', agent] : [])]
    const env = { ...process.env } as Record<string, string>
    delete env.DOGE_APP_WORKSPACE_MARKER
    delete env.DOGE_APP_TURN_MARKER
    delete env.CLAUDE_CODE_EFFORT_LEVEL
    delete env.CLAUDE_CODE_SUBAGENT_MODEL
    env.DOGE_WORKFLOW_TRANSCRIPTS = '1'
    // 步骤子进程身份标记：print.ts 据此在模型答完后跳过「等后台任务清零」
    // 并清理遗留后台命令（语义契约见 stepChildEnv.ts）
    env[WORKFLOW_STEP_CHILD_ENV] = '1'
    for (const [name, value] of Object.entries(modelProfileEnvPatch(profile))) {
      if (value) env[name] = value
      else delete env[name]
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    } catch (err) {
      resolve({ status: 'failed', output: '', error: `无法启动子进程：${errorMessage(err)}` })
      return
    }
    let buffer = '', stderr = '', resultText = '', resultSeen = false, isError = false, timedOut = false
    const usage = new AgentUsageTracker()
    let records = Promise.resolve()
    let recordError: string | undefined
    const decoder = new StringDecoder('utf8')
    const consume = (line: string) => {
      let message: Record<string, any>
      try { message = JSON.parse(line) } catch { return }
      usage.observe(message as Parameters<AgentUsageTracker['observe']>[0])
      if (message.type === 'result') {
        resultSeen = true
        resultText = typeof message.result === 'string' ? message.result : ''
        isError = message.is_error === true || (message.subtype && message.subtype !== 'success')
        if (isError && !resultText && Array.isArray(message.errors)) resultText = message.errors.join('\n')
      }
      records = records.then(() => onMessage(message)).catch(err => { recordError ??= errorMessage(err) })
    }
    const drain = () => {
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
      }
    }
    let killing: Promise<void> | undefined
    const killTree = () => {
      if (killing || !child.pid) return
      killing = new Promise<void>(done => {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.once('error', () => { child.kill('SIGKILL'); done() })
          killer.once('close', () => done())
        } else {
          killPosixProcessTree(child.pid!)
          done()
        }
      })
    }
    const onAbort = () => killTree()
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    const timer = timeoutSec ? setTimeout(() => { timedOut = true; killTree() }, timeoutSec * 1000) : undefined
    let spawnError: string | undefined
    child.once('error', err => { spawnError = errorMessage(err) })
    child.stdin!.on('error', err => { if (!signal.aborted && !timedOut) spawnError ??= errorMessage(err) })
    child.stdout!.on('data', data => { buffer += decoder.write(data); drain() })
    child.stderr!.on('data', data => { stderr = (stderr + data.toString()).slice(-4096) })
    child.once('close', async code => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      buffer += decoder.end()
      drain()
      if (buffer.trim()) consume(buffer)
      await killing
      await records
      const outcome = (status: StepOutcome['status'], error?: string) => resolve({ status, output: resultText, error, tokens: usage.totalTokens() })
      if (signal.aborted) return outcome('stopped', '步骤被用户停止')
      if (timedOut) return outcome('failed', `步骤超时（> ${timeoutSec}s）`)
      if (spawnError) return outcome('failed', `子进程错误：${spawnError}`)
      if (recordError) return outcome('failed', `步骤记录失败：${recordError}`)
      if (code !== 0) return outcome('failed', `子进程退出码 ${code}：${meaningfulStderrLine(stderr)}`)
      if (!resultSeen) return outcome('failed', `子进程没有返回结果：${meaningfulStderrLine(stderr)}`)
      if (isError) return outcome('failed', resultText.trim().split('\n')[0] || '子进程执行失败')
      outcome('completed')
    })
    if (!signal.aborted) child.stdin!.end(prompt)
    else child.stdin!.destroy()
  })
}

function meaningfulStderrLine(stderr: string): string {
  return stderr.split(/\r?\n/).map(line => line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').trim())
    .filter(line => line && !line.startsWith('[DOGE-DEBUG]')).at(-1) ?? '无输出'
}

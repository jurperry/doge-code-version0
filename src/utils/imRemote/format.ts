import type { ImRemoteConfig } from './types.js'

/**
 * Pure helpers shared by the daemon and adapters: IM command parsing,
 * pairing checks, summary cadence and message formatting. No I/O here so
 * every rule is unit-testable.
 */

export type ImCommand =
  | { kind: 'pair'; code: string }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'skip' }
  | { kind: 'pick'; indices: number[] }

/** Parse an IM text into a control command; null means "prompt content". */
export function parseImCommand(text: string): ImCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head, ...rest] = trimmed.slice(1).split(/\s+/)
  const arg = rest.join(' ')
  switch ((head ?? '').toLowerCase()) {
    case 'pair':
      return /^[a-z0-9]{6}$/i.test(arg) ? { kind: 'pair', code: arg.toLowerCase() } : null
    case 'status':
    case '状态':
      return { kind: 'status' }
    case 'stop':
    case '停止':
      return { kind: 'stop' }
    case 'help':
    case '帮助':
      return { kind: 'help' }
    case 'allow':
    case 'yes':
    case '允许':
      return { kind: 'allow' }
    case 'deny':
    case 'no':
    case '拒绝':
      return { kind: 'deny' }
    case 'skip':
    case '跳过':
      return { kind: 'skip' }
    default: {
      // "/1", "/2,3" — option pick for a pending ask.
      if (/^\d+(,\d+)*$/.test(head ?? '')) {
        const indices = (head ?? '').split(',').map(n => parseInt(n, 10))
        if (indices.every(n => n >= 1 && n <= 9)) {
          return { kind: 'pick', indices }
        }
      }
      return null
    }
  }
}

export function isUserAllowed(userId: string, allowedUsers: string[]): boolean {
  return allowedUsers.includes(userId)
}

export function isPairCodeValid(config: ImRemoteConfig, code: string, now: number): boolean {
  if (!config.pair) return false
  return (
    config.pair.code === code.toLowerCase() &&
    config.pair.expires > now &&
    /^[a-z0-9]{6}$/.test(code.toLowerCase())
  )
}

/** Every N-th tool call triggers a summary notification. */
export function summaryDue(count: number, every: number): boolean {
  return count > 0 && every > 0 && count % every === 0
}

export function truncateText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return clean.slice(0, max - 1) + '…'
}

const TURN_TEXT_LIMIT = 1500
const SUMMARY_TEXT_LIMIT = 200

export function formatTurnMessage(text: string, aborted: boolean, durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  const head = aborted ? '⛔ 回合已中断（约 ' + seconds + 's）' : '✅ 回合完成（约 ' + seconds + 's）'
  const body = truncateText(text, TURN_TEXT_LIMIT)
  return body ? head + '\n\n' + body : head
}

export function formatToolSummary(count: number, lastTool: string): string {
  return (
    '⏳ 进度：已执行 ' +
    count +
    ' 次工具调用' +
    (lastTool ? '，最近：' + truncateText(lastTool, SUMMARY_TEXT_LIMIT) : '')
  )
}

export function formatAgentEvent(
  ev: 'started' | 'completed' | 'failed' | 'stopped' | 'teams_on',
  name?: string,
  summary?: string,
): string {
  const who = name ? '「' + truncateText(name, 60) + '」' : ''
  switch (ev) {
    case 'started':
      return '🤖 已启用子代理 ' + who + (summary ? '\n' + truncateText(summary, SUMMARY_TEXT_LIMIT) : '')
    case 'completed':
      return '🏁 子代理已完成 ' + who + (summary ? '\n' + truncateText(summary, SUMMARY_TEXT_LIMIT) : '')
    case 'failed':
      return '❌ 子代理失败 ' + who + (summary ? '\n' + truncateText(summary, SUMMARY_TEXT_LIMIT) : '')
    case 'stopped':
      return '🛑 子代理已停止 ' + who
    case 'teams_on':
      return '👥 已启用 agent-teams：后续任务可能由多个代理协作完成，完成时会另行通知。'
  }
}

export function formatPermissionMessage(
  tool: string,
  title: string,
  detail: string,
): string {
  return (
    '🔐 需要授权：' +
    tool +
    (title ? '\n' + truncateText(title, 200) : '') +
    (detail ? '\n' + truncateText(detail, 400) : '') +
    '\n\n回复 /allow 允许，/deny 拒绝。'
  )
}

export function formatAskMessage(
  question: string,
  options: string[],
  multi: boolean,
): string {
  const lines = options.map((opt, i) => '/' + (i + 1) + ' ' + truncateText(opt, 80))
  return (
    '❓ ' +
    truncateText(question, 200) +
    '\n' +
    lines.join('\n') +
    (multi ? '\n（可多选：/1,3）' : '') +
    '\n跳过请回 /skip'
  )
}

/**
 * Last non-empty assistant text block from a message list — the turn's
 * final reply that gets forwarded to the IM user. Loosely typed on
 * purpose: TUI and headless message types differ in nominal types only.
 */
export function lastAssistantText(
  messages: Array<{ type?: string; message?: { content?: unknown } }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.type !== 'assistant') continue
    const content = m.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter(
        (b): b is { type: 'text'; text: string } =>
          !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map(b => b.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

export const IM_HELP_TEXT = [
  'Doge Code 远程控制指令：',
  '/pair <配对码> — 绑定本账号（设置页获取配对码）',
  '/status — 查看会话与守护进程状态',
  '/stop — 中断当前运行中的回合',
  '/allow /deny — 应答权限请求',
  '/1 … /9 — 选择提问选项（多选用 /1,3）',
  '/skip — 跳过当前提问',
  '其余文本将作为提示词发送给当前会话。',
].join('\n')

/**
 * Extract a single AskUserQuestion payload for IM display: the first
 * question plus its option labels. Returns null when the input does not
 * look like an AskUserQuestion payload.
 */
export function parseAskPayload(
  input: unknown,
): { question: string; options: string[]; multi: boolean } | null {
  if (!input || typeof input !== 'object') return null
  const questions = (input as Record<string, unknown>).questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  const first = questions[0]
  if (!first || typeof first !== 'object') return null
  const q = first as Record<string, unknown>
  if (typeof q.question !== 'string') return null
  const rawOptions = Array.isArray(q.options) ? q.options : []
  const options: string[] = []
  for (const opt of rawOptions) {
    if (opt && typeof opt === 'object' && typeof (opt as Record<string, unknown>).label === 'string') {
      options.push((opt as Record<string, unknown>).label as string)
    }
  }
  if (options.length === 0) return null
  return {
    question: q.question,
    options: options.slice(0, 9),
    multi: q.multiSelect === true,
  }
}

/**
 * Build the `updatedInput.answers` patch for an AskUserQuestion from the
 * picked option indices. Mirrors the app's ChatPane submission shape:
 * answers maps question text to a comma-joined label list.
 */
export function buildAskAnswers(
  input: unknown,
  indices: number[],
): Record<string, unknown> | null {
  const ask = parseAskPayload(input)
  if (!ask) return null
  const picked = indices
    .map(i => ask.options[i - 1])
    .filter((label): label is string => !!label)
  if (picked.length === 0) return null
  return { ...(input as Record<string, unknown>), answers: { [ask.question]: picked.join(', ') } }
}

/** Bounded JSON preview for relay detail lines (shared by TUI + headless wiring). */
export function safeJsonPreview(input: Record<string, unknown>, max = 400): string {
  try {
    return JSON.stringify(input).slice(0, max)
  } catch {
    return ''
  }
}

/** Directory basename used as the session label shown in IM /status.
 * 双分隔符：Windows 的 process.cwd() 是反斜杠路径，只按 / 切会返回全路径。 */
export function lastPathSegment(path: string): string {
  return path.split(/[\\/]/).pop() || 'doge'
}

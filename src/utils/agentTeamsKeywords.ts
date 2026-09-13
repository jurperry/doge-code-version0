/**
 * Keyword trigger for agent-teams auto-enablement.
 *
 * When the user's prompt explicitly expresses intent to use multi-agent
 * collaboration — in English ("agent teams", "agent swarm") or Chinese
 * ("多agent协作", "智能体集群", ...) — the session is opted into agent
 * teams and the input is re-routed through /agent-teams (see the redirect
 * in processUserInput.ts, modeled on the ultraplan keyword path).
 *
 * Exclusions mirror src/utils/ultraplan/keyword.ts where they apply:
 * - Slash-prefixed input never matches (that's a command invocation).
 * - Occurrences inside paired delimiters (backticks, quotes, brackets)
 *   are skipped so quoted/code content can't trigger.
 * - Path/identifier-like context (`src/agent-teams/foo.ts`,
 *   `--agent-teams-mode`, `agent_teams.py`) is skipped for ASCII edges.
 * - A trailing ?/？ means a question about the feature, not a request.
 *
 * CJK keywords (多agent协作 etc.) cannot use \b — CJK characters are
 * non-word chars in JS regex, so boundaries exist around them already —
 * so they match as plain substrings; boundary/path checks are applied
 * per side only when that side of the keyword is an ASCII word char.
 */

const ASCII_KEYWORDS = [
  'agent teams',
  'agent team',
  'agent swarms',
  'agent swarm',
]

const CJK_KEYWORDS = [
  '多agent协作',
  '多agent协同',
  '多智能体协同',
  '多智能体协作',
  'agent集群',
  '智能体集群',
  '智能体队伍',
]

const OPEN_TO_CLOSE: Record<string, string> = {
  '`': '`',
  '"': '"',
  '<': '>',
  '{': '}',
  '[': ']',
  '(': ')',
  "'": "'",
}

const isWord = (ch: string | undefined) =>
  !!ch && /[\p{L}\p{N}_]/u.test(ch)

/** Paired-delimiter ranges, same scanner shape as ultraplan keyword.ts. */
function findQuotedRanges(text: string): Array<{ start: number; end: number }> {
  const quotedRanges: Array<{ start: number; end: number }> = []
  let openQuote: string | null = null
  let openAt = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (openQuote) {
      if (openQuote === '[' && ch === '[') {
        openAt = i
        continue
      }
      if (ch !== OPEN_TO_CLOSE[openQuote]) continue
      if (openQuote === "'" && isWord(text[i + 1])) continue
      quotedRanges.push({ start: openAt, end: i + 1 })
      openQuote = null
    } else if (
      (ch === '<' && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!)) ||
      (ch === "'" && !isWord(text[i - 1])) ||
      (ch !== '<' && ch !== "'" && ch in OPEN_TO_CLOSE)
    ) {
      openQuote = ch
      openAt = i
    }
  }
  return quotedRanges
}

/**
 * A side needs a boundary check only when the keyword char on that side is
 * an ASCII word character — CJK sides rely on natural substring semantics
 * (Chinese has no spaces and \b treats CJK as non-word anyway).
 */
const isAsciiWordChar = (ch: string | undefined) =>
  !!ch && /[a-zA-Z0-9_]/.test(ch)

function keywordOccurs(text: string, keyword: string): boolean {
  // 'g' is required: rejected matches resume scanning at lastIndex — a
  // non-global exec would return the same match forever.
  const re = new RegExp(
    keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    'gi',
  )
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    // Zero-width safety (cannot happen with these keywords, but guard anyway)
    if (end === start) {
      re.lastIndex++
      continue
    }
    const before = text[start - 1]
    const after = text[end]
    // Question about the feature ("agent teams?"), not a request to use it.
    const isQuestion = after === '?' || after === '？'
    let rejected = isQuestion
    if (!rejected && isAsciiWordChar(keyword[0]!)) {
      // ASCII-word neighbor means the keyword is part of a larger identifier
      // ("multiagent teams"). A CJK neighbor is normal Chinese prose
      // ("使用agent集群") and must NOT reject — hence isAsciiWordChar, not
      // the wider \p{L} isWord.
      if (
        isAsciiWordChar(before) ||
        before === '/' ||
        before === '\\' ||
        before === '-'
      ) {
        rejected = true
      }
    }
    if (!rejected && isAsciiWordChar(keyword[keyword.length - 1]!)) {
      if (
        isAsciiWordChar(after) ||
        after === '/' ||
        after === '\\' ||
        after === '-'
      ) {
        rejected = true
      } else if (after === '.' && isWord(text[end + 1])) {
        rejected = true
      }
    }
    if (!rejected) return true
    re.lastIndex = end
  }
  return false
}

/**
 * True when the text contains an agent-teams launch directive outside
 * quotes/paths. Slash-prefixed input never matches (command invocation).
 */
export function hasAgentTeamsKeyword(text: string): boolean {
  if (!text.trim() || text.startsWith('/')) return false
  const quotedRanges = findQuotedRanges(text)
  if (quotedRanges.length === 0) {
    return [...ASCII_KEYWORDS, ...CJK_KEYWORDS].some(k =>
      keywordOccurs(text, k),
    )
  }
  // Strip quoted ranges before matching — simpler than position filtering
  // for multi-byte CJK keywords, and the scanner keeps code/quote payloads
  // from triggering while normal prose (rarely fully quoted) still matches.
  const stripped = text
    .split('')
    .filter((_, i) => !quotedRanges.some(r => i >= r.start && i < r.end))
    .join('')
  return [...ASCII_KEYWORDS, ...CJK_KEYWORDS].some(k =>
    keywordOccurs(stripped, k),
  )
}

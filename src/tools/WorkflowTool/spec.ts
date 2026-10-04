/**
 * Declarative workflow spec — parsing, argument binding and interpolation.
 *
 * Workflow files are markdown with a YAML frontmatter:
 *   ~/.doge/workflows/*.md      (user scope)
 *   <proj>/.doge/workflows/*.md (project scope, loaded walking up to git root)
 *
 * Frontmatter fields:
 *   name           command name (kebab-case; defaults to file basename)
 *   description    one-liner shown in autocomplete + /workflows
 *   argument-hint  e.g. "[scope]" shown after the command name
 *   inputs[]       typed parameters {key,type,default,options,required}
 *   steps[]        sequential steps:
 *     id                 unique step id (referenced by {{steps.<id>.output}})
 *     title              display title (defaults to id)
 *     agent              agent definition name (~/.doge/agents); default general-purpose
 *     model              alias (sonnet/opus/haiku) or exact model id, same provider
 *     profile            providerName from modelProfiles — runs the step in a
 *                        headless subprocess with that provider's env (cross-API)
 *     continue-on-error  keep running the workflow when this step fails
 *     timeout            per-step wall-clock budget in seconds
 *     prompt             the step instruction; supports {{args.*}} / {{steps.*}}
 *
 * Body (below the frontmatter) is free-form documentation shown in listings.
 *
 * Everything in this module is pure — no IO, no AppState. Unit-testable.
 */

export type WorkflowInputType = 'string' | 'number' | 'boolean' | 'select'

export interface WorkflowInput {
  key: string
  type: WorkflowInputType
  default?: string
  /** select only — the allowed values */
  options?: string[]
  required?: boolean
}

export interface WorkflowStep {
  id: string
  title: string
  /** agent definition name; undefined = general-purpose */
  agent?: string
  /** alias or exact model id within the session provider */
  model?: string
  /** providerName in modelProfiles — subprocess cross-API step */
  profile?: string
  continueOnError: boolean
  /** wall-clock budget in seconds */
  timeoutSec?: number
  prompt: string
}

export interface WorkflowSpec {
  name: string
  description: string
  argumentHint?: string
  inputs: WorkflowInput[]
  steps: WorkflowStep[]
  /** free-form markdown body below the frontmatter */
  body: string
  /** absolute path of the source file */
  sourcePath: string
  /** 'user' | 'project' (raw SettingSource kept for callers that need it) */
  scope: string
}

export const WORKFLOW_MAX_STEPS = 20

export type ParsedWorkflow = { spec: WorkflowSpec | null; errors: string[] }

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const INPUT_TYPES: readonly WorkflowInputType[] = [
  'string',
  'number',
  'boolean',
  'select',
]

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseInputs(raw: unknown, errors: string[]): WorkflowInput[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    errors.push('inputs 必须是列表')
    return []
  }
  const inputs: WorkflowInput[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      errors.push('inputs 条目必须是对象')
      continue
    }
    const rec = item as Record<string, unknown>
    const key = str(rec.key)
    if (!key) {
      errors.push('inputs 条目缺少 key')
      continue
    }
    if (seen.has(key)) {
      errors.push(`inputs 重复 key：${key}`)
      continue
    }
    seen.add(key)
    const type = str(rec.type) as WorkflowInputType | undefined
    if (type && !INPUT_TYPES.includes(type)) {
      errors.push(`inputs.${key} 类型无效：${type}`)
      continue
    }
    const input: WorkflowInput = { key, type: type ?? 'string' }
    const def = str(rec.default)
    if (def !== undefined) input.default = def
    if (Array.isArray(rec.options)) {
      input.options = rec.options
        .filter((o): o is string => typeof o === 'string')
        .map(o => o.trim())
        .filter(Boolean)
    }
    if (input.type === 'select' && !input.options?.length) {
      errors.push(`inputs.${key} 是 select 但没有 options`)
      continue
    }
    if (rec.required === true) input.required = true
    if (
      input.type === 'select' &&
      input.default !== undefined &&
      input.options &&
      !input.options.includes(input.default)
    ) {
      errors.push(`inputs.${key} 默认值不在 options 里`)
      continue
    }
    inputs.push(input)
  }
  return inputs
}

function parseSteps(raw: unknown, errors: string[]): WorkflowStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('steps 缺失或为空')
    return []
  }
  if (raw.length > WORKFLOW_MAX_STEPS) {
    errors.push(`步骤数超过上限 ${WORKFLOW_MAX_STEPS}`)
    return []
  }
  const steps: WorkflowStep[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      errors.push('steps 条目必须是对象')
      continue
    }
    const rec = item as Record<string, unknown>
    const id = str(rec.id)
    if (!id) {
      errors.push('步骤缺少 id')
      continue
    }
    if (seen.has(id)) {
      errors.push(`步骤 id 重复：${id}`)
      continue
    }
    seen.add(id)
    const prompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : ''
    if (!prompt) {
      errors.push(`步骤 ${id} 缺少 prompt`)
      continue
    }
    const step: WorkflowStep = {
      id,
      title: str(rec.title) ?? id,
      continueOnError: rec['continue-on-error'] === true,
      prompt,
    }
    const agent = str(rec.agent)
    if (agent) step.agent = agent
    const model = str(rec.model)
    if (model) step.model = model
    const profile = str(rec.profile)
    if (profile) step.profile = profile
    if (typeof rec.timeout === 'number' && rec.timeout > 0) {
      step.timeoutSec = Math.floor(rec.timeout)
    }
    steps.push(step)
  }
  return steps
}

function nameFromFile(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.md$/i, '').trim()
}

/** Parse one workflow markdown file (frontmatter + body) into a spec. */
export function parseWorkflowSpec(raw: {
  frontmatter: Record<string, unknown>
  content: string
  filePath: string
  source: string
}): ParsedWorkflow {
  const errors: string[] = []
  const fm = raw.frontmatter ?? {}
  const name = str(fm.name) ?? nameFromFile(raw.filePath)
  if (!NAME_RE.test(name)) {
    errors.push(
      `无效名称：${name}（仅限字母数字、连字符、下划线，且以字母数字开头）`,
    )
  }
  const description = str(fm.description) ?? '(未描述的工作流)'
  const spec: WorkflowSpec = {
    name,
    description,
    argumentHint: str(fm['argument-hint']),
    inputs: parseInputs(fm.inputs, errors),
    steps: parseSteps(fm.steps, errors),
    body: (raw.content ?? '').trim(),
    sourcePath: raw.filePath,
    scope: raw.source === 'userSettings' ? 'user' : raw.source === 'projectSettings' ? 'project' : raw.source,
  }
  if (errors.length > 0) return { spec: null, errors }
  return { spec, errors: [] }
}

/**
 * Bind a raw argument string ("foo bar k=v") to the declared inputs.
 * Positional tokens fill declared inputs in order; `key=value` tokens override.
 * Defaults fill the rest; required inputs missing → error.
 */
export function parseWorkflowArgs(
  spec: WorkflowSpec,
  argsString: string,
): { values: Record<string, string>; errors: string[] } {
  const errors: string[] = []
  const values: Record<string, string> = {}
  const tokens = argsString.trim().length
    ? argsString.trim().split(/\s+/)
    : []
  const keyValues = new Map<string, string>()
  const positional: string[] = []
  for (const token of tokens) {
    const m = token.match(/^([A-Za-z0-9_-]+)=(.*)$/)
    if (m) keyValues.set(m[1]!, m[2]!)
    else positional.push(token)
  }
  const known = new Set(spec.inputs.map(i => i.key))
  for (const key of keyValues.keys()) {
    if (!known.has(key)) errors.push(`未知参数：${key}`)
  }
  let pos = 0
  for (const input of spec.inputs) {
    const kv = keyValues.get(input.key)
    if (kv !== undefined) {
      values[input.key] = kv
      continue
    }
    if (pos < positional.length) {
      values[input.key] = positional[pos]!
      pos++
      continue
    }
    if (input.default !== undefined) {
      values[input.key] = input.default
      continue
    }
    if (input.required) errors.push(`缺少必填参数：${input.key}`)
  }
  if (pos < positional.length) {
    errors.push(`多余的位置参数：${positional.slice(pos).join(' ')}`)
  }
  for (const input of spec.inputs) {
    const v = values[input.key]
    if (v === undefined) continue
    if (input.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) {
      errors.push(`参数 ${input.key} 需要数字，得到：${v}`)
    }
    if (input.type === 'boolean' && !/^(true|false)$/i.test(v)) {
      errors.push(`参数 ${input.key} 需要 true/false，得到：${v}`)
    }
    if (input.type === 'select' && input.options && !input.options.includes(v)) {
      errors.push(
        `参数 ${input.key} 必须是 ${input.options.join(' | ')} 之一，得到：${v}`,
      )
    }
  }
  return { values, errors }
}

export interface InterpolationContext {
  args: Record<string, string>
  steps: Record<string, { status: string; output: string }>
}

/**
 * Pure string substitution: {{args.key}} and {{steps.id.output}} /
 * {{steps.id.status}}. Unknown references are left verbatim so broken
 * references stay visible in the assembled prompt instead of vanishing.
 */
export function interpolate(text: string, ctx: InterpolationContext): string {
  return text.replace(
    /\{\{\s*(args|steps)\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\s*\}\}/g,
    (whole, group: string, id: string, field: string | undefined) => {
      if (group === 'args') {
        const v = ctx.args[id]
        return v === undefined ? whole : v
      }
      const step = ctx.steps[id]
      if (!step) return whole
      const key = field ?? 'output'
      if (key === 'output') return step.output
      if (key === 'status') return step.status
      return whole
    },
  )
}

/** One-line summary for the /workflows listing (pure — no engine import). */
export function formatWorkflowSummary(spec: WorkflowSpec): string {
  const bits = spec.steps.map(s => {
    const who = s.profile
      ? `@${s.profile}`
      : s.model
        ? `:${s.model}`
        : s.agent
          ? `(${s.agent})`
          : ''
    return `${s.id}${who}`
  })
  return `${spec.name} — ${spec.description} [${bits.join(' → ')}]`
}

import type { ToolPermissionContext } from '../../Tool.js'
import { isZeroAskAutoActive, isZeroAskPlanInterlude } from './autoBypass.js'
import type { PermissionDenyDecision } from './PermissionResult.js'

export const AUTO_QUESTION_TIMEOUT_MS = 300_000

export type QuestionInput = {
  questions?: { question?: string; options?: { label?: string }[]; multiSelect?: boolean }[]
  answers?: Record<string, string>
}

export function isAutoQuestionContext(context: Pick<ToolPermissionContext, 'mode' | 'prePlanMode' | 'autoPlan'>): boolean {
  return isZeroAskPlanInterlude(context)
}

/** Recheck at the interaction boundary as a queued Plan request may be stale. */
export function getAutoQuestionRejection(context: Pick<ToolPermissionContext, 'mode'>): PermissionDenyDecision | undefined {
  if (!isZeroAskAutoActive(context)) return undefined
  return {
    behavior: 'deny',
    decisionReason: { type: 'mode', mode: 'bypassPermissions' },
    message: 'Auto execution cannot ask the user questions. Continue autonomously using the existing request and authorization. Do not ask in plain text, repeat this question, or enter Plan merely to request commit, merge, or completion approval. If the task genuinely needs planning, use EnterPlanMode; clarification is allowed inside Plan.',
  }
}

/** Match only an explicit trailing recommendation marker, never description text. */
export function buildRecommendedAnswers(input: QuestionInput): Record<string, string> | null {
  if (!input.questions?.length) return null
  const answers: Record<string, string> = {}
  for (const question of input.questions) {
    if (typeof question?.question !== 'string' || !question.question.trim()) return null
    const options = question.options?.filter(option => typeof option?.label === 'string' && option.label.trim()) ?? []
    if (!options.length) return null
    const recommended = options.filter(option => /(?:\(\s*(?:recommended|推荐)\s*\)|（\s*(?:recommended|推荐)\s*）)\s*$/i.test(option.label!))
    const selected = recommended.length ? recommended : options.slice(0, 1)
    answers[question.question] = (question.multiSelect ? selected : selected.slice(0, 1)).map(option => option.label).join(', ')
  }
  return answers
}

/** Take this snapshot when a request enters its interaction channel. */
export function getAutoQuestionDeadline(context: Pick<ToolPermissionContext, 'mode' | 'prePlanMode' | 'autoPlan'>, now = Date.now()): number | undefined {
  return isAutoQuestionContext(context) ? now + AUTO_QUESTION_TIMEOUT_MS : undefined
}

export function buildAutoQuestionDecision(input: Record<string, unknown>) {
  const answers = buildRecommendedAnswers(input as QuestionInput)
  return answers
    ? { behavior: 'allow' as const, updatedInput: { ...input, answers, _autoQuestionAnswerSource: 'auto_recommended' } }
    : { behavior: 'deny' as const, message: 'Cannot automatically answer questions without valid options.' }
}

import type { ToolPermissionContext } from '../../Tool.js'
import { isZeroAskAutoActive, isZeroAskPlanInterlude } from './autoBypass.js'

export const AUTO_QUESTION_TIMEOUT_MS = 300_000

export type QuestionInput = {
  questions?: { question?: string; options?: { label?: string }[]; multiSelect?: boolean }[]
  answers?: Record<string, string>
}

export function isAutoQuestionContext(context: Pick<ToolPermissionContext, 'mode' | 'prePlanMode' | 'autoPlan'>): boolean {
  return isZeroAskAutoActive(context) || isZeroAskPlanInterlude(context)
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

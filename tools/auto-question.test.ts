import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sandbox = join(import.meta.dir, '..', 'test', 'auto-question-unit')
mkdirSync(sandbox, { recursive: true })
const originalConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = sandbox
const { resetSettingsCache } = await import('../src/utils/settings/settingsCache.js')
const { AskUserQuestionTool, buildAutoAnswers } = await import('../src/tools/AskUserQuestionTool/AskUserQuestionTool.js')
const { hasPermissionsToUseTool } = await import('../src/utils/permissions/permissions.js')
const { getAutoQuestionDeadline } = await import('../src/utils/permissions/autoQuestion.js')
const automaticPlan = { mode: 'plan', prePlanMode: 'bypassPermissions', autoPlan: true }
const context = (mode: any): any => ({
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: { alwaysDenyRules: {}, alwaysAskRules: {}, alwaysAllowRules: {}, ...mode } }),
})
const question = (labels: string[], multiSelect = false, text = 'Choose?') => ({
  question: text, header: 'Choice', multiSelect, options: labels.map(label => ({ label, description: 'Tradeoff' })),
})
beforeEach(() => { writeFileSync(join(sandbox, 'settings.json'), '{}'); resetSettingsCache() })
afterAll(() => {
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  resetSettingsCache()
  rmSync(sandbox, { recursive: true, force: true })
})

for (const marker of ['(Recommended)', '（Recommended）', '(recommended)', '(推荐)', '（推荐）']) {
  test(`recommendation at end of the second label wins: ${marker}`, () => {
    expect(buildAutoAnswers({ questions: [question(['First', `Second ${marker}`])] })).toEqual({ 'Choose?': `Second ${marker}` })
  })
}
test('no recommendation falls back to the first usable option', () => {
  expect(buildAutoAnswers({ questions: [question(['First', 'Recommended text'])] })).toEqual({ 'Choose?': 'First' })
})
test('single select uses first marked option; multi select uses all marked options', () => {
  const labels = ['First', 'Second (推荐)', 'Third （RECOMMENDED）']
  expect(buildAutoAnswers({ questions: [question(labels)] })).toEqual({ 'Choose?': labels[1] })
  expect(buildAutoAnswers({ questions: [question(labels, true)] })).toEqual({ 'Choose?': labels.slice(1).join(', ') })
})
test('all four questions are answered and model prefilled answers cannot win', () => {
  const questions = ['A?', 'B?', 'C?', 'D?'].map(text => question(['First', 'Second (推荐)'], true, text))
  expect(buildAutoAnswers({ questions, answers: { 'A?': 'model choice' } })).toEqual(Object.fromEntries(questions.map(q => [q.question, 'Second (推荐)'])))
})
test('invalid questions fail rather than inventing an answer', () => {
  for (const questions of [[], [question([])], [question(['', ' '])], [{ options: [{ label: 'A' }] }]]) {
    expect(buildAutoAnswers({ questions })).toBeNull()
  }
})
test('Auto execution refuses questions without manufacturing a user answer or a timer', async () => {
  const mode = { mode: 'bypassPermissions' }
  const input = { questions: [question(['Commit (推荐)', 'Merge'])], answers: { 'Choose?': 'Commit (推荐)' } }
  for (const rules of [{}, { alwaysAllowRules: { userSettings: ['AskUserQuestion'] } }, { alwaysAskRules: { userSettings: ['AskUserQuestion'] } }]) {
    const result = await hasPermissionsToUseTool(AskUserQuestionTool, input, context({ ...mode, ...rules }), {} as any, 'ask-auto')
    expect(result.behavior).toBe('deny')
    expect((result as any).message).toContain('Auto')
    expect((result as any).message).toContain('Plan')
    expect((result as any).updatedInput).toBeUndefined()
  }
  expect(getAutoQuestionDeadline(mode as any)).toBeUndefined()
  expect(getAutoQuestionDeadline(automaticPlan as any, 100)).toBe(300100)
})
for (const mode of [automaticPlan, { mode: 'default' }, { mode: 'acceptEdits' }, { mode: 'plan', prePlanMode: 'bypassPermissions' }]) {
  test(`Ask remains interactive in ${JSON.stringify(mode)}`, async () => {
    const input = { questions: [question(['First', 'Second (推荐)'])], answers: { 'Choose?': 'prefilled' } }
    const result = await hasPermissionsToUseTool(AskUserQuestionTool, input, context(mode), {} as any, 'ask-test')
    expect(result.behavior).toBe('ask')
    expect((result as any).updatedInput.answers).toBeUndefined()
  })
}
test('explicit deny still wins in Auto and automatic Plan', async () => {
  for (const mode of [{ mode: 'bypassPermissions' }, automaticPlan]) {
    const ctx = context({ ...mode, alwaysDenyRules: { userSettings: ['AskUserQuestion'] } })
    expect((await hasPermissionsToUseTool(AskUserQuestionTool, { questions: [question(['A', 'B'])] }, ctx, {} as any, 'denied')).behavior).toBe('deny')
  }
})

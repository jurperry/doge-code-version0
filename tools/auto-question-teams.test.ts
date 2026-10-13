import { expect, test } from 'bun:test'
import { createWorkerPermissionEntry } from '../src/utils/swarm/workerPermissionEntry.js'
import { AskUserQuestionTool } from '../src/tools/AskUserQuestionTool/AskUserQuestionTool.js'

test('mailbox worker Ask starts on display, times out once and ignores a late answer', () => {
  let now = 100; let timer: (() => void) | undefined; let due = 0; let active = false
  const sent: any[] = []; let queue: any[] = []
  const scheduler = { now: () => now, setTimeout(fn: () => void, ms: number) { timer = fn; due = now + ms; active = true; return 1 }, clearTimeout() { active = false } }
  const request: any = { request_id: 'worker-request', tool_use_id: 'worker-tool', agent_id: 'worker', tool_name: 'AskUserQuestion', description: 'Choice', auto_question: true,
    input: { questions: [{ question: 'Choice?', options: [{ label: 'First' }, { label: 'Second (推荐)' }] }] } }
  const entry = createWorkerPermissionEntry({ request, tool: AskUserQuestionTool, teamName: 'test-team',
    setQueue: update => { queue = update(queue) }, sendResponse: async (...args: any[]) => { sent.push(args); return true }, scheduler })
  queue.push(entry)
  expect(active).toBe(false)
  now += 200000; entry.onBecomeActive!()
  expect(entry.autoQuestionDeadlineMs).toBe(500100)
  now += 299999; if (active && now >= due) timer!()
  expect(sent).toHaveLength(0)
  now++; if (active && now >= due) timer!()
  expect(sent).toHaveLength(1)
  expect(sent[0][1].updatedInput.answers).toEqual({ 'Choice?': 'Second (推荐)' })
  expect(sent[0][1].updatedInput._autoQuestionAnswerSource).toBe('auto_recommended')
  expect(queue).toHaveLength(0)
  entry.onAllow({ answers: { 'Choice?': 'late' } }, [])
  entry.onAbort(); timer!()
  expect(sent).toHaveLength(1)
})

test('mailbox cancellation removes an active Ask and cannot become automatic permission', () => {
  const sent: any[] = []; let queue: any[] = []
  const entry = createWorkerPermissionEntry({ request: { request_id: 'cancel', tool_use_id: 'tool', agent_id: 'worker', tool_name: 'AskUserQuestion', description: '', auto_question: true, input: {} } as any,
    tool: AskUserQuestionTool, teamName: 'test-team', setQueue: update => { queue = update(queue) }, sendResponse: async (...args: any[]) => { sent.push(args); return true } })
  queue.push(entry); entry.onBecomeActive!(); entry.onAbort()
  expect(queue).toHaveLength(0)
  expect(sent[0][1].decision).toBe('rejected')
  entry.onAllow({}, []); expect(sent).toHaveLength(1)
})

test('independent worker requests with the same model tool id retain separate cards', () => {
  let queue: any[] = []
  const entries = ['one', 'two'].map(id => createWorkerPermissionEntry({ request: { request_id: id, tool_use_id: 'same-tool', agent_id: id, tool_name: 'AskUserQuestion', description: id, input: {} } as any,
    tool: AskUserQuestionTool, setQueue: update => { queue = update(queue) }, sendResponse: async () => true }))
  queue.push(...entries)
  entries[0].onAllow({}, [])
  expect(queue).toHaveLength(1)
  expect(queue[0].description).toBe('two')
  entries[1].onAbort()
})

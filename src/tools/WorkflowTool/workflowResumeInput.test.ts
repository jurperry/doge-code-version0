import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { WorkflowCheckpointStore } from './checkpoint.js'
import { isWorkflowResumeInput, workflowResumeRequiresNormalInput } from './workflowResumeInput.js'
import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'

const root = resolve(import.meta.dir, '../../../test')
mkdirSync(root, { recursive: true })
const temporary = mkdtempSync(join(root, 'workflow-edit-input-'))
afterAll(() => rmSync(temporary, { recursive: true, force: true }))

function checkpoint(taskId: string) {
  return { taskId, spec: { name: 'edit-resume', steps: [{ id: 'resume', title: 'resume', prompt: 'must not run' }] }, argsString: '', argValues: {}, nextStep: 0, outputs: {}, stepsRun: [{ stepId: 'resume', title: 'resume', status: 'stopped' }], state: 'stopped', savedAt: Date.now() } as any
}

test('resume classification matches ordinary string/single-text input and excludes attachments', () => {
  for (const input of ['继续', '继续执行', 'continue', 'resume workflow', [{ type: 'text', text: '继续工作流' }]]) expect(isWorkflowResumeInput(input)).toBe(true)
  for (const input of ['', '继续修改文件', [{ type: 'text', text: 'prefix' }, { type: 'text', text: 'continue' }], [{ type: 'text', text: 'continue' }, { type: 'image' }]]) expect(isWorkflowResumeInput(input)).toBe(false)
  expect(isWorkflowResumeInput('continue', true)).toBe(false)
})

test('only a real resumable checkpoint routes continuation away from replacement', () => {
  const sessionId = randomUUID()
  const transcript = join(temporary, sessionId + '.jsonl')
  const store = new WorkflowCheckpointStore(join(temporary, sessionId, 'workflows'))
  expect(workflowResumeRequiresNormalInput('continue', transcript, {})).toBe(false)
  store.save(checkpoint('run-edit'))
  const raw = store.latest()
  expect(workflowResumeRequiresNormalInput('continue', transcript, {})).toBe(true)
  expect(workflowResumeRequiresNormalInput('continue', transcript, { 'run-edit': { status: 'running' } })).toBe(false)
  expect(workflowResumeRequiresNormalInput('continue', transcript, {}, true)).toBe(false)
  expect(workflowResumeRequiresNormalInput('ordinary prompt', transcript, {})).toBe(false)
  expect(store.latest()).toEqual(raw)
})

test('transaction mode refuses a checkpoint discovered at the actual resume start without registering a task', async () => {
  const previousSession = getSessionId(), previousDirectory = getSessionProjectDir()
  const sessionId = randomUUID()
  switchSession(sessionId as any, temporary)
  const store = new WorkflowCheckpointStore(join(temporary, sessionId, 'workflows'))
  store.save(checkpoint('late-checkpoint'))
  try {
    const { resumeWorkflowTask } = await import('./engine.js')
    await expect(resumeWorkflowTask({
      getAppState: () => ({ tasks: {} }),
      setAppState: () => { throw new Error('Unexpected task execution before durable commit') },
      abortController: new AbortController(),
    } as any, false)).rejects.toThrow('normal user input channel')
    expect(store.latest()?.taskId).toBe('late-checkpoint')
  } finally { switchSession(previousSession as any, previousDirectory) }
})

test('transaction mode blocks the actual final-block slash dispatch before a local command writes', async () => {
  const { processUserInput } = await import('../../utils/processUserInput/processUserInput.js')
  const marker = join(temporary, 'unexpected-local-write')
  const command = { type: 'local', name: 'edit-side-effect', supportsNonInteractive: true, load: async () => ({ call: async () => { writeFileSync(marker, 'executed'); return { type: 'text', value: 'done' } } }) }
  await expect(processUserInput({
    input: [{ type: 'text', text: 'prefix' }, { type: 'text', text: '/edit-side-effect' }],
    mode: 'prompt', setToolJSX: () => {}, allowLocalCommands: false,
    context: {
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
      abortController: new AbortController(),
      options: { commands: [command], tools: [], isNonInteractiveSession: true },
    },
  } as any)).rejects.toThrow('normal user input channel')
  expect(existsSync(marker)).toBe(false)
})

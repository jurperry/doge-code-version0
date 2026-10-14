import { test, expect } from 'bun:test'
import { WorkflowCheckpointStore, isWorkflowContinue } from '../src/tools/WorkflowTool/checkpoint.js'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

test('only an explicit continue prompt is recognized', () => {
  for (const text of ['继续', '继续。', '继续执行', '继续工作流', 'continue', 'resume workflow']) expect(isWorkflowContinue(text)).toBe(true)
  for (const text of ['请解释继续是什么意思', '继续修改其他文件', '/continue', '']) expect(isWorkflowContinue(text)).toBe(false)
})

test('checkpoint survives reopening, preserves outputs, and clears only its own run', () => {
  const directory = resolve(import.meta.dir, '../../doge-code-app/test/checkpoint-unit')
  mkdirSync(directory, { recursive: true })
  try {
    const first = new WorkflowCheckpointStore(directory)
    const entry = { taskId: 'run-a', savedAt: 1, state: 'stopped' as const, spec: { name: 'one', steps: [{ id: 'a' }, { id: 'b' }] }, argsString: 'original', argValues: { task: 'original' }, nextStep: 1, outputs: { a: { status: 'completed', output: 'FULL\nOUTPUT' } }, stepsRun: [{ stepId: 'a', status: 'completed' }, { stepId: 'b', status: 'stopped' }] } as any
    first.save(entry)
    first.save({ ...entry, taskId: 'run-b', savedAt: 2 })
    const reopened = new WorkflowCheckpointStore(directory)
    expect(reopened.latest()?.taskId).toBe('run-b')
    expect(reopened.latest()?.outputs.a.output).toBe('FULL\nOUTPUT')
    reopened.remove('run-b')
    expect(reopened.latest()?.taskId).toBe('run-a')
    writeFileSync(join(directory, 'broken.json'), '{')
    expect(reopened.latest()?.taskId).toBe('run-a')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

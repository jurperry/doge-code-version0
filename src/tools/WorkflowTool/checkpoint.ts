/** Session-owned workflow progress. Completed outputs are reused on explicit resume. */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowSpec, InterpolationContext } from './spec.js'
import type { WorkflowStepRun } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

export interface WorkflowCheckpoint {
  taskId: string
  spec: WorkflowSpec
  argsString: string
  argValues: Record<string, string>
  nextStep: number
  outputs: InterpolationContext['steps']
  stepsRun: WorkflowStepRun[]
  state: 'running' | 'stopped' | 'failed'
  savedAt: number
}

export function isWorkflowContinue(text: string): boolean {
  return /^(?:继续(?:执行|工作流)?|continue|resume(?: workflow)?)[。.!！]?$/i.test(text.trim())
}

export class WorkflowCheckpointStore {
  constructor(private readonly directory: string) {}
  private file(taskId: string): string {
    if (!/^[\w-]+$/.test(taskId)) throw new Error('Invalid workflow checkpoint identity')
    return join(this.directory, taskId + '.json')
  }
  save(checkpoint: WorkflowCheckpoint): void {
    mkdirSync(this.directory, { recursive: true })
    const target = this.file(checkpoint.taskId)
    writeFileSync(target + '.tmp', JSON.stringify(checkpoint), { mode: 0o600 })
    renameSync(target + '.tmp', target)
  }
  remove(taskId: string): void { rmSync(this.file(taskId), { force: true }) }
  latest(): WorkflowCheckpoint | undefined {
    let names: string[]
    try { names = readdirSync(this.directory) } catch { return undefined }
    const entries: WorkflowCheckpoint[] = []
    for (const name of names.filter(name => /^[\w-]+\.json$/.test(name))) {
      try {
        const value = JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as WorkflowCheckpoint
        if (value.taskId + '.json' !== name || !value.spec?.steps?.length || !Array.isArray(value.stepsRun) ||
            !value.outputs || !value.argValues || typeof value.argsString !== 'string' ||
            !Number.isInteger(value.nextStep) || value.nextStep < 0 || value.nextStep >= value.spec.steps.length ||
            !['running', 'stopped', 'failed'].includes(value.state) || !Number.isFinite(value.savedAt)) continue
        entries.push(value)
      } catch { /* A truncated checkpoint must not break ordinary conversation. */ }
    }
    return entries.sort((a, b) => b.savedAt - a.savedAt)[0]
  }
}

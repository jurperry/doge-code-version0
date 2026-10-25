import { basename, dirname, join } from 'path'
import { isWorkflowContinue, WorkflowCheckpointStore } from './checkpoint.js'

type InputBlock = { type: string; text?: unknown }
type Input = string | readonly InputBlock[]

/** processUserInput dispatches local commands from the final text block. */
export function localInputText(input: Input): string | undefined {
  if (typeof input === 'string') return input
  const last = input[input.length - 1]
  return last?.type === 'text' && typeof last.text === 'string' ? last.text : undefined
}

/** Resume requires a bare text prompt, without preceding blocks or pasted images. */
export function isWorkflowResumeInput(input: Input, hasPastedImages = false): boolean {
  if (hasPastedImages || (typeof input !== 'string' && input.length !== 1)) return false
  const text = localInputText(input)
  return text !== undefined && isWorkflowContinue(text)
}

export function workflowCheckpointStoreForTranscript(transcript: string): WorkflowCheckpointStore {
  return new WorkflowCheckpointStore(join(dirname(transcript), basename(transcript, '.jsonl'), 'workflows'))
}

/** Read-only preflight shared by editing and ordinary workflow execution. */
export function workflowResumeRequiresNormalInput(input: Input, transcript: string, tasks: Record<string, { status?: unknown }>, hasPastedImages = false): boolean {
  if (!isWorkflowResumeInput(input, hasPastedImages)) return false
  const checkpoint = workflowCheckpointStoreForTranscript(transcript).latest()
  return !!checkpoint && tasks[checkpoint.taskId]?.status !== 'running'
}

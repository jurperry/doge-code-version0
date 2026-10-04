/**
 * Turns workflow markdown files into slash commands (CLI 2.1.282).
 *
 * Each workflow in ~/.doge/workflows/ or <proj>/.doge/workflows/ becomes a
 * `local` command with kind:'workflow' — deterministic direct-run: invoking
 * it registers the umbrella background task immediately (engine.ts) and
 * returns; the steps stream as task_* events and the final summary re-enters
 * the conversation as a <task-notification>. Works in both the TUI REPL and
 * headless -p (supportsNonInteractive), so the desktop shell command palette
 * can trigger it by sending "/<name> <args>".
 *
 * This module is imported by commands.ts at command-load time and must stay
 * LIGHT: it may not statically import engine.ts (engine pulls runAgent →
 * query → commands.js — a module-init cycle that deadlocks the compiled
 * binary; the engine is loaded lazily inside call()).
 */

import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { loadMarkdownFilesForSubdir } from '../../utils/markdownConfigLoader.js'
import type { Command, LocalJSXCommandContext } from '../../types/command.js'
import { findWorkflowProfile } from './profiles.js'
import { parseWorkflowArgs, parseWorkflowSpec, type WorkflowSpec } from './spec.js'

/** Load and parse every workflow file visible from cwd (memoized on disk loader). */
export async function loadWorkflowSpecs(cwd: string): Promise<WorkflowSpec[]> {
  const files = await loadMarkdownFilesForSubdir('workflows', cwd)
  const specs: WorkflowSpec[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const { spec, errors } = parseWorkflowSpec({
      frontmatter: file.frontmatter as Record<string, unknown>,
      content: file.content,
      filePath: file.filePath,
      source: file.source,
    })
    if (!spec) {
      logForDebugging(
        `[workflows] skipping invalid file ${file.filePath}: ${errors.join('; ')}`,
        { level: 'warn' },
      )
      continue
    }
    // First definition wins (managed > user > project — user-scope beats a
    // same-named project file, matching the loader's ordering).
    if (seen.has(spec.name)) {
      logForDebugging(
        `[workflows] duplicate workflow name "${spec.name}" from ${file.filePath} (already loaded)`,
      )
      continue
    }
    seen.add(spec.name)
    specs.push(spec)
  }
  return specs
}

/** Drop the memoized markdown cache so file edits show up immediately. */
export function invalidateWorkflowCache(): void {
  loadMarkdownFilesForSubdir.cache?.clear?.()
}

/** Fail-fast validation shared by direct invocation and the /workflows lister. */
export function validateWorkflowRun(opts: {
  spec: WorkflowSpec
  argValues: Record<string, string>
  context: LocalJSXCommandContext
}): string[] {
  const errors: string[] = []
  for (const step of opts.spec.steps) {
    if (step.profile !== undefined && !findWorkflowProfile(step.profile)) {
      errors.push(
        `步骤 ${step.id} 的 profile "${step.profile}" 不存在（/provider 查看已配置 provider）`,
      )
    }
    if (step.agent !== undefined) {
      const agents = opts.context.options.agentDefinitions.activeAgents ?? []
      if (!agents.some(a => a.agentType === step.agent)) {
        errors.push(
          `步骤 ${step.id} 的 agent "${step.agent}" 不存在（/agents 管理）`,
        )
      }
    }
  }
  return errors
}

/** Commands surfaced to the CLI for every loadable workflow file. */
export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  const specs = await loadWorkflowSpecs(cwd)
  return specs.map(spec => workflowToCommand(spec))
}

function workflowToCommand(spec: WorkflowSpec): Command {
  return {
    name: spec.name,
    description: spec.description,
    argumentHint: spec.argumentHint,
    type: 'local',
    kind: 'workflow',
    userInvocable: true,
    supportsNonInteractive: true,
    load: async () => ({
      call: async (args, context) => {
        // Engine loaded lazily — see the module header for the cycle story.
        const { startWorkflowTask } = await import('./engine.js')
        invalidateWorkflowCache()
        const specs = await loadWorkflowSpecs(getCwd())
        const fresh = specs.find(s => s.name === spec.name) ?? spec
        const { values, errors: argErrors } = parseWorkflowArgs(fresh, args)
        if (argErrors.length > 0) {
          return { type: 'text', value: `参数错误：\n- ${argErrors.join('\n- ')}` }
        }
        const runErrors = validateWorkflowRun({
          spec: fresh,
          argValues: values,
          context,
        })
        if (runErrors.length > 0) {
          return { type: 'text', value: `无法启动：\n- ${runErrors.join('\n- ')}` }
        }
        startWorkflowTask({
          spec: fresh,
          argsString: args,
          argValues: values,
          context,
        })
        return {
          type: 'text',
          value: `▶ 工作流 "${fresh.name}" 已启动（${fresh.steps.length} 步）。步骤进度见任务面板，完成后自动汇报结果。`,
        }
      },
    }),
  }
}

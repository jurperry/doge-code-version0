/**
 * /workflows — list declarative workflow files and manage templates (CLI 2.1.282).
 *
 * MVP surface (both TUI and headless -p; the desktop shell settings page is
 * the rich CRUD UI on the same files):
 *   /workflows            list workflows (name, description, step chain, file)
 *   /workflows new <name> write a starter template to ~/.doge/workflows/<name>.md
 *
 * Running a workflow = type /<name> [args] directly (each workflow is a
 * slash command). Deleting = remove the file (App settings page or manually).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from '../../types/command.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  invalidateWorkflowCache,
  loadWorkflowSpecs,
} from '../../tools/WorkflowTool/createWorkflowCommand.js'
import { formatWorkflowSummary } from '../../tools/WorkflowTool/spec.js'
import { getCwd } from '../../utils/cwd.js'

const WORKFLOW_TEMPLATE = `---
name: {NAME}
description: 一句话描述这个工作流做什么
argument-hint: "[参数]"
inputs:
  - key: target
    type: string
    default: .
    required: false
steps:
  - id: analyze
    title: 分析
    model: haiku
    prompt: |
      分析 {{args.target}} 的现状，列出要点。
  - id: act
    title: 执行
    model: sonnet
    prompt: |
      根据以下分析开始执行：
      {{steps.analyze.output}}
  - id: review
    title: 复查
    # profile: <providerName>   # 跨 API 步骤：换到该 provider 的子进程执行
    prompt: |
      复查上述改动并给出结论。
---

（正文可写工作流的说明文档；不影响执行）
`

function scopeLabel(specScope: string): string {
  if (specScope === 'user') return '~'
  if (specScope === 'project') return 'proj'
  return specScope
}

export default {
  name: 'workflows',
  description: '列出/管理工作流（声明式多步骤任务编排）',
  type: 'local',
  userInvocable: true,
  supportsNonInteractive: true,
  load: async () => ({
    call: async args => {
      const trimmed = args.trim()
      if (trimmed.startsWith('new')) {
        const name = trimmed.slice(3).trim()
        if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
          return {
            type: 'text' as const,
            value: '用法：/workflows new <名称>（字母数字开头，可含 - _）',
          }
        }
        const dir = join(getClaudeConfigHomeDir(), 'workflows')
        const file = join(dir, `${name}.md`)
        try {
          mkdirSync(dir, { recursive: true })
          writeFileSync(file, WORKFLOW_TEMPLATE.replace(/\{NAME\}/g, name), 'utf8')
        } catch (err) {
          return {
            type: 'text' as const,
            value: `创建失败：${err instanceof Error ? err.message : String(err)}`,
          }
        }
        invalidateWorkflowCache()
        return {
          type: 'text' as const,
          value: `已创建工作流模板：${file}\n编辑步骤后运行 /${name} 即可执行。`,
        }
      }

      invalidateWorkflowCache()
      const specs = await loadWorkflowSpecs(getCwd())
      if (specs.length === 0) {
        return {
          type: 'text' as const,
          value: [
            '还没有工作流。',
            '创建：/workflows new <名称>（模板落到 ~/.doge/workflows/）',
            '项目级：把 .md 放进 <项目>/.doge/workflows/',
            '桌面壳：设置 → 工作流配置（可视化增删改查）',
          ].join('\n'),
        }
      }
      const lines = specs.map(spec => {
        const scope = scopeLabel(spec.scope)
        return `${formatWorkflowSummary(spec)}\n    [${scope}] ${spec.sourcePath}`
      })
      return {
        type: 'text' as const,
        value: [
          `共 ${specs.length} 个工作流（/${specs[0]!.name} 直接运行；steps 里 model=同 provider 换模型，profile=跨 API 子进程）：`,
          ...lines,
        ].join('\n'),
      }
    },
  }),
} as unknown as Command

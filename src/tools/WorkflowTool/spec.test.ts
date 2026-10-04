import { describe, expect, test } from 'bun:test'
import {
  interpolate,
  parseWorkflowArgs,
  parseWorkflowSpec,
  WORKFLOW_MAX_STEPS,
} from './spec.js'

const baseFile = {
  content: '正文说明',
  filePath: '/home/u/.doge/workflows/release-check.md',
  source: 'userSettings',
}

const validFrontmatter = {
  name: 'release-check',
  description: '发布前检查',
  'argument-hint': '[scope]',
  inputs: [
    { key: 'scope', type: 'string', default: 'src' },
    { key: 'mode', type: 'select', options: ['fast', 'full'], required: true },
  ],
  steps: [
    {
      id: 'lint',
      title: '静态扫描',
      model: 'haiku',
      prompt: '检查 {{args.scope}}',
    },
    {
      id: 'fix',
      'continue-on-error': true,
      profile: 'kimi',
      prompt: '修复：\n{{steps.lint.output}}',
    },
  ],
}

describe('parseWorkflowSpec', () => {
  test('parses a full valid spec', () => {
    const { spec, errors } = parseWorkflowSpec({
      ...baseFile,
      frontmatter: validFrontmatter,
    })
    expect(errors).toEqual([])
    expect(spec).not.toBeNull()
    expect(spec!.name).toBe('release-check')
    expect(spec!.argumentHint).toBe('[scope]')
    expect(spec!.inputs).toHaveLength(2)
    expect(spec!.steps).toHaveLength(2)
    expect(spec!.steps[0]!.model).toBe('haiku')
    expect(spec!.steps[1]!.profile).toBe('kimi')
    expect(spec!.steps[1]!.continueOnError).toBe(true)
    expect(spec!.steps[1]!.title).toBe('fix')
    expect(spec!.scope).toBe('user')
    expect(spec!.body).toBe('正文说明')
  })

  test('name falls back to file basename and description to placeholder', () => {
    const { spec, errors } = parseWorkflowSpec({
      ...baseFile,
      filePath: '/x/.doge/workflows/my-flow.md',
      frontmatter: { steps: [{ id: 'a', prompt: 'p' }] },
    })
    expect(errors).toEqual([])
    expect(spec!.name).toBe('my-flow')
    expect(spec!.description).toBe('(未描述的工作流)')
  })

  test('rejects missing/empty steps and duplicate ids', () => {
    const noSteps = parseWorkflowSpec({
      ...baseFile,
      frontmatter: { name: 'x', steps: [] },
    })
    expect(noSteps.spec).toBeNull()
    expect(noSteps.errors.some(e => e.includes('steps'))).toBe(true)

    const dup = parseWorkflowSpec({
      ...baseFile,
      frontmatter: {
        name: 'x',
        steps: [
          { id: 'a', prompt: 'p' },
          { id: 'a', prompt: 'q' },
        ],
      },
    })
    expect(dup.spec).toBeNull()
    expect(dup.errors.some(e => e.includes('重复'))).toBe(true)
  })

  test('rejects invalid name and select input without options', () => {
    const bad = parseWorkflowSpec({
      ...baseFile,
      frontmatter: {
        name: 'bad name!',
        inputs: [{ key: 'm', type: 'select' }],
        steps: [{ id: 'a', prompt: 'p' }],
      },
    })
    expect(bad.spec).toBeNull()
    expect(bad.errors.some(e => e.includes('无效名称'))).toBe(true)
    expect(bad.errors.some(e => e.includes('select'))).toBe(true)
  })

  test('enforces the step cap', () => {
    const steps = Array.from({ length: WORKFLOW_MAX_STEPS + 1 }, (_, i) => ({
      id: `s${i}`,
      prompt: 'p',
    }))
    const { spec, errors } = parseWorkflowSpec({
      ...baseFile,
      frontmatter: { name: 'big', steps },
    })
    expect(spec).toBeNull()
    expect(errors.some(e => e.includes('上限'))).toBe(true)
  })
})

describe('parseWorkflowArgs', () => {
  const spec = parseWorkflowSpec({
    ...baseFile,
    frontmatter: validFrontmatter,
  }).spec!

  test('positional + key=value + defaults', () => {
    const { values, errors } = parseWorkflowArgs(spec, 'lib mode=fast')
    expect(errors).toEqual([])
    expect(values.scope).toBe('lib')
    expect(values.mode).toBe('fast')
  })

  test('defaults apply and required can be satisfied positionally', () => {
    const { values, errors } = parseWorkflowArgs(spec, 'src full')
    expect(errors).toEqual([])
    expect(values.scope).toBe('src')
    expect(values.mode).toBe('full')
  })

  test('missing required input errors', () => {
    const { errors } = parseWorkflowArgs(spec, '')
    expect(errors.some(e => e.includes('mode'))).toBe(true)
  })

  test('select value outside options errors', () => {
    const { errors } = parseWorkflowArgs(spec, 'src mode=teleport')
    expect(errors.some(e => e.includes('teleport'))).toBe(true)
  })

  test('unknown key and extra positional tokens error', () => {
    const { errors } = parseWorkflowArgs(spec, 'src fast wat=1 extra')
    expect(errors.some(e => e.includes('wat'))).toBe(true)
    expect(errors.some(e => e.includes('多余'))).toBe(true)
  })

  const textSpec = parseWorkflowSpec({ ...baseFile, frontmatter: {
    name: 'text-flow', inputs: [{ key: 'request', type: 'string', required: true }],
    steps: [{ id: 'read', prompt: '{{args.request}}' }],
  } }).spec!

  test('single string input preserves a long multiline request, quotes and literal assignments', () => {
    const request = ('请处理以下内容：\n路径 "E:\\my project\\需求.txt"\n示例 foo=bar，保留格式。\n').repeat(1000).trim()
    expect(parseWorkflowArgs(textSpec, request)).toEqual({ values: { request }, errors: [] })
  })

  test('single named string and quoted path preserve spaces and newlines', () => {
    expect(parseWorkflowArgs(textSpec, 'request="第一段\n第二 段"')).toEqual({ values: { request: '第一段\n第二 段' }, errors: [] })
    expect(parseWorkflowArgs(textSpec, '"E:\\my project\\需求.txt"')).toEqual({ values: { request: 'E:\\my project\\需求.txt' }, errors: [] })
  })

  test('multiple inputs support quoted named values and keep select validation', () => {
    expect(parseWorkflowArgs(spec, 'scope="E:\\my project\\src" mode=full')).toEqual({
      values: { scope: 'E:\\my project\\src', mode: 'full' }, errors: [],
    })
    expect(parseWorkflowArgs(spec, '"第一段\n第二段" fast').values.scope).toBe('第一段\n第二段')
    expect(parseWorkflowArgs(spec, 'scope="unterminated mode=full').errors.length).toBeGreaterThan(0)
  })
})

describe('interpolate', () => {
  const ctx = {
    args: { scope: 'src' },
    steps: {
      lint: { status: 'completed', output: '发现 3 个问题' },
    },
  }

  test('substitutes args and step outputs', () => {
    expect(interpolate('检查 {{args.scope}}；{{steps.lint.output}}', ctx)).toBe(
      '检查 src；发现 3 个问题',
    )
  })

  test('status field and default-to-output', () => {
    expect(interpolate('{{steps.lint.status}}/{{steps.lint}}', ctx)).toBe(
      'completed/发现 3 个问题',
    )
  })

  test('leaves unknown references verbatim', () => {
    expect(interpolate('{{args.nope}} {{steps.ghost.output}}', ctx)).toBe(
      '{{args.nope}} {{steps.ghost.output}}',
    )
  })
})

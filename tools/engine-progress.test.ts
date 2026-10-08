import { describe, expect, test } from 'bun:test'
import { stepProgressSummary } from '../src/tools/WorkflowTool/engine.js'

describe('stepProgressSummary（跨 API 步骤实时进度摘要，0.2.116）', () => {
  test('正文首行优先', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '分析完成，结论如下：\n第二行' }] },
    })
    expect(stepProgressSummary(line)).toBe('分析完成，结论如下：')
  })

  test('无正文时给 thinking 首段（截断到 80）', () => {
    const long = '先读取需求文件再梳理目录结构。'.repeat(10)
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: long }] },
    })
    const out = stepProgressSummary(line)
    expect(out.startsWith('思考：')).toBe(true)
    expect(out.length).toBeLessThanOrEqual('思考：'.length + 81)
  })

  test('工具调用取最后一个 tool_use 的名称与关键入参', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '先想想' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'E:/x/a.py' } },
        ],
      },
    })
    expect(stepProgressSummary(line)).toBe('调用 Read：E:/x/a.py')
  })

  test('command 入参与空入参形态', () => {
    const cmd = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'PowerShell', input: { command: 'Get-ChildItem E:/x' } }] },
    })
    expect(stepProgressSummary(cmd)).toBe('调用 PowerShell：Get-ChildItem E:/x')
    const bare = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'TaskList', input: {} }] },
    })
    expect(stepProgressSummary(bare)).toBe('调用 TaskList')
  })

  test('空消息与非 JSON 行返回空串（不上报）', () => {
    expect(stepProgressSummary('not json')).toBe('')
    expect(
      stepProgressSummary(JSON.stringify({ type: 'assistant', message: { content: [] } })),
    ).toBe('')
  })
})

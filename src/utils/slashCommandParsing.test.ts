import { expect, test } from 'bun:test'
import { parseSlashCommand } from './slashCommandParsing.js'

test('slash command supports newline or tab after the command without flattening its arguments', () => {
  expect(parseSlashCommand('/my-workflows\n第一段\n  第二段')).toEqual({ commandName: 'my-workflows', args: '第一段\n  第二段', isMcp: false })
  expect(parseSlashCommand('/my-workflows\t请求 内容')).toEqual({ commandName: 'my-workflows', args: '请求 内容', isMcp: false })
})

test('MCP marker, ordinary slash commands and noncommands remain compatible', () => {
  expect(parseSlashCommand('/mcp:tool (MCP) first\nsecond')).toEqual({ commandName: 'mcp:tool (MCP)', args: 'first\nsecond', isMcp: true })
  expect(parseSlashCommand('/model')).toEqual({ commandName: 'model', args: '', isMcp: false })
  expect(parseSlashCommand('hello')).toBeNull()
  expect(parseSlashCommand('/')).toBeNull()
})

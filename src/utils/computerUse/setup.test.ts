import { expect, test } from 'bun:test'

import { windowsComputerUsePrompt } from '../../skills/bundled/computerUse.js'
import { setupComputerUseMCP } from './setup.js'

test('the Windows skill follows the active Computer Use tools', () => {
  expect(windowsComputerUsePrompt([])).toBeUndefined()
  expect(windowsComputerUsePrompt([{ name: 'mcp__playwright__browser_snapshot' }])).toBeUndefined()
  const tools = setupComputerUseMCP().allowedTools.map(name => ({ name }))
  const prompt = windowsComputerUsePrompt(tools)
  if (process.platform === 'win32') {
    expect(prompt).toContain('# Windows Computer Use')
    expect(windowsComputerUsePrompt([{ name: 'screenshot', mcpInfo: { serverName: 'computer-use', toolName: 'screenshot' } }])).toBe(prompt)
  } else {
    expect(prompt).toBeUndefined()
  }
})

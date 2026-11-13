import { expect, test } from 'bun:test'

import { COMPUTER_USE_MCP_PROMPT_HINT } from './setup.js'

test('Computer Use prompt explains stop, recovery and partial-batch semantics', () => {
  expect(COMPUTER_USE_MCP_PROMPT_HINT).toContain('stop the current action sequence')
  expect(COMPUTER_USE_MCP_PROMPT_HINT).toContain('never click using stale coordinates')
  expect(COMPUTER_USE_MCP_PROMPT_HINT).toContain('completed, failed or aborted, remaining, and recovery')
  expect(COMPUTER_USE_MCP_PROMPT_HINT).toContain('perform only missing actions instead of replaying the batch')
  expect(COMPUTER_USE_MCP_PROMPT_HINT).toContain('switch_display("auto") selects full-screen capture and global input')
  expect(COMPUTER_USE_MCP_PROMPT_HINT).toContain('Changing the target invalidates previous image coordinates')
})

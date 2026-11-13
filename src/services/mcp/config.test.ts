import { test, expect, beforeEach } from 'bun:test'

import {
  isMcpServerDisabled,
  setMcpServerEnabled,
} from './config.js'
import { saveCurrentProjectConfig } from '../../utils/config.js'
import {
  setupComputerUseMCP,
  COMPUTER_USE_MCP_PROMPT_HINT,
} from '../../utils/computerUse/setup.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from '../../utils/computerUse/common.js'

// NODE_ENV=test（bun:test 默认设置）下 getCurrentProjectConfig /
// saveCurrentProjectConfig 走内存对象 TEST_PROJECT_CONFIG_FOR_TESTING，
// 不触磁盘。beforeEach 重置两个开关字段避免用例间状态泄漏。
beforeEach(() => {
  saveCurrentProjectConfig(current => ({
    ...current,
    disabledMcpServers: [],
    enabledMcpServers: [],
  }))
})

test('computer-use MCP server is enabled by default', () => {
  // 空 project config 下不得落入 upstream 的 enabledMcpServers 显式启用
  // 门槛 —— 那会让工具默认不进模型列表，等于“默认关闭”。
  expect(isMcpServerDisabled(COMPUTER_USE_MCP_SERVER_NAME)).toBe(false)
})

test('computer-use can still be opted out via setMcpServerEnabled(false)', () => {
  setMcpServerEnabled(COMPUTER_USE_MCP_SERVER_NAME, false)
  expect(isMcpServerDisabled(COMPUTER_USE_MCP_SERVER_NAME)).toBe(true)

  // Re-enable clears the opt-out.
  setMcpServerEnabled(COMPUTER_USE_MCP_SERVER_NAME, true)
  expect(isMcpServerDisabled(COMPUTER_USE_MCP_SERVER_NAME)).toBe(false)
})

test('regular user servers keep the default-enabled / opt-out semantics', () => {
  expect(isMcpServerDisabled('my-server')).toBe(false)

  setMcpServerEnabled('my-server', false)
  expect(isMcpServerDisabled('my-server')).toBe(true)

  setMcpServerEnabled('my-server', true)
  expect(isMcpServerDisabled('my-server')).toBe(false)
})

test('legacy enabledMcpServers entries from the opt-in era stay enabled', () => {
  // 曾经手动启用过的项目配置里残留 enabledMcpServers 条目，不应翻转语义。
  saveCurrentProjectConfig(current => ({
    ...current,
    enabledMcpServers: [COMPUTER_USE_MCP_SERVER_NAME],
  }))
  expect(isMcpServerDisabled(COMPUTER_USE_MCP_SERVER_NAME)).toBe(false)
})

test('setupComputerUseMCP registers the in-process server and full toolset', () => {
  const { mcpConfig, allowedTools } = setupComputerUseMCP()

  const entry = mcpConfig[COMPUTER_USE_MCP_SERVER_NAME]
  expect(entry).toBeDefined()
  expect(entry?.type).toBe('stdio')
  expect((entry as { scope?: string }).scope).toBe('dynamic')

  expect(allowedTools.length).toBeGreaterThan(10)
  for (const name of allowedTools) {
    expect(name.startsWith(`mcp__${COMPUTER_USE_MCP_SERVER_NAME}__`)).toBe(true)
  }
  for (const core of ['request_access', 'screenshot', 'zoom', 'left_click', 'type', 'computer_batch']) {
    expect(allowedTools).toContain(`mcp__${COMPUTER_USE_MCP_SERVER_NAME}__${core}`)
  }
})

test('local CU prompt hint covers the screenshot-act-verify loop', () => {
  // 第三方/转接端点没有 Anthropic 服务端的 CU availability hint，
  // 本地提示必须自带最小工作流引导。
  expect(COMPUTER_USE_MCP_PROMPT_HINT).toContain('request_access')
  expect(COMPUTER_USE_MCP_PROMPT_HINT).toContain('screenshot')
  expect(COMPUTER_USE_MCP_PROMPT_HINT.toLowerCase()).toContain('verify')
  expect(COMPUTER_USE_MCP_PROMPT_HINT).toContain('mcp__computer-use__')
})

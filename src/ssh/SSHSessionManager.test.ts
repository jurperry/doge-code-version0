import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/controlTypes.js'
import { SSHSessionManager } from './SSHSessionManager.js'

const remoteScript = String.raw`
let buffer = ''
let mode = 'default'
const order = []
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.type === 'control_request' && message.request.subtype === 'initialize') {
      const legacyMode = process.env.TEST_SSH_LEGACY_MODE
      if (legacyMode) mode = legacyMode
      const response = legacyMode ? {} : { permissionMode: mode }
      send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    } else if (message.type === 'control_request' && message.request.subtype === 'set_model') {
      order.push('model:' + message.request.model)
      send({ type: 'result', subtype: 'success', uuid: 'model-set', session_id: 'remote-session', duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 0, result: 'model-set', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })
    } else if (message.type === 'control_request' && message.request.subtype === 'set_permission_mode') {
      if (message.request.mode === 'dontAsk') {
        send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'mode disabled remotely' } })
      } else {
        mode = message.request.mode
        send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { mode } } })
        send({ type: 'system', subtype: 'status', permissionMode: mode })
      }
    } else if (message.type === 'user') {
      const text = message.message.content
      order.push('user')
      send({ type: 'system', subtype: 'init', permissionMode: mode, session_id: 'remote-session', model: 'mock', tools: [], uuid: 'init', timestamp: new Date().toISOString() })
      if (text === 'which-mode') {
        send({ type: 'result', subtype: 'success', result: mode })
      } else if (text === 'which-order') {
        send({ type: 'result', subtype: 'success', result: order.join(',') })
      } else if (text === 'needs-permission') {
        send({ type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-1', input: { command: 'pwd' } } })
      } else if (text === 'cancel-permission') {
        send({ type: 'control_request', request_id: 'permission-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-2', input: { command: 'pwd' } } })
        setImmediate(() => send({ type: 'control_cancel_request', request_id: 'permission-2' }))
      } else if (text === 'slow') {
      } else {
        const resultText = text === 'early-turn' ? 'early-turn-result' : 'remote ok'
        send({ type: 'assistant', uuid: 'assistant-1', session_id: 'remote-session', parent_tool_use_id: null, message: { id: 'message-1', type: 'message', role: 'assistant', model: 'mock', content: [{ type: 'text', text: resultText }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        send({ type: 'result', subtype: 'success', uuid: 'result-1', session_id: 'remote-session', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: resultText, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
      }
    } else if (message.type === 'update_environment_variables') {
      if (message.variables.DOGE_SSH_PROXY_TOKEN) {
        send({ type: 'result', subtype: 'success', uuid: 'env-ready', session_id: 'remote-session', duration_ms: 0, duration_api_ms: 0, is_error: false, num_turns: 0, result: 'token-present', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })
      } else if (!message.variables.ANTHROPIC_MODEL && message.variables.CLAUDE_CODE_EFFORT_LEVEL) {
        order.push('effort:' + message.variables.CLAUDE_CODE_EFFORT_LEVEL)
      } else {
        order.push('env:' + (message.variables.ANTHROPIC_MODEL ?? ''))
      }
    } else if (message.type === 'control_response' && message.response.request_id === 'permission-1') {
      send({ type: 'result', subtype: 'success', uuid: 'result-2', session_id: 'remote-session', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: message.response.response.behavior, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
    } else if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
      send({ type: 'result', subtype: 'error_interrupted', uuid: 'result-3', session_id: 'remote-session', duration_ms: 1, duration_api_ms: 1, is_error: true, num_turns: 1, errors: ['interrupted'], total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } })
    } else if (message.type === 'control_request' && message.request.subtype === 'end_session') {
      process.exit(0)
    }
  }
})
`

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(10)
  }
}

let proc: ChildProcessWithoutNullStreams | undefined
let manager: SSHSessionManager | undefined

beforeEach(() => {
  proc = spawn(process.execPath, ['-e', remoteScript], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
})

afterEach(() => {
  manager?.disconnect()
  if (proc?.exitCode === null && proc.signalCode === null) proc.kill()
  manager = undefined
  proc = undefined
})

test('SSH manager drives initialize, turns, permissions, interrupt and clean disconnect', async () => {
  const messages: SDKMessage[] = []
  const errors: Error[] = []
  let connected = false
  let disconnected = false
  let permission: { request: SDKControlPermissionRequest; requestId: string } | undefined
  let cancelled: { requestId: string; toolUseId?: string } | undefined
  manager = new SSHSessionManager(proc!, {
    onMessage: message => messages.push(message),
    onPermissionRequest: (request, requestId) => { permission = { request, requestId } },
    onPermissionCancelled: (requestId, toolUseId) => { cancelled = { requestId, toolUseId } },
    onConnected: () => { connected = true },
    onDisconnected: () => { disconnected = true },
    onError: error => errors.push(error),
  })
  manager.connect()
  await until(() => connected, 'initialize')
  expect(manager.isConnected()).toBe(true)

  expect(await manager.sendMessage('hello', { uuid: 'user-1' })).toBe(true)
  await until(() => messages.some(message => message.type === 'result'), 'normal turn')
  expect(messages.some(message => message.type === 'assistant')).toBe(true)

  expect(await manager.sendMessage('needs-permission')).toBe(true)
  await until(() => permission !== undefined, 'permission request')
  expect(permission!.request.tool_name).toBe('Bash')
  manager.respondToPermissionRequest(permission!.requestId, { behavior: 'allow', updatedInput: { command: 'pwd' } })
  await until(() => messages.some(message => message.type === 'result' && message.result === 'allow'), 'permission response')

  expect(await manager.sendMessage('cancel-permission')).toBe(true)
  await until(() => cancelled !== undefined, 'permission cancellation')
  expect(cancelled).toEqual({ requestId: 'permission-2', toolUseId: 'tool-2' })

  expect(await manager.sendMessage('slow')).toBe(true)
  manager.sendInterrupt()
  await until(() => messages.some(message => message.type === 'result' && message.subtype === 'error_interrupted'), 'interrupt')
  expect(errors).toEqual([])

  manager.disconnect()
  await until(() => proc!.exitCode !== null, 'remote exit')
  expect(disconnected).toBe(false)
})

test('SSH manager accepts a user turn before the initialize response arrives', async () => {
  const messages: SDKMessage[] = []
  let connected = false
  manager = new SSHSessionManager(proc!, {
    onMessage: message => messages.push(message),
    onPermissionRequest: () => {},
    onConnected: () => { connected = true },
  }, { proxyToken: 'unit-bootstrap-token' })
  manager.connect()
  expect(manager.isConnected()).toBe(false)
  expect(await manager.sendMessage('early-turn')).toBe(true)
  await until(() => connected, 'late initialize response')
  await until(() => messages.some(message => message.type === 'result' && message.result === 'early-turn-result'), 'early turn result')
  const results = messages.filter(message => message.type === 'result').map(message => message.result)
  expect(results.indexOf('token-present')).toBeLessThan(results.indexOf('early-turn-result'))
})

test('mode changes keep their order with user input and a rejected switch restores the last remote mode', async () => {
  const modes: string[] = []
  const errors: string[] = []
  const results: string[] = []
  manager = new SSHSessionManager(proc!, {
    onMessage: message => {
      if (message.type === 'result' && message.subtype === 'success') results.push(message.result)
    },
    onPermissionRequest: () => {},
    onPermissionMode: mode => modes.push(mode),
    onPermissionModeError: (mode, error) => errors.push(`${mode}: ${error}`),
  })
  manager.connect()
  manager.setPermissionMode('bypassPermissions')
  await manager.sendMessage('which-mode')
  manager.setPermissionMode('plan')
  manager.setPermissionMode('dontAsk')
  await manager.sendMessage('which-mode')
  await until(() => results.length === 2, 'turns after mode changes')
  expect(results).toEqual(['bypassPermissions', 'plan'])
  expect(modes).toEqual(['plan'])
  expect(errors).toEqual(['dontAsk: mode disabled remotely'])
  expect(manager.isConnected()).toBe(true)
})

test('remote startup mode is reported even without a first user turn', async () => {
  const modes: string[] = []
  manager = new SSHSessionManager(proc!, {
    onMessage: () => {},
    onPermissionRequest: () => {},
    onPermissionMode: mode => modes.push(mode),
  })
  manager.connect()
  await until(() => manager!.isConnected(), 'initialize')
  expect(modes).toEqual(['default'])
})

test('a rejected mode change does not hide the startup mode from an older remote', async () => {
  proc!.kill()
  proc = spawn(process.execPath, ['-e', remoteScript], {
    env: { ...process.env, TEST_SSH_LEGACY_MODE: 'acceptEdits' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const modes: string[] = []
  manager = new SSHSessionManager(proc, {
    onMessage: () => {},
    onPermissionRequest: () => {},
    onPermissionMode: mode => modes.push(mode),
  })
  manager.connect()
  manager.setPermissionMode('dontAsk')
  await manager.sendMessage('which-mode')
  await until(() => modes.length === 2, 'legacy startup mode')
  expect(modes).toEqual(['default', 'acceptEdits'])
})

test('initialize errors become a visible disconnect instead of a false connection', async () => {
  proc!.kill()
  proc = spawn(process.execPath, ['-e', `let b='';process.stdin.on('data',c=>{b+=c;const line=b.split('\\n')[0];if(!line)return;const m=JSON.parse(line);process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:m.request_id,error:'initialize rejected'}})+'\\n')})`], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
  const errors: Error[] = []
  let disconnected = false
  manager = new SSHSessionManager(proc!, {
    onMessage: () => {},
    onPermissionRequest: () => {},
    onError: error => errors.push(error),
    onDisconnected: () => { disconnected = true },
  }, { initializeTimeoutMs: 1000 })
  manager.connect()
  await until(() => disconnected, 'initialize error disconnect')
  expect(errors[0]?.message).toBe('initialize rejected')
  expect(manager.isConnected()).toBe(false)
})

test('initialize timeout disconnects and reclaims the remote process', async () => {
  proc!.kill()
  proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
  const errors: Error[] = []
  let disconnected = false
  manager = new SSHSessionManager(proc!, {
    onMessage: () => {},
    onPermissionRequest: () => {},
    onError: error => errors.push(error),
    onDisconnected: () => { disconnected = true },
  }, { initializeTimeoutMs: 25 })
  manager.connect()
  await until(() => disconnected, 'initialize timeout')
  expect(errors[0]?.message).toContain('timed out')
  await until(() => proc!.exitCode !== null || proc!.signalCode !== null, 'timeout process cleanup')
})

test('interrupt before initialize discards queued turns permanently', async () => {
  const messages: SDKMessage[] = []
  let connected = false
  manager = new SSHSessionManager(proc!, {
    onMessage: message => messages.push(message),
    onPermissionRequest: () => {},
    onConnected: () => { connected = true },
  }, { proxyToken: 'unit-bootstrap-token' })
  manager.connect()
  expect(await manager.sendMessage('early-turn')).toBe(true)
  manager.sendInterrupt()
  await until(() => connected, 'initialize after early interrupt')
  await Bun.sleep(80)
  expect(messages.some(message => message.type === 'result' && message.result === 'early-turn-result')).toBe(false)
})

test('a process that exited before connect fails immediately without a timeout', async () => {
  proc!.kill()
  await until(() => proc!.exitCode !== null || proc!.signalCode !== null, 'pre-connect process exit')
  const errors: Error[] = []
  let disconnected = false
  manager = new SSHSessionManager(proc!, {
    onMessage: () => {},
    onPermissionRequest: () => {},
    onError: error => errors.push(error),
    onDisconnected: () => { disconnected = true },
  }, { initializeTimeoutMs: 10_000 })
  const started = Date.now()
  manager.connect()
  await until(() => disconnected, 'pre-exit disconnect')
  expect(Date.now() - started).toBeLessThan(1000)
  expect(errors[0]?.message).toContain('exited before initialization')
})

test('tunnel credential write failure prevents a false connected state', async () => {
  const errors: Error[] = []
  let connected = false
  let disconnected = false
  manager = new SSHSessionManager(proc!, {
    onMessage: () => {},
    onPermissionRequest: () => {},
    onConnected: () => { connected = true },
    onError: error => errors.push(error),
    onDisconnected: () => { disconnected = true },
  }, { proxyToken: 'unit-bootstrap-token' })
  manager.connect()
  proc!.stdin.destroy()
  await until(() => disconnected, 'credential write failure')
  expect(connected).toBe(false)
  expect(errors[0]?.message).toContain('credentials')
})

test('interrupt and permission write failures surface errors instead of false cancellation', async () => {
  const errors: Error[] = []
  let disconnected = false
  let permissionId = ''
  manager = new SSHSessionManager(proc!, {
    onMessage: () => {},
    onPermissionRequest: (_request, requestId) => { permissionId = requestId },
    onError: error => errors.push(error),
    onDisconnected: () => { disconnected = true },
  })
  manager.connect()
  expect(await manager.sendMessage('needs-permission')).toBe(true)
  await until(() => permissionId !== '', 'permission before control write failures')
  proc!.stdin.destroy()
  manager.respondToPermissionRequest(permissionId, { behavior: 'allow', updatedInput: {} })
  await until(() => disconnected, 'permission write failure')
  expect(errors[0]?.message).toContain('permission')
})

test('shared cleanup runs only once across failure and exit paths', async () => {
  let cleanupCalls = 0
  let connected = false
  let disconnected = false
  manager = new SSHSessionManager(proc!, {
    onMessage: () => {},
    onPermissionRequest: () => {},
    onConnected: () => { connected = true },
    onError: () => {},
    onDisconnected: () => { disconnected = true },
  }, { cleanup: () => { cleanupCalls++ } })
  manager.connect()
  await until(() => connected, 'connected before cleanup check')
  proc!.stdin.destroy()
  await until(() => disconnected, 'failure cleanup')
  proc!.kill()
  await Bun.sleep(80)
  manager.disconnect()
  expect(cleanupCalls).toBe(1)
})

test('model and effort changes reach the remote in order before the next turn', async () => {
  const messages: SDKMessage[] = []
  manager = new SSHSessionManager(proc!, {
    onMessage: message => messages.push(message),
    onPermissionRequest: () => {},
  }, { proxyToken: 'tunnel-token' })
  manager.connect()
  await until(() => messages.some(message => message.type === 'result' && message.result === 'token-present'), 'connected')
  manager.setModel('deepseek-flash', { ANTHROPIC_MODEL: 'deepseek-flash', CLAUDE_CODE_EFFORT_LEVEL: '' })
  manager.setEffort('max')
  expect(await manager.sendMessage('which-order')).toBe(true)
  await until(() => messages.some(message => message.type === 'result' && message.result?.includes('user')), 'ordered delivery')
  expect(messages.find(message => message.type === 'result' && message.result?.includes('user'))?.result)
    .toBe('env:deepseek-flash,model:deepseek-flash,effort:max,user')
})

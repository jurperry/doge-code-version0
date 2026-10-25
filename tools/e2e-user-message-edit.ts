// Real stream-json / localhost API regression. All state lives under test/.
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'

const root = resolve(import.meta.dir, '..')
mkdirSync(join(root, 'test'), { recursive: true })
const temporary = mkdtempSync(join(root, 'test/user-message-edit-'))
const config = join(temporary, 'config')
const project = join(temporary, 'project')
mkdirSync(config); mkdirSync(project)
writeFileSync(join(project, 'settings.json'), JSON.stringify({ claudeMdExcludes: ['**'], env: {} }))
const requests: any[] = []
const frames: any[] = []
let stderr = ''
const sse = (value: any) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 120, async fetch(request) {
  const url = new URL(request.url)
  if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 })
  if (request.method !== 'POST') return new Response('ok')
  const body = await request.json() as any
  requests.push(body)
  const first = [1, 4, 6].includes(requests.length)
  const hold = first || requests.length === 3
  const type = first ? 'thinking' : 'text'
  return new Response(new ReadableStream({ start(controller) {
    const emit = (value: any) => controller.enqueue(new TextEncoder().encode(sse(value)))
    emit({ type: 'message_start', message: { id: `message-${requests.length}`, type: 'message', role: 'assistant', model: 'claude-edit-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    emit({ type: 'content_block_start', index: 0, content_block: first ? { type, thinking: '' } : { type, text: '' } })
    emit({ type: 'content_block_delta', index: 0, delta: first ? { type: 'thinking_delta', thinking: 'still thinking' } : { type: 'text_delta', text: 'EDIT_ACCEPTED' } })
    if (!hold) {
      emit({ type: 'content_block_stop', index: 0 })
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
      emit({ type: 'message_stop' }); controller.close()
    }
  } }), { headers: { 'content-type': 'text/event-stream' } })
} })

const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: config, TEMP: temporary, TMP: temporary,
  DOGE_API_KEY: 'sk-local-edit-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_MODEL: 'claude-edit-test',
  CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'anthropic', CLAUDE_CODE_EAGER_FLUSH: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DOGE_HOST_MANAGED_MODEL_CONTEXT: '1' }
for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key]
let pending = ''
function startCLI(sessionId?: string) {
  const args = [join(root, 'src/bootstrap-entry.ts'), '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--replay-user-messages', '--setting-sources', '', '--settings', join(project, 'settings.json'), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(sessionId ? ['--resume', sessionId] : [])]
  const process = spawn(Bun.which('bun')!, args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] })
  process.stdout.on('data', chunk => {
    pending += chunk.toString()
    for (;;) {
      const index = pending.indexOf('\n'); if (index < 0) break
      const line = pending.slice(0, index); pending = pending.slice(index + 1)
      try { frames.push(JSON.parse(line)) } catch {}
    }
  })
  process.stderr.on('data', chunk => { stderr += chunk.toString() })
  return process
}
let child = startCLI()
const send = (value: any) => child.stdin.write(JSON.stringify(value) + '\n')
async function until(predicate: () => any, label: string) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const result = predicate(); if (result) return result
    if (child.exitCode !== null) throw new Error(`CLI exited ${child.exitCode}: ${stderr}`)
    await Bun.sleep(25)
  }
  throw new Error(`Timeout ${label}; frames=${JSON.stringify(frames.slice(-5))}; stderr=${stderr.slice(-4000)}`)
}
const response = (id: string) => frames.find(frame => frame.type === 'control_response' && frame.response?.request_id === id)?.response
function check(value: any, label: string) { if (!value) throw new Error(label); console.log('PASS ' + label) }
function transcriptFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? transcriptFiles(join(path, entry.name)) : entry.name.endsWith('.jsonl') ? [join(path, entry.name)] : [])
}

try {
  send({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } })
  await until(() => response('initialize'), 'initialize')
  const original = randomUUID(), replacement = randomUUID()
  send({ type: 'user', uuid: original, message: { role: 'user', content: 'ORIGINAL_EDIT_TARGET' } })
  await until(() => frames.some(frame => frame.type === 'stream_event' && frame.event?.delta?.type === 'thinking_delta'), 'thinking')
  send({ type: 'control_request', request_id: 'busy', request: { subtype: 'replace_user_message', user_message_id: original, replacement: { uuid: randomUUID(), content: 'BUSY_MUST_NOT_EXECUTE' } } })
  check((await until(() => response('busy'), 'busy rejection')).subtype === 'error' && requests.length === 1, 'active unstopped query returns busy without blocking control input')
  send({ type: 'control_request', request_id: 'interrupt', request: { subtype: 'interrupt' } })
  send({ type: 'control_request', request_id: 'state-before-workflow', request: { subtype: 'get_user_message_edit_state' } })
  check((await until(() => response('state-before-workflow'), 'stopped edit state')).response?.can_replace === true, 'stopped prompt starts with replacement authority')
  send({ type: 'control_request', request_id: 'model-before-array-command', request: { subtype: 'get_settings' } })
  const modelBefore = (await until(() => response('model-before-array-command'), 'model before array command')).response?.applied?.model
  send({ type: 'control_request', request_id: 'replace-array-command', request: { subtype: 'replace_user_message', user_message_id: original, replacement: { uuid: randomUUID(), content: [{ type: 'text', text: 'prefix' }, { type: 'text', text: '/model claude-edit-unexpected' }] } } })
  check((await until(() => response('replace-array-command'), 'array command rejection')).subtype === 'error', 'array with a final slash command is refused')
  send({ type: 'control_request', request_id: 'model-after-array-command', request: { subtype: 'get_settings' } })
  check((await until(() => response('model-after-array-command'), 'model after array command')).response?.applied?.model === modelBefore, 'rejected array slash input leaves actual model selection unchanged')
  const sessionFile = transcriptFiles(config).find(file => basename(file, '.jsonl') === frames.find(frame => frame.type === 'system' && frame.subtype === 'init')?.session_id)!
  const checkpointDirectory = join(dirname(sessionFile), basename(sessionFile, '.jsonl'), 'workflows')
  mkdirSync(checkpointDirectory, { recursive: true })
  const checkpointFile = join(checkpointDirectory, 'edit-resume-checkpoint.json')
  const checkpoint = { taskId: 'edit-resume-checkpoint', spec: { name: 'edit-resume', description: 'replacement guard fixture', steps: [{ id: 'resume', title: 'resume step', prompt: 'WORKFLOW_SIDE_EFFECT_MARKER', agent: 'general-purpose' }] }, argsString: '', argValues: {}, nextStep: 0, outputs: {}, stepsRun: [{ stepId: 'resume', title: 'resume step', status: 'stopped' }], state: 'stopped', savedAt: Date.now() }
  writeFileSync(checkpointFile, JSON.stringify(checkpoint))
  send({ type: 'control_request', request_id: 'replace-workflow', request: { subtype: 'replace_user_message', user_message_id: original, replacement: { uuid: randomUUID(), content: 'continue' } } })
  check((await until(() => response('replace-workflow'), 'workflow replacement rejection')).subtype === 'error' && existsSync(checkpointFile) && requests.length === 1, 'workflow replacement rejects before consuming checkpoint or starting any API work')
  send({ type: 'control_request', request_id: 'state-workflow', request: { subtype: 'get_user_message_edit_state', text: '继续工作流' } })
  check((await until(() => response('state-workflow'), 'workflow input state')).response?.can_replace === false, 'workflow continuation with a real checkpoint chooses normal append')
  check(readFileSync(checkpointFile, 'utf8') === JSON.stringify(checkpoint), 'edit preflight leaves checkpoint bytes unchanged')
  rmSync(checkpointFile)
  send({ type: 'control_request', request_id: 'state-continue-no-checkpoint', request: { subtype: 'get_user_message_edit_state', text: 'continue' } })
  check((await until(() => response('state-continue-no-checkpoint'), 'ordinary continue state')).response?.can_replace === true, 'ordinary continue without a checkpoint remains replaceable')
  writeFileSync(checkpointFile, JSON.stringify(checkpoint))
  send({ type: 'control_request', request_id: 'state-continue-with-image', request: { subtype: 'get_user_message_edit_state', text: 'continue', has_images: true } })
  check((await until(() => response('state-continue-with-image'), 'image continue state')).response?.can_replace === true, 'continue with an image remains a normal replaceable prompt even with a checkpoint')
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const imagePath = join(project, 'image.png')
  writeFileSync(imagePath, Buffer.from(image, 'base64'))
  send({ type: 'control_request', request_id: 'replace', request: { subtype: 'replace_user_message', user_message_id: original, replacement: { uuid: replacement, content: [{ type: 'text', text: 'continue' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }], image_paths: [imagePath] } } })
  const accepted = await until(() => response('replace'), 'replacement')
  check(accepted.subtype === 'success' && accepted.response?.user_message_id === replacement, 'thinking-only stop commits replacement with stable UUID: ' + JSON.stringify(accepted))
  await until(() => requests.length === 2, 'second API request')
  const context = JSON.stringify(requests[1].messages)
  check(!context.includes('ORIGINAL_EDIT_TARGET') && context.includes('"text":"continue"'), 'replacement request excludes canceled prompt')
  check(existsSync(checkpointFile) && readFileSync(checkpointFile, 'utf8') === JSON.stringify(checkpoint), 'actual image continuation replacement does not resume or consume a workflow checkpoint')
  rmSync(checkpointFile)
  check(requests[1].messages.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.type === 'image' && block.source.data === image)) && context.includes('image.png'), 'replacement uses normal image intake and path metadata')
  await until(() => frames.some(frame => frame.type === 'result' && frame.result?.includes('EDIT_ACCEPTED')), 'replacement completion')
  send({ type: 'control_request', request_id: 'state', request: { subtype: 'get_user_message_edit_state' } })
  const state = await until(() => response('state'), 'settled state')
  check(state.response?.user_message_id === replacement && state.response?.can_replace === false, 'normally completed replacement cannot be replaced')
  send({ type: 'control_request', request_id: 'stale', request: { subtype: 'replace_user_message', user_message_id: original, replacement: { uuid: randomUUID(), content: 'SHOULD_NOT_EXECUTE' } } })
  check((await until(() => response('stale'), 'stale rejection')).subtype === 'error', 'stale target returns error')
  check(requests.length === 2, 'rejected replacement never appends an API request')
  const records = transcriptFiles(config).flatMap(file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
  check(!records.some(record => record.uuid === original) && records.filter(record => record.uuid === replacement).length === 1, 'durable transcript replaces original exactly once')
  const textId = randomUUID()
  send({ type: 'user', uuid: textId, message: { role: 'user', content: 'VISIBLE_TEXT_STOP' } })
  await until(() => requests.length === 3 && frames.filter(frame => frame.type === 'stream_event' && frame.event?.delta?.type === 'text_delta').length >= 2, 'third request text')
  send({ type: 'control_request', request_id: 'interrupt-text', request: { subtype: 'interrupt' } })
  send({ type: 'control_request', request_id: 'state-text', request: { subtype: 'get_user_message_edit_state' } })
  const textState = await until(() => response('state-text'), 'text state')
  check(textState.response?.user_message_id === textId && textState.response?.can_replace === false, 'first visible text permanently blocks replacement after stop')
  send({ type: 'control_request', request_id: 'replace-text', request: { subtype: 'replace_user_message', user_message_id: textId, replacement: { uuid: randomUUID(), content: 'ILLEGAL_REPLACEMENT' } } })
  check((await until(() => response('replace-text'), 'text replacement rejection')).subtype === 'error' && requests.length === 3, 'ineligible target errors without executing')
  const reconnectTarget = randomUUID()
  send({ type: 'user', uuid: reconnectTarget, message: { role: 'user', content: 'RECONNECT_TARGET' } })
  await until(() => requests.length === 4 && frames.filter(frame => frame.type === 'stream_event' && frame.event?.delta?.type === 'thinking_delta').length >= 2, 'reconnect thinking')
  send({ type: 'control_request', request_id: 'interrupt-reconnect', request: { subtype: 'interrupt' } })
  send({ type: 'control_request', request_id: 'state-reconnect-before', request: { subtype: 'get_user_message_edit_state' } })
  const beforeReconnect = await until(() => response('state-reconnect-before'), 'state after interrupt')
  check(beforeReconnect.response?.can_replace === true && beforeReconnect.response?.user_message_id === reconnectTarget, 'state query waits for interrupted finally and durable qualification')
  const sessionId = frames.find(frame => frame.type === 'system' && frame.subtype === 'init')?.session_id
  check(!!sessionId, 'session identity is available for reconnect')
  child.stdin.end()
  await until(() => child.exitCode !== null, 'first process exit')
  pending = ''
  child = startCLI(sessionId)
  send({ type: 'control_request', request_id: 'initialize-reconnected', request: { subtype: 'initialize' } })
  await until(() => response('initialize-reconnected'), 'reconnected initialization')
  send({ type: 'control_request', request_id: 'state-reconnected', request: { subtype: 'get_user_message_edit_state' } })
  const reconnected = await until(() => response('state-reconnected'), 'restored edit state')
  check(reconnected.response?.user_message_id === reconnectTarget && reconnected.response?.can_replace === true, 'reconnect restores proven replacement authority: ' + JSON.stringify(reconnected))
  const resumedId = randomUUID()
  send({ type: 'control_request', request_id: 'replace-reconnected', request: { subtype: 'replace_user_message', user_message_id: reconnectTarget, replacement: { uuid: resumedId, content: 'RECONNECTED_EDIT' } } })
  check((await until(() => response('replace-reconnected'), 'restored replacement')).subtype === 'success', 'reconnected prompt is replaceable')
  await until(() => requests.length === 5, 'resumed API request')
  const resumedContext = JSON.stringify(requests[4].messages)
  check(resumedContext.includes('"text":"continue"') && resumedContext.includes('VISIBLE_TEXT_STOP') && !resumedContext.includes('RECONNECT_TARGET') && resumedContext.includes('RECONNECTED_EDIT'), 'resumed replacement preserves all earlier history')
  await until(() => frames.filter(frame => frame.type === 'result' && frame.result?.includes('EDIT_ACCEPTED')).length >= 2, 'reconnected replacement completion')
  const raceOriginal = randomUUID(), raceReplacement = randomUUID()
  send({ type: 'user', uuid: raceOriginal, message: { role: 'user', content: 'RACE_ORIGINAL' } })
  await until(() => requests.length === 6 && frames.filter(frame => frame.type === 'stream_event' && frame.event?.delta?.type === 'thinking_delta').length >= 3, 'race thinking')
  send({ type: 'control_request', request_id: 'interrupt-race', request: { subtype: 'interrupt' } })
  // No Stop ACK or state query is awaited: replace must join the old finally.
  send({ type: 'control_request', request_id: 'replace-race', request: { subtype: 'replace_user_message', user_message_id: raceOriginal, replacement: { uuid: raceReplacement, content: 'RACE_EDIT' } } })
  const raced = await until(() => response('replace-race'), 'raced replacement')
  check(raced.subtype === 'success' && raced.response?.user_message_id === raceReplacement, 'replacement sent before Stop ACK waits for the old run to settle')
  await until(() => requests.length === 7, 'race replacement request')
  const raceContext = JSON.stringify(requests[6].messages)
  check(!raceContext.includes('RACE_ORIGINAL') && raceContext.includes('RACE_EDIT') && raceContext.includes('RECONNECTED_EDIT'), 'raced replacement excludes only its canceled prompt and preserves earlier turns')
  await until(() => frames.filter(frame => frame.type === 'result' && frame.result?.includes('EDIT_ACCEPTED')).length >= 3, 'raced replacement completion')
  const normalCheckpointFile = join(checkpointDirectory, 'normal-resume-checkpoint.json')
  writeFileSync(normalCheckpointFile, JSON.stringify({ ...checkpoint, taskId: 'normal-resume-checkpoint', savedAt: Date.now() }))
  const normalContinue = randomUUID()
  send({ type: 'user', uuid: normalContinue, message: { role: 'user', content: 'continue' } })
  await until(() => requests.some(body => JSON.stringify(body.messages).includes('WORKFLOW_SIDE_EFFECT_MARKER')), 'ordinary workflow continuation execution')
  check(!existsSync(normalCheckpointFile), 'ordinary input still resumes its workflow and consumes the old checkpoint')
  const ordinaryRecords = transcriptFiles(config).flatMap(file => readFileSync(file, 'utf8').trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line)))
  check(ordinaryRecords.some(record => record.uuid === normalContinue) && ordinaryRecords.some(record => record.uuid === raceReplacement), 'ordinary workflow continuation appends the real user while preserving earlier turns')
} catch (error) {
  console.error(error)
  console.error('Recent frames:', JSON.stringify(frames.slice(-6)))
  process.exitCode = 1
} finally {
  child.kill()
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), Bun.sleep(2000)])
  await server.stop(true)
  for (let attempt = 0; ; attempt++) {
    try { rmSync(temporary, { recursive: true, force: true }); break } catch (error) {
      if (attempt === 20) throw error
      await Bun.sleep(100)
    }
  }
}

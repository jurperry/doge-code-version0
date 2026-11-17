/** Local HTTP integration of the real API pipeline. No external API or credentials. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ensureBootstrapMacro } from '../src/bootstrapMacro.js'

ensureBootstrapMacro()
const root = resolve(import.meta.dir, '..')
await mkdir(join(root, 'test'), { recursive: true })
const sandbox = await mkdtemp(join(root, 'test', 'model-routing-http-'))
process.env.CLAUDE_CONFIG_DIR = sandbox
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.NODE_ENV = 'production'
process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = sandbox
process.env.CLAUDE_CODE_MAX_RETRIES = '0'
for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete process.env[key]

const requests: Array<{ path: string; model: string; auth: string | null; key: string | null }> = []
let startupRootRequests = 0
const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  const body = await request.json() as any
  const tool = path.startsWith('/startup/') && body.model === 'b-main' && startupRootRequests++ === 0
    ? { type: 'tool_use', id: 'startup_agent', name: 'Agent', input: { prompt: 'Say ok', subagent_type: 'Explore', description: 'Check startup tier' } } : undefined
  requests.push({ path, model: body.model, auth: request.headers.get('authorization'), key: request.headers.get('x-api-key') })
  let payload: string
  if (path.endsWith('/chat/completions')) {
    payload = `data: ${JSON.stringify({ id: 'chat_test', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: 'chat_test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`
  } else if (path.endsWith('/responses')) {
    payload = event('response.created', { type: 'response.created', response: { id: 'resp_test', model: body.model } })
      + event('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ok' })
      + event('response.completed', { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } })
  } else {
    payload = event('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
      + event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { ...tool, input: {} } : { type: 'text', text: '' } })
      + event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: 'ok' } })
      + event('content_block_stop', { type: 'content_block_stop', index: 0 })
      + event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
      + event('message_stop', { type: 'message_stop' })
  }
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
} })

function check(condition: unknown, label: string) {
  if (!condition) throw Error(label)
  console.log(`PASS ${label}`)
}

try {
  const { enableConfigs } = await import('../src/utils/config.js')
  enableConfigs()
  const ctx = await import('../src/utils/model/runtimeModelContext.js')
  const { queryModelWithoutStreaming } = await import('../src/services/api/claude.js')
  const { createUserMessage } = await import('../src/utils/messages.js')
  const { asSystemPrompt } = await import('../src/utils/systemPromptType.js')
  const { getAgentModel } = await import('../src/utils/model/agent.js')
  const { profileStepModel } = await import('../src/tools/WorkflowTool/headlessStep.js')
  const { modelProfileEnvPatch } = await import('../src/utils/customApiStorage.js')
  const { buildInheritedEnvVars } = await import('../src/utils/swarm/spawnUtils.js')
  const ask = (model: string) => queryModelWithoutStreaming({
    messages: [createUserMessage({ content: 'Say ok' })], systemPrompt: asSystemPrompt(['Return ok']),
    thinkingConfig: { type: 'disabled' }, tools: [], signal: AbortSignal.timeout(20_000),
    options: { model, querySource: 'sdk', isNonInteractiveSession: true, agents: [],
      hasAppendSystemPrompt: false, mcpTools: [], enablePromptCaching: false,
      getToolPermissionContext: async () => ({ mode: 'bypassPermissions', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} } as any) },
  })

  for (const provider of ['anthropic', 'openai', 'responses'] as const) {
    const profile = { id: provider, providerName: provider, model: `${provider}-main`, provider,
      baseURL: `http://127.0.0.1:${server.port}/${provider}${provider === 'responses' ? '/v1/' : ''}`,  apiKey: `local-${provider}`, defaultHaikuModel: `${provider}-fast` }
    for (const [key, value] of Object.entries(modelProfileEnvPatch(profile))) {
      if (value) process.env[key] = value; else delete process.env[key]
    }
    const snapshot = ctx.captureModelEnvironment()
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1/wrong-leader'
    process.env.DOGE_API_KEY = 'wrong-leader-key'
    process.env.CLAUDE_CODE_COMPATIBLE_API_PROVIDER = 'responses'
    await ctx.runWithModelEnvironment(snapshot, async () => {
      const model = getAgentModel('haiku', profile.model)
      check(model === `${provider}-fast`, `${provider}: agent tier`)
      await ask(model)
      const sent = requests.at(-1)!
      const suffix = provider === 'anthropic' ? '/v1/messages' : provider === 'openai' ? '/chat/completions' : '/responses'
      check(sent.path === `/${provider}${provider === 'responses' ? '/v1' : ''}${suffix}` && sent.model === model, `${provider}: actual endpoint and model stay pinned (${sent.path}, ${sent.model})`)
      check(provider === 'anthropic' ? sent.key === `local-${provider}` : sent.auth === `Bearer local-${provider}`, `${provider}: actual auth stays pinned`)
      check(profileStepModel(profile, 'inherit') === profile.model, `${provider}: workflow inherit`)
      const inherited = buildInheritedEnvVars()
      check(inherited.includes(`DOGE_ACTIVE_MODEL_PROFILE=${provider}`) && !inherited.includes(`local-${provider}`), `${provider}: teammate identity without command-line secret`)
    })
    check(ctx.getModelEnvironment().DOGE_API_KEY === 'wrong-leader-key', `${provider}: leader restored`)
  }
  const startupDir = join(sandbox, 'startup-config')
  await mkdir(startupDir)
  const startupProfiles = ['a', 'b'].map(name => ({ id: name, providerName: name, model: `${name}-main`, provider: 'anthropic',
    baseURL: `http://127.0.0.1:${server.port}/startup`, apiKey: `fake-${name}`, defaultHaikuModel: `${name}-fast` }))
  const endpoint = { model: 'a-main', activeProfileId: 'a', modelProfiles: startupProfiles }
  await writeFile(join(startupDir, '.credentials.json'), JSON.stringify({ customApiEndpoint: endpoint }))
  await writeFile(join(startupDir, '.claude.json'), JSON.stringify({ customApiEndpoint: endpoint, hasCompletedOnboarding: true }))
  const env = { ...process.env, CLAUDE_CONFIG_DIR: startupDir, NODE_ENV: 'production',
    ANTHROPIC_MODEL: 'b-main', ANTHROPIC_BASE_URL: '', DOGE_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
    DOGE_ACTIVE_MODEL_PROFILE: '', CLAUDE_CODE_COMPATIBLE_API_PROVIDER: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '', ANTHROPIC_DEFAULT_SONNET_MODEL: '', ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
    CLAUDE_CODE_SUBAGENT_MODEL: '', DOGE_HEADLESS_BUILTIN_MCP: '0', DOGE_PLAYWRIGHT_MCP: '0',
  }
  const child = Bun.spawn([process.execPath, 'run', join(root, 'src/bootstrap-entry.ts'), '-p', 'Use Explore once then say ok',
    '--dangerously-skip-permissions', '--tools', 'Agent', '--no-session-persistence', '--output-format', 'json'],
    { cwd: sandbox, env, stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => child.kill(), 30_000)
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timeout)
  check(exit === 0, `source CLI startup completes (${exit}, ${stderr.slice(-160)})`)
  check(requests.some(request => request.path.startsWith('/startup/') && request.model === 'b-fast' && request.key === 'fake-b'), 'source CLI Explore uses explicit B tier and B credentials')
  check(!requests.some(request => request.path.startsWith('/startup/') && request.model === 'a-fast'), 'source CLI never uses disk A tier')
  check(stdout.includes('ok'), 'source CLI returns final result after the real agent tool')
  const persisted = JSON.parse(await readFile(join(startupDir, 'model-catalog.json'), 'utf8')).modelCatalog
  const fast = persisted.connections.find(connection => connection.id === 'b').models.find(model => model.upstreamModel === 'b-fast')
  const beforeSelection = requests.length
  const selection = Bun.spawn([process.execPath, 'run', join(root, 'src/bootstrap-entry.ts'), '-p', 'Say ok',
    '--model', `profile:b:${fast.id}`, '--tools', '', '--no-session-persistence', '--output-format', 'json'],
    { cwd: sandbox, env: { ...env, ANTHROPIC_MODEL: 'a-main', DOGE_API_KEY: 'fake-a' }, stdout: 'pipe', stderr: 'pipe' })
  const selectionTimeout = setTimeout(() => selection.kill(), 30_000)
  const [selectionOut, selectionError, selectionExit] = await Promise.all([
    new Response(selection.stdout).text(), new Response(selection.stderr).text(), selection.exited,
  ])
  clearTimeout(selectionTimeout)
  check(selectionExit === 0 && selectionOut.includes('ok'), `explicit model reference starts successfully (${selectionExit}, ${selectionError.slice(-120)})`)
  check(requests.slice(beforeSelection).some(request => request.model === 'b-fast' && request.key === 'fake-b'),
    'explicit model reference routes a non-default model with its connection credentials')
  // The production transport launches a native CLI executable. A tiny native
  // test launcher forwards to this checkout's source so this exercises the
  // actual workflow engine and subprocess transport without an installed CLI.
  const launcherSource = join(sandbox, 'source-launcher.ts')
  const launcher = join(sandbox, process.platform === 'win32' ? 'source-launcher.exe' : 'source-launcher')
  await writeFile(launcherSource, `const start = process.argv.indexOf('-p');
    const child = Bun.spawn([${JSON.stringify(process.execPath)}, 'run', ${JSON.stringify(join(root, 'src/bootstrap-entry.ts'))}, ...process.argv.slice(start >= 0 ? start : 2)], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env });
    process.exit(await child.exited);`)
  await Bun.build({ entrypoints: [launcherSource], compile: { outfile: launcher }, target: 'bun' })
  await mkdir(join(startupDir, 'workflows'))
  await writeFile(join(startupDir, 'workflows', 'routing-check.md'), `---
name: routing-check
description: Local routing regression
steps:
  - id: local
    model: haiku
    prompt: Say ok
  - id: cross
    profile: a
    model: inherit
    prompt: Say ok
---
Routing regression.
`)
  const beforeWorkflow = requests.length
  const workflow = Bun.spawn([process.execPath, 'run', join(root, 'src/bootstrap-entry.ts'), '-p', '/routing-check',
    '--dangerously-skip-permissions', '--tools', 'Agent', '--no-session-persistence', '--output-format', 'json'],
    { cwd: sandbox, env: { ...env, DOGE_WORKFLOW_EXECUTABLE: launcher, CLAUDE_CODE_SUBAGENT_MODEL: 'wrong-model' }, stdout: 'pipe', stderr: 'pipe' })
  const workflowTimeout = setTimeout(() => workflow.kill(), 30_000)
  const [workflowOut, workflowError, workflowExit] = await Promise.all([new Response(workflow.stdout).text(), new Response(workflow.stderr).text(), workflow.exited])
  clearTimeout(workflowTimeout)
  const workflowRequests = requests.slice(beforeWorkflow)
  check(workflowExit === 0, `workflow CLI completes (${workflowExit}, ${workflowError.slice(-100)})`)
  check(workflowRequests.some(r => r.model === 'b-fast' && r.key === 'fake-b'), 'in-process workflow step ignores global subagent override')
  check(workflowRequests.some(r => r.model === 'a-main' && r.key === 'fake-a'), 'cross-profile workflow inherit uses target A main and credentials')
  check(workflowRequests.some(r => r.model === 'b-main' && r.key === 'fake-b'), 'workflow parent retains provider B')
  check(!workflowRequests.some(r => r.model === 'wrong-model'), 'global subagent override never leaks into workflow steps')
  check(workflowOut.includes('ok'), 'workflow returns its final result')
  console.log('ALL MODEL ROUTING HTTP CHECKS PASSED')
} finally {
  server.stop(true)
  const { dispose } = await import('../src/utils/settings/changeDetector.js')
  await dispose()
  const { runCleanupFunctions } = await import('../src/utils/cleanupRegistry.js')
  await runCleanupFunctions()
  // Bun's Windows rm does not consistently honor maxRetries for a just-exited
  // child's former working directory. Retry explicitly after handles settle.
  for (let attempt = 0; ; attempt++) {
    try { await rm(sandbox, { recursive: true, force: true }); break }
    catch (error) {
      if (attempt >= 19 || !['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await Bun.sleep(100)
    }
  }
}

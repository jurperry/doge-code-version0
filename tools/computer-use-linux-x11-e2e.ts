/**
 * Real X11 acceptance. Run in an isolated X11 session with an EWMH window
 * manager, xclip and xdotool. The fixture windows and JPEG checks run in Bun.
 * Example: xvfb-run -a sh -c 'openbox & bun tools/computer-use-linux-x11-e2e.ts'
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AppGrant, ComputerUseSessionContext, CuGrantFlags, ScreenshotDims } from '@ant/computer-use-mcp/types'
import { decode } from 'jpeg-js'
import { withX11 } from '../src/utils/computerUse/platforms/x11/connection.js'
import { setFixtureShape } from './fixtures/computer-use-x11-window.js'

assert.equal(process.platform, 'linux')
const repo = resolve(import.meta.dir, '..')
const testDir = join(repo, 'test')
await mkdir(testDir, { recursive: true })
const sandbox = await mkdtemp(join(testDir, 'linux-x11-e2e-'))
process.env.CLAUDE_CONFIG_DIR = join(sandbox, 'config')
process.env.CLAUDE_CODE_TMPDIR = sandbox
process.env.TMPDIR = sandbox

const fixture = join(import.meta.dir, 'fixtures', 'computer-use-x11-window.ts')
const children: ReturnType<typeof Bun.spawn>[] = []
type State = { id: number; clicks: number; text: string }

async function eventually<T>(read: () => Promise<T>, message: string): Promise<T> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      return await read()
    } catch {
      await Bun.sleep(40)
    }
  }
  throw new Error(message)
}

async function launch(name: string, color: string, geometry: string, topmost = false) {
  const statePath = join(sandbox, name + '.json')
  const child = Bun.spawn([process.execPath, fixture, 'window', name, color, geometry, statePath, topmost ? '1' : '0'], {
    stdout: 'ignore', stderr: 'inherit',
  })
  children.push(child)
  const state = async (): Promise<State> => JSON.parse(await readFile(statePath, 'utf8'))
  const { id } = await eventually(state, name + ' did not map')
  return { id, state, name }
}

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, {
    stdin: 'ignore',
    stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(15_000),
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  assert.equal(code, 0, stderr || args.join(' '))
  return stdout
}

function pixel(base64: string, x: number, y: number): number[] {
  const image = decode(Buffer.from(base64, 'base64'))
  assert.ok(x < image.width && y < image.height)
  return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)]
}

async function checkNormalCliRegistration(enabled: boolean) {
  let names: string[] | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({})
      const body = await request.json() as { tools?: { name: string }[] }
      names = body.tools?.map(tool => tool.name) ?? []
      const events = [
        { type: 'message_start', message: { id: 'msg_x11', role: 'assistant', model: 'claude-sonnet-4-5', type: 'message', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ready' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(item => 'event: ' + item.type + '\ndata: ' + JSON.stringify(item) + '\n\n').join(''),
        { headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  try {
    const cli = Bun.spawn([process.execPath, join(repo, 'src/bootstrap-entry.ts'), '-p', '--bare', '--verbose',
      '--output-format', 'stream-json', 'Return ready.'], {
      cwd: sandbox,
      env: {
        ...process.env, ANTHROPIC_BASE_URL: server.url.toString(), ANTHROPIC_AUTH_TOKEN: '',
        DOGE_API_KEY: 'local-x11-test', CLAUDE_CODE_COMPATIBLE_API_PROVIDER: 'anthropic',
        DOGE_HEADLESS_BUILTIN_MCP: '1', DOGE_PLAYWRIGHT_MCP: '0',
        DOGE_COMPUTER_USE_MCP: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        WAYLAND_DISPLAY: enabled ? '' : 'wayland-fixture',
      },
      stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(30_000),
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited,
    ])
    assert.equal(code, 0, stderr || stdout)
    assert.ok(names, 'normal CLI did not reach the local model fixture')
    assert.equal(names.includes('mcp__computer-use__screenshot'), enabled, JSON.stringify(names))
    assert.equal(names.filter(name => name.startsWith('mcp__computer-use__')).length, enabled ? 18 : 0)
  } finally {
    await server.stop(true)
  }
}

try {
  const { isLinuxComputerUseAvailable } = await import('../src/utils/computerUse/platforms/linux.js')
  const { getComputerUseHostAdapter } = await import('../src/utils/computerUse/hostAdapter.js')
  const { bindSessionContext, DEFAULT_GRANT_FLAGS } = await import('@ant/computer-use-mcp')
  await eventually(async () => assert.ok(await isLinuxComputerUseAvailable()), 'X11 backend is not available')
  const cancellation = new AbortController()
  await assert.rejects(withX11(async ({ client }) => {
    client.GrabServer()
    await client.sync()
    cancellation.abort()
  }, cancellation.signal), { name: 'AbortError' })
  assert.ok(await isLinuxComputerUseAvailable(), 'An aborted connection left the X11 server grabbed')
  await checkNormalCliRegistration(true)
  await checkNormalCliRegistration(false)
  console.log('[PASS] CLI registers X11 window tools and excludes a Wayland session')

  const a = await launch('Doge X11 approved fixture', '0xd02020', '340x230+50+60')
  const b = await launch('Doge X11 other fixture', '0x20d020', '250x210+525+82', true)
  const adapter = getComputerUseHostAdapter()
  let grants: readonly AppGrant[] = []
  let flags: CuGrantFlags = DEFAULT_GRANT_FLAGS
  let lastDims: ScreenshotDims | undefined
  const session: ComputerUseSessionContext = {
    getAllowedApps: () => grants,
    getGrantFlags: () => flags,
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => undefined,
    onAllowedAppsChanged: (apps, updatedFlags) => { grants = apps; flags = updatedFlags },
    onPermissionRequest: async request => ({
      userConsented: true,
      granted: request.apps.flatMap(app => app.resolved ? [{
        bundleId: app.resolved.bundleId, displayName: app.resolved.displayName, grantedAt: Date.now(), tier: 'full' as const,
      }] : []),
      denied: [],
      flags,
    }),
    onScreenshotCaptured: dims => { lastDims = dims },
    onScreenshotCleared: () => { lastDims = undefined },
  }
  const dispatch = bindSessionContext(adapter, 'pixels', session)
  const parallelDispatch = bindSessionContext(adapter, 'pixels', session)
  const { approved, other } = await eventually(async () => {
    const windows = await adapter.executor.listInstalledApps()
    const approved = windows.find(app => app.displayName.startsWith(a.name))
    const other = windows.find(app => app.displayName.startsWith(b.name))
    assert.ok(approved && other)
    return { approved, other }
  }, 'The X11 window manager did not manage both fixtures')
  assert.notEqual(approved.bundleId, other.bundleId)

  async function success(name: string, args: Record<string, unknown>) {
    const result = await dispatch(name, args)
    assert.ok(!result.isError, name + ' failed: ' + JSON.stringify(result.content))
    return result
  }

  assert.ok((await dispatch('screenshot', {})).isError, 'capture without an app grant')
  await success('request_access', { apps: [approved.bundleId], reason: 'Verify the approved fixture' })
  assert.deepEqual(grants.map(app => app.bundleId), [approved.bundleId])
  await success('open_application', { app: approved.bundleId })
  assert.ok((await dispatch('left_click', { coordinate: [60, 42] })).isError, 'input without capture')
  const pendingShot = success('screenshot', {})
  assert.ok((await parallelDispatch('screenshot', {})).isError, 'parallel X11 capture was accepted')
  const shot = await pendingShot
  assert.ok(lastDims && shot.screenshot)
  assert.equal(lastDims.displayWidth, 340)
  const [red, green] = pixel(shot.screenshot.base64, 290, 75)
  assert.ok(red! > 160 && green! < 80, 'capture did not contain the approved red window')
  const zoom = await success('zoom', { region: [258, 52, 323, 121] })
  const image = zoom.content.find(block => block.type === 'image')
  assert.ok(image)
  const [zoomRed, zoomGreen] = pixel(image.data, 30, 25)
  assert.ok(zoomRed! > 160 && zoomGreen! < 80, 'zoom did not contain the approved red window')
  await setFixtureShape(a.id, true)
  const shaped = await dispatch('screenshot', {})
  assert.ok(shaped.isError)
  assert.match(JSON.stringify(shaped.content), /nonrectangular window/)
  await setFixtureShape(a.id, false)
  await command(['xdotool', 'windowmove', '--sync', String(b.id), '270', '82'])
  assert.ok((await dispatch('screenshot', {})).isError, 'capture of an obscured authorized window')
  assert.ok((await dispatch('zoom', { region: [258, 52, 323, 121] })).isError, 'zoom of an obscured region')
  assert.ok((await dispatch('left_click', { coordinate: [290, 75] })).isError, 'input through another window')
  await command(['xdotool', 'windowmove', '--sync', String(b.id), '525', '82'])
  const grabbed = join(sandbox, 'grabbed')
  const grabClient = Bun.spawn([process.execPath, fixture, 'grab', grabbed], { stdout: 'ignore', stderr: 'inherit' })
  children.push(grabClient)
  await eventually(() => readFile(grabbed), 'other client did not grab the keyboard and pointer')
  try {
    const click = await dispatch('left_click', { coordinate: [60, 42] })
    assert.ok(click.isError)
    assert.match(JSON.stringify(click.content), /grabbed the pointer/)
    const key = await dispatch('key', { text: 'BackSpace' })
    assert.ok(key.isError)
    assert.match(JSON.stringify(key.content), /grabbed the keyboard/)
  } finally {
    grabClient.kill()
    await grabClient.exited
  }
  await success('left_click', { coordinate: [60, 42] })
  await eventually(async () => assert.equal((await a.state()).clicks, 1), 'authorized UI did not receive click')
  await success('left_click', { coordinate: [65, 105] })
  const clipboard = Bun.spawn(['xclip', '-selection', 'clipboard', '-in'], {
    stdin: Buffer.from('original clipboard'), stdout: 'ignore', stderr: 'ignore',
  })
  assert.equal(await clipboard.exited, 0)
  await success('type', { text: 'Doge 中文' })
  await eventually(async () => assert.equal((await a.state()).text, 'Doge 中文'), 'authorized UI did not receive text')
  assert.equal(await command(['xclip', '-selection', 'clipboard', '-out']), 'original clipboard')
  await success('key', { text: 'BackSpace' })
  await eventually(async () => assert.equal((await a.state()).text, 'Doge 中'), 'authorized UI did not receive key')
  await command(['xdotool', 'windowactivate', '--sync', String(b.id)])
  assert.ok((await dispatch('type', { text: 'denied' })).isError)
  assert.ok((await dispatch('screenshot', {})).isError)
  assert.ok((await dispatch('zoom', { region: [10, 10, 90, 90] })).isError)
  assert.deepEqual(await b.state(), { id: b.id, clicks: 0, text: '' })
  await success('open_application', { app: approved.bundleId })
  await success('screenshot', {})
  await command(['xdotool', 'windowmove', '--sync', String(a.id), '100', '120'])
  assert.ok((await dispatch('left_click', { coordinate: [60, 42] })).isError, 'input on a stale capture')
  assert.equal((await a.state()).clicks, 1)
  console.log('[PASS] real X11 permission, capture and zoom isolation, click, Unicode text, key and stale-anchor checks')
} finally {
  for (const child of children) child.kill()
  await Promise.all(children.map(child => child.exited))
  await rm(sandbox, { recursive: true, force: true })
}

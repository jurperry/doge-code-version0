import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { profileStepModel, spawnHeadlessStep } from './headlessStep.js'

const profile = { model: 'p-default', provider: 'anthropic' as const, baseURL: 'http://unused', defaultHaikuModel: 'p-small', defaultOpusModel: 'p-big[1m]' }
const sandbox = resolve(import.meta.dir, '../../../../doge-code-app/test/workflow-transport')
const previousExecutable = process.env.DOGE_WORKFLOW_EXECUTABLE
beforeAll(async () => {
  mkdirSync(sandbox, { recursive: true })
  const source = join(sandbox, 'fake-child.ts')
  writeFileSync(source, `
    import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
    if (process.argv.includes('--grandchild')) { setInterval(()=>{},1000); }
    else { const prompt = await Bun.stdin.text();
      if (prompt === 'remote-env') { console.log(JSON.stringify({type:'result',subtype:'success',result:process.env.DOGE_IM_REMOTE_DISABLE})); process.exit(0); }
      if (prompt === 'no-result') process.exit(0);
      if (prompt === 'nonzero') { console.log(JSON.stringify({type:'result',subtype:'success',result:'looks successful'})); console.error('noise'); console.error('actual failure'); process.exit(7); }
      if (prompt === 'wait') { const child=spawn(process.execPath,['--grandchild'],{stdio:'ignore',detached:process.platform !== 'win32',windowsHide:true}); writeFileSync('child.pid',String(child.pid)); setInterval(()=>{},1000); }
      else { const bytes=Buffer.from(JSON.stringify({type:'result',subtype:'success',result:prompt})); process.stdout.write(bytes.subarray(0,50)); setTimeout(()=>process.stdout.write(bytes.subarray(50)),10); }
    }
  `)
  const exe = join(sandbox, process.platform === 'win32' ? 'fake-child.exe' : 'fake-child')
  await Bun.build({ entrypoints: [source], compile: { outfile: exe }, target: 'bun' })
  process.env.DOGE_WORKFLOW_EXECUTABLE = exe
})
afterAll(async () => {
  if (previousExecutable === undefined) delete process.env.DOGE_WORKFLOW_EXECUTABLE
  else process.env.DOGE_WORKFLOW_EXECUTABLE = previousExecutable
  // Windows can retain a compiled executable's handle briefly after taskkill
  // reports completion. Let the OS release it before deleting the fixture.
  for (let attempt = 0; ; attempt++) {
    try { rmSync(sandbox, { recursive: true, force: true }); break }
    catch (error) { if (attempt >= 30) throw error; await Bun.sleep(100) }
  }
})
const run = (prompt: string, controller = new AbortController(), timeoutSec?: number) => spawnHeadlessStep({ prompt, model: 'p-small', profile,
  cwd: sandbox, signal: controller.signal, permissionMode: 'default', timeoutSec, onMessage: async () => {} })
test('profile aliases resolve within their provider and explicit model IDs stay exact', () => {
  expect(profileStepModel(profile, 'haiku')).toBe('p-small')
  expect(profileStepModel(profile, 'opus')).toBe('p-big[1m]')
  expect(profileStepModel(profile, 'haiku[1m]')).toBe('p-small[1m]')
  expect(profileStepModel(profile, 'some-model')).toBe('some-model')
  expect(profileStepModel(profile)).toBe('p-default')
  expect(profileStepModel(profile, 'inherit')).toBe('p-default')
  expect(profileStepModel(profile, 'sonnet')).toBe('p-default')
})
test('an already cancelled step never spawns a process', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await spawnHeadlessStep({ prompt: 'long'.repeat(10000), model: 'p-small', profile,
    permissionMode: 'default', cwd: process.cwd(), signal: controller.signal, onMessage: async () => { throw new Error('must not be invoked') } })
  expect(result.status).toBe('stopped')
})
test('stdin accepts large Unicode input and consumes a final record without a newline', async () => {
  const prompt = '中文字\n"quotes" =literal'.repeat(2000)
  expect(await run(prompt)).toMatchObject({ status: 'completed', output: prompt })
})
test('step child disables remote attachment without changing the parent environment', async () => {
  const previous = process.env.DOGE_IM_REMOTE_DISABLE
  process.env.DOGE_IM_REMOTE_DISABLE = 'parent-value'
  try {
    expect(await run('remote-env')).toMatchObject({ status: 'completed', output: '1' })
    expect(process.env.DOGE_IM_REMOTE_DISABLE).toBe('parent-value')
  } finally {
    if (previous === undefined) delete process.env.DOGE_IM_REMOTE_DISABLE
    else process.env.DOGE_IM_REMOTE_DISABLE = previous
  }
})
test('missing results and nonzero exits cannot be mistaken for success', async () => {
  expect((await run('no-result')).status).toBe('failed')
  expect(await run('nonzero')).toMatchObject({ status: 'failed', error: '子进程退出码 7：actual failure' })
})
test('timeout terminates the process tree and returns failed', async () => {
  rmSync(join(sandbox, 'child.pid'), { force: true })
  expect((await run('wait', new AbortController(), 1)).status).toBe('failed')
  const pid = readFileSync(join(sandbox, 'child.pid'), 'utf8')
  if (process.platform === 'win32') expect(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true })).not.toContain(pid)
  else expect(() => process.kill(Number(pid), 0)).toThrow()
})
test('interrupt during execution terminates the request as stopped', async () => {
  rmSync(join(sandbox, 'child.pid'), { force: true })
  const controller = new AbortController()
  const pending = run('wait', controller)
  for (let n = 0; n < 100 && !existsSync(join(sandbox, 'child.pid')); n++) await Bun.sleep(20)
  controller.abort()
  expect((await pending).status).toBe('stopped')
})

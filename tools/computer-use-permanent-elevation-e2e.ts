import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ensureElevatedPowerShell,
  runComputerUsePowerShell,
  setComputerUseTargetElevated,
  stopElevatedPowerShell,
} from '../src/utils/computerUse/win32/elevatedPowerShell.js'
import {
  disablePermanentElevation,
  enablePermanentElevation,
  getPermanentElevationDescriptor,
  getPermanentElevationStatus,
} from '../src/utils/computerUse/win32/permanentElevation.js'

const root = resolve(import.meta.dir, '..')
const config = join(root, 'test', 'computer-use-permanent-elevation-e2e')
const env = { ...process.env, CLAUDE_CONFIG_DIR: config }
const isAdministrator = '[Console]::Out.Write(([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))'

async function verifyAdministrator(label: string): Promise<void> {
  await ensureElevatedPowerShell()
  setComputerUseTargetElevated(true)
  assert.equal(await runComputerUsePowerShell(isAdministrator), 'True')
  console.log(`PASS ${label}`)
}

async function verifyOwnerCancellation(): Promise<void> {
  mkdirSync(config, { recursive: true })
  const moduleUrl = pathToFileURL(join(root, 'src', 'utils', 'computerUse', 'win32', 'elevatedPowerShell.ts')).href
  const ownerFile = join(config, 'owner.ts')
  const started = join(config, 'started.txt')
  const finished = join(config, 'finished.txt')
  const startedLiteral = started.replace(/'/g, "''")
  const finishedLiteral = finished.replace(/'/g, "''")
  const action = `[System.IO.File]::WriteAllText('${startedLiteral}', 'started'); Start-Sleep -Milliseconds 5000; [System.IO.File]::WriteAllText('${finishedLiteral}', 'finished')`
  writeFileSync(ownerFile, `import { writeFileSync } from 'node:fs'; import { ensureElevatedPowerShell, runComputerUsePowerShell, setComputerUseTargetElevated } from ${JSON.stringify(moduleUrl)}; await ensureElevatedPowerShell(); setComputerUseTargetElevated(true); await runComputerUsePowerShell(${JSON.stringify(action)})`)
  const owner = Bun.spawn([process.execPath, ownerFile], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  try {
    const deadline = Date.now() + 15_000
    while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(25)
    if (!existsSync(started)) {
      const exited = await Promise.race([owner.exited, Bun.sleep(100).then(() => null)])
      const detail = exited === null ? 'owner is still running' : await new Response(owner.stderr).text()
      assert.fail(`Permanent action did not start: ${detail}`)
    }
    spawnSync('taskkill', ['/PID', String(owner.pid), '/F'], { stdio: 'ignore', windowsHide: true })
    await owner.exited
    await Bun.sleep(5200)
    assert.equal(existsSync(finished), false, 'owner cancellation must stop the remaining action')
    assert.equal(getPermanentElevationStatus().running, true, 'the task-owned broker must survive its CLI owner')
    console.log('PASS 属主强杀取消剩余动作且计划任务代理存活')
  } finally {
    try { owner.kill() } catch {}
  }
}

async function verifyConcurrentRevocation(): Promise<void> {
  const moduleUrl = pathToFileURL(join(root, 'src', 'utils', 'computerUse', 'win32', 'elevatedPowerShell.ts')).href
  const permanentUrl = pathToFileURL(join(root, 'src', 'utils', 'computerUse', 'win32', 'permanentElevation.ts')).href
  const workerFile = join(config, 'reconnector.ts')
  const ready = join(config, 'reconnector-ready.txt')
  const complete = join(config, 'revocation-complete.txt')
  const revocationPath = getPermanentElevationDescriptor().revocationPath
  writeFileSync(workerFile, `import { writeFileSync } from 'node:fs'; import { existsSync } from 'node:fs'; import { ensureElevatedPowerShell, runComputerUsePowerShell, setComputerUseTargetElevated } from ${JSON.stringify(moduleUrl)}; import { getPermanentElevationStatus } from ${JSON.stringify(permanentUrl)}; await ensureElevatedPowerShell(); setComputerUseTargetElevated(true); writeFileSync(${JSON.stringify(ready)}, 'ready'); try { while (!existsSync(${JSON.stringify(revocationPath)}) && !existsSync(${JSON.stringify(complete)})) { await ensureElevatedPowerShell(); setComputerUseTargetElevated(true); await runComputerUsePowerShell('[Console]::Out.Write("ok")'); await Bun.sleep(20) } } catch (error) { if (!existsSync(${JSON.stringify(complete)}) && getPermanentElevationStatus().enabled && !existsSync(${JSON.stringify(revocationPath)})) throw error } console.log('REVOCATION_STOPPED')`)
  const worker = Bun.spawn([process.execPath, workerFile], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  let stopped = false
  try {
    const deadline = Date.now() + 15_000
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(25)
    assert.equal(existsSync(ready), true, 'reconnector did not become ready')
    const status = await disablePermanentElevation()
    assert.equal(status.enabled, false)
    assert.equal(status.running, false)
    writeFileSync(complete, 'done', 'utf8')
    const exitCode = await Promise.race([worker.exited, Bun.sleep(15_000).then(() => null)])
    assert.notEqual(exitCode, null, 'reconnector survived revocation')
    assert.equal(exitCode, 0, await new Response(worker.stderr).text())
    assert.match(await new Response(worker.stdout).text(), /REVOCATION_STOPPED/)
    stopped = true
    console.log('PASS 持续执行/重连进程在撤销后停止且代理不复活')
  } finally {
    if (!stopped) {
      try { worker.kill() } catch {}
      await worker.exited
    }
  }
}

rmSync(config, { recursive: true, force: true })
let failure: unknown
try {
  await enablePermanentElevation()
  await verifyAdministrator('永久代理返回真实管理员令牌')
  const stopped = spawnSync(process.execPath, [
    join(root, 'src', 'bootstrap-entry.ts'),
    '--computer-use-elevation',
    'stop',
  ], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(stopped.status, 0, stopped.stderr)
  assert.equal(JSON.parse(stopped.stdout.trim()).status.running, false)
  console.log('PASS 外部控制命令停止代理且保留授权')
  await verifyAdministrator('原 CLI 在闲置/停止后首次操作自动重连')
  await stopElevatedPowerShell()
  await verifyOwnerCancellation()
  await verifyAdministrator('属主取消后新会话仍可重连')
  await stopElevatedPowerShell()
  await verifyConcurrentRevocation()
} catch (error) {
  failure = error
}
let cleanupError: unknown
try {
  const status = getPermanentElevationStatus()
  if (status.enabled || status.needsRepair) await disablePermanentElevation()
} catch (error) {
  cleanupError = error
}
if (cleanupError) {
  if (failure) console.error('Original E2E failure:', failure)
  throw new Error(`Permanent elevation cleanup failed; preserving ${config}`, { cause: cleanupError })
}
rmSync(config, { recursive: true, force: true })
if (failure) throw failure

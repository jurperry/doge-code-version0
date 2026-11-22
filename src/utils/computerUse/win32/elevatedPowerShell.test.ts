import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getCurrentProcessIL, getProcessIL, needsElevatedHelper, parseIntegrityLevel } from './elevation.js'
import {
  _test,
  ensureElevatedPowerShell,
  getElevatedPowerShellPid,
  isElevatedPowerShellActive,
  prepareComputerUseRelease,
  runComputerUsePowerShell,
  runComputerUsePowerShellSync,
  setComputerUseTargetElevated,
} from './elevatedPowerShell.js'

test('only a higher-integrity target requests the elevated helper', () => {
  expect(needsElevatedHelper('medium', 'high')).toBe(true)
  expect(needsElevatedHelper('medium', 'restricted')).toBe(true)
  expect(needsElevatedHelper('high', 'restricted')).toBe(false)
  expect(parseIntegrityLevel('-2')).toBe('restricted')
  expect(parseIntegrityLevel('-1')).toBe('unknown')
  expect(needsElevatedHelper('low', 'medium')).toBe(false)
  expect(needsElevatedHelper('medium', 'system')).toBe(false)
  expect(needsElevatedHelper('medium', 'medium')).toBe(false)
  expect(needsElevatedHelper('high', 'medium')).toBe(false)
  expect(needsElevatedHelper('unknown', 'high')).toBe(false)
  expect(needsElevatedHelper('medium', 'unknown')).toBe(false)
})

test.skipIf(process.platform !== 'win32')('self and PID queries agree on the native integrity SID', () => {
  expect(getCurrentProcessIL()).not.toBe('unknown')
  expect(getProcessIL(process.pid)).toBe(getCurrentProcessIL())
  expect(getProcessIL(-1)).toBe('unknown')
})

test.skipIf(process.platform !== 'win32')('the persistent broker preserves output, input, errors and cancellation', async () => {
  await _test.startLocal()
  try {
    expect(isElevatedPowerShellActive()).toBe(true)
    expect(getElevatedPowerShellPid()).toBe(_test.activePid())
    expect(runComputerUsePowerShellSync('[Console]::Out.Write("sync-ok")')).toBe('sync-ok')
    expect(await runComputerUsePowerShell('[Console]::Out.Write([Console]::In.ReadToEnd())', 5000, 'input-中😀\n'.repeat(10_000) + 'end')).toBe('input-中😀\n'.repeat(10_000) + 'end')
    expect(await runComputerUsePowerShell('[Console]::Out.Write("first"); [Console]::Out.Write("second")')).toBe('firstsecond')
    await expect(runComputerUsePowerShell('throw "action-failed"')).rejects.toThrow(/CU_HELPER_ACTION.*action-failed/)
    expect(isElevatedPowerShellActive()).toBe(true)
    expect(await runComputerUsePowerShell('"still-alive"')).toBe('still-alive')

    const parentQuery = '(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId'
    expect(Number(await runComputerUsePowerShell(parentQuery))).toBe(_test.activePid())
    setComputerUseTargetElevated(false)
    expect(Number(await runComputerUsePowerShell(parentQuery))).toBe(process.pid)
    setComputerUseTargetElevated(true)

    const slow = runComputerUsePowerShell('Start-Sleep -Milliseconds 500; "slow-ok"')
    await ensureElevatedPowerShell()
    expect(await slow).toBe('slow-ok')
    expect(isElevatedPowerShellActive()).toBe(true)

    const marker = join(tmpdir(), `doge-cu-cancel-${process.pid}.txt`)
    rmSync(marker, { force: true })
    const blocker = runComputerUsePowerShell('Start-Sleep -Milliseconds 500')
    const queuedController = new AbortController()
    const queued = runComputerUsePowerShell(`[System.IO.File]::WriteAllText('${marker.replace(/'/g, "''")}', 'dispatched')`, 5000, 'queued-input', queuedController.signal)
    queuedController.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    await blocker
    expect(existsSync(marker)).toBe(false)

    const controller = new AbortController()
    const markerLiteral = marker.replace(/'/g, "''")
    const pending = runComputerUsePowerShell(`
[System.IO.File]::WriteAllText('${markerLiteral}', 'started')
Start-Sleep -Milliseconds 1500
[System.IO.File]::WriteAllText('${markerLiteral}', 'finished')
`, 5000, undefined, controller.signal)
    const deadline = Date.now() + 3500
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20)
    expect(existsSync(marker)).toBe(true)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(await runComputerUsePowerShell('"after-cancel"')).toBe('after-cancel')
    await Bun.sleep(1600)
    expect(readFileSync(marker, 'utf8')).toBe('started')
    rmSync(marker, { force: true })

    process.kill(_test.activePid()!, 9)
    await prepareComputerUseRelease()
    expect(isElevatedPowerShellActive()).toBe(false)
    expect(getElevatedPowerShellPid()).toBeNull()
    expect(await runComputerUsePowerShell('$PID')).toMatch(/^\d+$/)
  } finally {
    await _test.stop()
  }
  expect(isElevatedPowerShellActive()).toBe(false)
}, 30_000)


test.skipIf(process.platform !== 'win32')('broker exits when its owner is force-killed', async () => {
  const dir = join(tmpdir(), `doge-cu-owner-${process.pid}`)
  const ownerFile = join(dir, 'owner.ts')
  const pidFile = join(dir, 'broker.pid')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const modulePath = pathToFileURL(resolve(import.meta.dir, 'elevatedPowerShell.ts')).href
  writeFileSync(ownerFile, `import { writeFileSync } from 'node:fs'; import { _test } from ${JSON.stringify(modulePath)}; await _test.startLocal(); writeFileSync(${JSON.stringify(pidFile)}, String(_test.activePid())); await new Promise(() => {})`)
  const owner = Bun.spawn(['bun', ownerFile], { stdout: 'inherit', stderr: 'inherit' })
  let brokerPid = 0
  try {
    const deadline = Date.now() + 10_000
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(50)
    expect(existsSync(pidFile)).toBe(true)
    brokerPid = Number(readFileSync(pidFile, 'utf8'))
    spawnSync('taskkill', ['/PID', String(owner.pid), '/F'], { stdio: 'ignore' })
    await owner.exited
    let exited = false
    for (let i = 0; i < 40; i++) {
      try { process.kill(brokerPid, 0) } catch { exited = true; break }
      await Bun.sleep(100)
    }
    expect(exited).toBe(true)
  } finally {
    try { owner.kill() } catch {}
    if (brokerPid > 0) { try { process.kill(brokerPid, 9) } catch {} }
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)

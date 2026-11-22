import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildPermanentBrokerScript, createPermanentElevationDescriptor, getPermanentElevationStatus, getWindowsOwnerIdentity } from './permanentElevation.js'

test('permanent elevation tasks and pipes are scoped to user and config directory', () => {
  const root = process.platform === 'win32' ? 'C:\\Users\\Test\\.doge' : '/tmp/doge'
  const first = createPermanentElevationDescriptor(root, 'S-1-5-21-1001')
  const same = createPermanentElevationDescriptor(`${root}${process.platform === 'win32' ? '\\' : '/'}`, 'S-1-5-21-1001')
  const otherUser = createPermanentElevationDescriptor(root, 'S-1-5-21-1002')
  const otherConfig = createPermanentElevationDescriptor(join(root, 'other'), 'S-1-5-21-1001')
  expect(same.taskName).toBe(first.taskName)
  expect(same.pipeName).toBe(first.pipeName)
  expect(otherUser.taskName).not.toBe(first.taskName)
  expect(otherUser.pipeName).not.toBe(first.pipeName)
  expect(otherConfig.taskName).not.toBe(first.taskName)
  expect(otherConfig.pipeName).not.toBe(first.pipeName)
  expect(first.scriptPath.toLowerCase().replaceAll('/', '\\')).toContain('computer-use\\elevated-broker-v1.ps1')
})

test.skipIf(process.platform !== 'win32')('an isolated config has no permanent authorization by default', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(process.cwd(), 'test', `permanent-elevation-absent-${process.pid}`)
  try {
    expect(getPermanentElevationStatus()).toEqual({
      supported: true,
      enabled: false,
      running: false,
      needsRepair: false,
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
}, 15_000)


test.skipIf(process.platform !== 'win32')('a permanent broker records its identity and exits on revocation without UAC', async () => {
  const config = join(process.cwd(), 'test', `permanent-revocation-${process.pid}`)
  const descriptor = {
    ...createPermanentElevationDescriptor(config, getWindowsOwnerIdentity().callerSid),
    callerSid: getWindowsOwnerIdentity().callerSid,
  }
  rmSync(config, { recursive: true, force: true })
  mkdirSync(dirname(descriptor.scriptPath), { recursive: true })
  writeFileSync(descriptor.scriptPath, `\uFEFF${buildPermanentBrokerScript(descriptor)}`, 'utf8')
  const broker = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', descriptor.scriptPath], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  })
  try {
    const deadline = Date.now() + 10_000
    while (!existsSync(descriptor.pidPath) && Date.now() < deadline) await Bun.sleep(25)
    if (!existsSync(descriptor.pidPath)) {
      throw new Error(existsSync(descriptor.logPath) ? readFileSync(descriptor.logPath, 'utf8') : 'Broker PID metadata was not created')
    }
    const metadata = JSON.parse(readFileSync(descriptor.pidPath, 'utf8').replace(/^\uFEFF/, ''))
    expect(metadata.pid).toBe(broker.pid)
    writeFileSync(descriptor.revocationPath, 'revoke', 'utf8')
    const exitCode = await Promise.race([broker.exited, Bun.sleep(10_000).then(() => null)])
    expect(exitCode).toBe(0)
    expect(existsSync(descriptor.pidPath)).toBe(false)
  } finally {
    try { broker.kill() } catch {}
    await broker.exited
    rmSync(config, { recursive: true, force: true })
  }
}, 20_000)

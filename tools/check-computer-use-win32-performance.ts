/** Read-only performance regression on the active Windows desktop. */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { captureScreenForApi, platform } from '../src/utils/computerUse/platforms/win32.js'
import { listWindowDetails } from '../src/utils/computerUse/win32/windowEnum.js'
import { getCurrentProcessIL } from '../src/utils/computerUse/win32/elevation.js'
import { _test, runPowerShellSync } from '../src/utils/computerUse/win32/powerShell.js'

if (process.platform !== 'win32') throw new Error('This benchmark requires Windows')
const box = join(process.cwd(), 'test', 'cu-win32-performance')
mkdirSync(box, { recursive: true })
process.env.TEMP = box
process.env.TMP = box
let launches = 0

async function measure(name: string, maxP95Ms: number, maxLaunches: number, action: () => unknown) {
  await action()
  const times: number[] = []
  let processStarts = 0
  for (let i = 0; i < 8; i++) {
    launches = 0
    const started = performance.now()
    await action()
    times.push(performance.now() - started)
    processStarts = Math.max(processStarts, launches)
  }
  times.sort((a, b) => a - b)
  const p50 = Math.round(times[Math.ceil(times.length * 0.5) - 1]!)
  const p95 = Math.round(times[Math.ceil(times.length * 0.95) - 1]!)
  console.log(JSON.stringify({ name, p50, p95, processStarts, samples: times.length }))
  assert.ok(p95 <= maxP95Ms, `${name} p95 ${p95} ms exceeded ${maxP95Ms} ms`)
  assert.ok(processStarts <= maxLaunches, `${name} started ${processStarts} PowerShell processes, expected at most ${maxLaunches}`)
}

try {
  const primary = platform.display.listAll().find(display => display.isPrimary)
  assert.ok(primary, 'primary display was resolved')
  console.log(JSON.stringify({ desktop: { width: primary.width, height: primary.height, integrity: getCurrentProcessIL() } }))
  _test.observeSpawns(() => { launches++ })
  await measure('window enumeration', 2500, 1, () => listWindowDetails())
  await measure('full-display screenshot', 4000, 2, () => captureScreenForApi())
  await measure('PowerShell startup', 1200, 1, () => runPowerShellSync("'ready'"))
} finally {
  _test.observeSpawns()
  rmSync(box, { recursive: true, force: true })
}

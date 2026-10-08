// One-off probe: real PowerShell execution through src/utils/Shell.ts exec()
// after the 2.1.276 provider changes (UTF-8 preamble + ExecutionPolicy Bypass).
// Verifies: command runs, Chinese output is not mojibake, exit code captured.
// Usage: bun test/pwsh-exec-probe.ts  (self-cleaning)
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sandbox = mkdtempSync(join(tmpdir(), 'doge-ps-probe-'))
process.env.CLAUDE_CONFIG_DIR = sandbox

const failures: string[] = []
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok   ${name}`)
  else {
    failures.push(name)
    console.log(`FAIL ${name}`, detail ?? '')
  }
}

try {
  const { exec } = await import('../src/utils/Shell.js')

  // 1. Basic command + Chinese output (UTF-8 preamble must prevent mojibake)
  const ac1 = new AbortController()
  const sc1 = await exec(
    "Write-Output '中文输出测试'; Write-Output $PSVersionTable.PSVersion.ToString()",
    ac1.signal,
    'powershell',
    { timeout: 30_000 },
  )
  const r1 = await sc1.result
  console.log('--- run1 raw ---')
  console.log(JSON.stringify({ code: r1.code, stdout: r1.stdout, stderr: r1.stderr }))
  check('exit code 0', r1.code === 0)
  check('chinese output intact', (r1.stdout ?? '').includes('中文输出测试'))
  check('prints PS version', /\d+\.\d+/.test(r1.stdout ?? ''))

  // 2. Non-zero exit propagation
  const ac2 = new AbortController()
  const sc2 = await exec('exit 42', ac2.signal, 'powershell', {
    timeout: 30_000,
  })
  const r2 = await sc2.result
  check('exit code 42 propagated', r2.code === 42, r2.code)

  // 3. stderr surface
  const ac3 = new AbortController()
  const sc3 = await exec(
    "[Console]::Error.Write('oops-错误')",
    ac3.signal,
    'powershell',
    { timeout: 30_000 },
  )
  const r3 = await sc3.result
  console.log('--- run3 raw ---')
  console.log(JSON.stringify({ code: r3.code, stdout: r3.stdout, stderr: r3.stderr }))
  check(
    'stderr captured with chinese',
    (r3.stderr ?? '').includes('oops-错误') ||
      (r3.stdout ?? '').includes('oops-错误'),
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length) {
  console.log(`\n${failures.length} probe check(s) FAILED`)
  process.exit(1)
}
console.log('\nall pwsh exec probe checks passed')

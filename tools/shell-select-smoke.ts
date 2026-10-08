// Smoke for /shell + tool-pool exclusivity. Runs in a CLAUDE_CONFIG_DIR
// sandbox under test/ so real ~/.doge settings are never touched.
// Usage: bun test/shell-select-smoke.ts  (self-cleaning)
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sandbox = mkdtempSync(join(tmpdir(), 'doge-shell-smoke-'))
process.env.CLAUDE_CONFIG_DIR = sandbox

const failures: string[] = []
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`ok   ${name}`)
  else {
    failures.push(name)
    console.log(`FAIL ${name}`, detail ?? '')
  }
}

const { call } = await import('../src/commands/shell/shell.js')
const { getInitialSettings } = await import('../src/utils/settings/settings.js')
const { getAllBaseTools } = await import('../src/tools.js')
const { resolveActiveShellTool } = await import(
  '../src/utils/shell/shellToolUtils.js'
)
const {
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} = await import('../src/bootstrap/state.js')

async function runShell(args: string): Promise<string> {
  let message = ''
  const result = await call((m?: string) => {
    message = m ?? ''
  }, {} as never, args)
  // 'select' (empty args) returns JSX instead of calling onDone — not exercised here
  if (result) throw new Error('unexpected JSX for args: ' + args)
  return message
}

// status on fresh sandbox → bash default
const status1 = await runShell('status')
check('status shows Bash as current by default', /^Current shell: Bash/m.test(status1), status1)
check('status lists Bash availability', /^Bash: /m.test(status1))
check('status lists Pwsh availability', /^Pwsh: /m.test(status1))

// /shell pwsh — with a seeded system-prompt section cache entry standing in
// for the stale env_info section; the switch must clear it (M1 regression).
setSystemPromptSectionCacheEntry('env_info_simple', 'Shell: bash.exe (stale)')
check('section cache seeded', getSystemPromptSectionCache().has('env_info_simple'))
const set1 = await runShell('pwsh')
check('set pwsh confirms switch', set1.includes('Switched to Pwsh'), set1)
check('settings persisted defaultShell=powershell', getInitialSettings().defaultShell === 'powershell')
check(
  'system prompt section cache cleared on switch (M1)',
  getSystemPromptSectionCache().size === 0,
)

// tool pool swap
const tools1 = getAllBaseTools().map(t => t.name)
check('pwsh active: PowerShell in pool', tools1.includes('PowerShell'), tools1.filter(n => /bash|powershell/i.test(n)))
check('pwsh active: Bash removed from pool', !tools1.includes('Bash'))
check('resolveActiveShellTool = powershell', resolveActiveShellTool() === 'powershell')

// /shell bash
const set2 = await runShell('bash')
check('set bash confirms switch', set2.includes('Switched to Bash'), set2)
const tools2 = getAllBaseTools().map(t => t.name)
check('bash active: Bash in pool', tools2.includes('Bash'))
check('bash active: PowerShell removed from pool', !tools2.includes('PowerShell'), tools2.filter(n => /bash|powershell/i.test(n)))
check('resolveActiveShellTool = bash', resolveActiveShellTool() === 'bash')

// invalid arg
const bad = await runShell('zsh')
check('invalid arg prints usage', bad.includes('Usage: /shell'), bad)

// env=1 alone (no setting) must NOT make pwsh active
await runShell('bash') // ensure setting is bash
process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'
const tools3 = getAllBaseTools().map(t => t.name)
check('env=1 + bash setting: Bash stays, PowerShell stays out', tools3.includes('Bash') && !tools3.includes('PowerShell'))
delete process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL

rmSync(sandbox, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} FAILED`)
  process.exit(1)
}
console.log('\nall smoke checks passed')
process.exit(0)

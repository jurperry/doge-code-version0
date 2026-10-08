// e2e: `doge --agent-teams` CLI flag acceptance (regression for the
// commander unknown-option bug).
//
// Root cause this guards against: the flag was registered only inside the
// ant-only block in main.tsx (`if ("external" === 'ant')` — the restored
// source inlines USER_TYPE as the literal "external", so the block is dead),
// and commander rejects unregistered options as `error: unknown option`
// before any session logic — the runtime gate in agentSwarmsEnabled.ts never
// ran. Fix registers the flag unconditionally (hideHelp for non-ant builds).
//
// Methodological trap baked into case 2: `--agent-teams --help`/`--version`
// short-circuit BEFORE option parsing, so they exit 0 even when the flag is
// broken — never use them alone to assert flag availability.
//
// Runnable repeatedly: `bun run test/e2e-agent-teams-flag.ts`
// Uses a throwaway CLAUDE_CONFIG_DIR sandbox, cleaned up on exit.
import { spawnSync } from 'child_process'
import { rmSync } from 'fs'
import { join } from 'path'

const REPO = process.cwd()
const ENTRY = join(REPO, 'src', 'bootstrap-entry.ts')
const SANDBOX = join(REPO, 'test', 'tmp-agent-teams-flag-sandbox')
process.env.CLAUDE_CONFIG_DIR = SANDBOX
delete process.env.NODE_ENV

let failures = 0
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  })
  return { code: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

try {
  // 1. The fix itself: the flag must reach option parsing with a real
  //    subcommand and not die as `error: unknown option`.
  const flag = run(['--agent-teams', 'agents'])
  check(
    '--agent-teams agents exits 0',
    flag.code === 0 && !flag.out.includes('unknown option'),
    `exit=${flag.code} out=${flag.out.slice(0, 200)}`,
  )

  // 2. Control: genuinely unknown flags are still rejected by commander.
  const ctrl = run(['--zzz-unknown-flag', 'agents'])
  check(
    'unknown flag still rejected',
    ctrl.out.includes("unknown option '--zzz-unknown-flag'"),
    `exit=${ctrl.code} out=${ctrl.out.slice(0, 200)}`,
  )

  // 3. hideHelp: external builds must not advertise the flag in --help
  //    (help is ant-only for this option; the env var is the documented
  //    external opt-in).
  const help = run(['--help'])
  check(
    '--agent-teams hidden from --help',
    help.code === 0 && !help.out.includes('--agent-teams'),
    `exit=${help.code} mentions=${help.out.includes('--agent-teams')}`,
  )

  // 4. Documented trap: --version short-circuits before option parsing, so
  //    it exits 0 regardless — recorded here so nobody "verifies" the flag
  //    with it again.
  const ver = run(['--agent-teams', '--version'])
  check(
    '--agent-teams --version exits 0 (short-circuit, NOT a proof of acceptance)',
    ver.code === 0,
    `exit=${ver.code}`,
  )

  // 5. Regression: the env-var opt-in path is untouched.
  const env = run(['agents'], { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' })
  check(
    'env opt-in path still works',
    env.code === 0 && !env.out.includes('unknown option'),
    `exit=${env.code} out=${env.out.slice(0, 200)}`,
  )
} finally {
  rmSync(SANDBOX, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')

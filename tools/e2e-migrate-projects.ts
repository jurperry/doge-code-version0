/**
 * E2E: startup migration of legacy v1 project dirs (cli.tsx hook).
 *
 * Crafts a sandboxed CLAUDE_CONFIG_DIR with a v1-named dir + one session,
 * boots the real CLI entrypoint (a non-fast-path mode: --help goes through
 * the full main import, right past the migration hook), then verifies the
 * directory was renamed to the v2 encoding with the session inside.
 *
 * Run: bun test/e2e-migrate-projects.ts   (from the doge-code repo root)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const ROOT = resolve(join(import.meta.dir, 'tmp-e2e-migrate'))
const CONFIG = join(ROOT, 'config')
const PROJECTS = join(CONFIG, 'projects')
const CWD = join(ROOT, 'cwd', 'hyphen-ated', 'repo')
const SID = 'aaaaaaaa-0000-4000-8000-000000000001'

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`)
    process.exitCode = 1
  } else {
    console.log(`PASS ${name}`)
  }
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true })
  process.env.CLAUDE_CONFIG_DIR = CONFIG
  mkdirSync(CWD, { recursive: true })

  // v1-era dir with one session whose cwd points at the real folder
  const v1 = join(PROJECTS, 'E--' + ROOT.slice(3).replaceAll(/[\\/:]/g, '-').replaceAll('-', '-'))
  // build the exact v1 name deterministically the way the old code did
  const v1Name = CWD.replace(/[^a-zA-Z0-9]/g, '-')
  const v1Dir = join(PROJECTS, v1Name)
  mkdirSync(v1Dir, { recursive: true })
  writeFileSync(
    join(v1Dir, `${SID}.jsonl`),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello from the v1 era' },
      cwd: CWD,
      sessionId: SID,
      timestamp: new Date().toISOString(),
    }) + '\n',
  )
  void v1

  // boot the CLI through the real entrypoint; --help exits 0 after the
  // full main import (which sits behind the migration hook)
  const proc = Bun.spawn(['bun', 'src/bootstrap-entry.ts', '--help'], {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode] = await Promise.all([proc.exited])
  const stderr = await new Response(proc.stderr).text()
  check('CLI booted through the migration hook', exitCode === 0, `exit=${exitCode} ${stderr.slice(0, 200)}`)

  const v2Name = CWD.replaceAll('\\', '~').replaceAll('/', '~').replace(':', (m) => '%' + Buffer.from(m).toString('hex'))
  const v2Dir = join(PROJECTS, v2Name)
  check('v1 dir renamed to v2', !existsSync(v1Dir) && existsSync(v2Dir), v2Name)
  check(
    'session moved inside the v2 dir',
    existsSync(join(v2Dir, `${SID}.jsonl`)),
  )

  // second boot: nothing left to migrate, still exits cleanly
  const proc2 = Bun.spawn(['bun', 'src/bootstrap-entry.ts', '--help'], {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exit2] = await Promise.all([proc2.exited])
  check('second boot idempotent', exit2 === 0 && existsSync(v2Dir))

  process.env.CLAUDE_CONFIG_DIR = undefined
  rmSync(ROOT, { recursive: true, force: true })
  console.log('done')
}

void main()

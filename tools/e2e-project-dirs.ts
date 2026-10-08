/**
 * E2E: project directory naming (v2 encoding + v1 legacy read fallback).
 *
 * Runs the real production functions (getProjectDir / findProjectDir /
 * fetchLogs / resolveSessionFilePath) against a sandboxed CLAUDE_CONFIG_DIR,
 * with the process actually chdir'd into a hyphenated test cwd. Verifies:
 *
 *  1. New writes target the v2-encoded directory name.
 *  2. Legacy v1 directories are still discovered for listing/resume.
 *  3. Cross-project resume (no dir) finds sessions regardless of encoding.
 *
 * Run: bun test/e2e-project-dirs.ts   (from the doge-code repo root)
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { setOriginalCwd } from '../src/bootstrap/state.js'
import {
  findProjectDir,
  getProjectDir,
  legacySanitizePath,
  resolveSessionFilePath,
} from '../src/utils/sessionStoragePortable.js'
import { fetchLogs } from '../src/utils/sessionStorage.js'

const ROOT = resolve(join(import.meta.dir, 'tmp-e2e-project-dirs'))
const CONFIG = join(ROOT, 'config')
const PROJECTS = join(CONFIG, 'projects')

// A real cwd whose folder names contain hyphens — the ambiguity v2 fixes.
const CWD = join(ROOT, 'cwd', 'hyphen-ated', 'proj-ect')
const SESSION_ID = '11111111-2222-3333-4444-555555555555'

function setup(): void {
  rmSync(ROOT, { recursive: true, force: true })
  process.env.CLAUDE_CONFIG_DIR = CONFIG
  mkdirSync(CWD, { recursive: true })
  // v1-era directory with one session file
  const legacyDir = join(PROJECTS, legacySanitizePath(CWD))
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(
    join(legacyDir, `${SESSION_ID}.jsonl`),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello from the v1 era' },
      cwd: CWD,
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
    }) + '\n',
  )
}

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`)
    process.exitCode = 1
  } else {
    console.log(`PASS ${name}`)
  }
}

async function main(): Promise<void> {
  setup()
  process.chdir(CWD)
  setOriginalCwd(CWD)

  // 1. New writes go to the v2 name
  const v2Dir = getProjectDir(CWD)
  check(
    'write target uses v2 encoding',
    v2Dir ===
      join(
        PROJECTS,
        'E%3a~ClaudeCode~doge-code~test~tmp-e2e-project-dirs~cwd~hyphen-ated~proj-ect',
      ),
    v2Dir,
  )

  // 2. Legacy v1 directory still resolves (only it exists right now)
  const found = await findProjectDir(CWD)
  check(
    'findProjectDir resolves the legacy v1 directory',
    found === join(PROJECTS, legacySanitizePath(CWD)),
    found,
  )

  // 3. fetchLogs (uses getOriginalCwd) lists the legacy session
  const logs = await fetchLogs()
  check(
    'fetchLogs returns the legacy session',
    logs.some(l => l.sessionId === SESSION_ID),
    JSON.stringify(logs.map(l => l.sessionId)),
  )

  // 4. Cross-project resume finds it without a dir hint
  const resolved = await resolveSessionFilePath(SESSION_ID)
  check(
    'resolveSessionFilePath (no dir) finds the legacy file',
    resolved?.filePath === join(PROJECTS, legacySanitizePath(CWD), `${SESSION_ID}.jsonl`),
    resolved?.filePath,
  )

  // 5. Directed resume with the real cwd also finds it
  const directed = await resolveSessionFilePath(SESSION_ID, CWD)
  check(
    'resolveSessionFilePath (dir) finds the legacy file',
    directed?.filePath === join(PROJECTS, legacySanitizePath(CWD), `${SESSION_ID}.jsonl`),
    directed?.filePath,
  )

  // 6. Once a v2 directory appears, it takes preference
  mkdirSync(v2Dir, { recursive: true })
  const foundAfter = await findProjectDir(CWD)
  check(
    'findProjectDir prefers v2 once it exists',
    foundAfter === v2Dir,
    foundAfter,
  )

  process.chdir('E:/ClaudeCode/doge-code')
  rmSync(ROOT, { recursive: true, force: true })
  console.log('done')
}

void main()

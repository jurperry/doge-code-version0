/**
 * E2E: project directory naming (current v2 encoding).
 *
 * Runs the real production functions (getProjectDir / findProjectDir /
 * fetchLogs / resolveSessionFilePath) against a sandboxed CLAUDE_CONFIG_DIR,
 * with the process actually chdir'd into a hyphenated test cwd. Verifies:
 *
 *  1. New writes target the v2-encoded directory name.
 *  2. Listing/resume resolve that directory.
 *  3. The project-dir resolver no longer falls back to v1-encoded directories.
 *
 * Run: bun tools/e2e-project-dirs.ts   (from the doge-code repo root)
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { setOriginalCwd } from '../src/bootstrap/state.js'
import {
  findProjectDir,
  getProjectDir,
  resolveSessionFilePath,
  sanitizePath,
} from '../src/utils/sessionStoragePortable.js'
import { fetchLogs } from '../src/utils/sessionStorage.js'

const ORIGINAL_CWD = process.cwd()
const ROOT = resolve(join(import.meta.dir, 'tmp-e2e-project-dirs'))
const CONFIG = join(ROOT, 'config')
const PROJECTS = join(CONFIG, 'projects')

// A real cwd whose folder names contain hyphens.
const CWD = join(ROOT, 'cwd', 'hyphen-ated', 'proj-ect')
const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const LEGACY_SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

function writeSession(dir: string, sessionId: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello from the current era' },
      cwd: CWD,
      sessionId,
      timestamp: new Date().toISOString(),
    }) + '\n',
  )
}

function setup(): void {
  rmSync(ROOT, { recursive: true, force: true })
  process.env.CLAUDE_CONFIG_DIR = CONFIG
  mkdirSync(CWD, { recursive: true })
  writeSession(join(PROJECTS, sanitizePath(CWD)), SESSION_ID)
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

  try {
    // 1. New writes go to the v2 name
    const v2Dir = getProjectDir(CWD)
    check(
      'write target uses v2 encoding',
      v2Dir === join(PROJECTS, sanitizePath(CWD)),
      v2Dir,
    )

    // 2. findProjectDir resolves the v2 directory
    const found = await findProjectDir(CWD)
    check('findProjectDir resolves the v2 directory', found === v2Dir, found)

    // 3. fetchLogs (uses getOriginalCwd) lists the session
    const logs = await fetchLogs()
    check(
      'fetchLogs returns the session',
      logs.some(l => l.sessionId === SESSION_ID),
      JSON.stringify(logs.map(l => l.sessionId)),
    )

    // 4. Cross-project resume finds it without a dir hint
    const resolved = await resolveSessionFilePath(SESSION_ID)
    check(
      'resolveSessionFilePath (no dir) finds the file',
      resolved?.filePath === join(v2Dir, `${SESSION_ID}.jsonl`),
      resolved?.filePath,
    )

    // 5. Directed resume with the real cwd also finds it
    const directed = await resolveSessionFilePath(SESSION_ID, CWD)
    check(
      'resolveSessionFilePath (dir) finds the file',
      directed?.filePath === join(v2Dir, `${SESSION_ID}.jsonl`),
      directed?.filePath,
    )

    // 6. v1-named directories are not used by the project-dir resolver
    const legacyName = CWD.replace(/[^a-zA-Z0-9]/g, '-')
    writeSession(join(PROJECTS, legacyName), LEGACY_SESSION_ID)
    rmSync(v2Dir, { recursive: true, force: true })
    check(
      'findProjectDir does not fall back to v1 directories',
      (await findProjectDir(CWD)) === undefined,
    )
    const logsAfterRemoval = await fetchLogs()
    check(
      'fetchLogs ignores v1-only project dirs',
      !logsAfterRemoval.some(l => l.sessionId === LEGACY_SESSION_ID),
      JSON.stringify(logsAfterRemoval.map(l => l.sessionId)),
    )
    const directedLegacy = await resolveSessionFilePath(LEGACY_SESSION_ID, CWD)
    check(
      'directed resolve ignores v1-only project dirs',
      directedLegacy === undefined,
      directedLegacy?.filePath,
    )
  } finally {
    process.chdir(ORIGINAL_CWD)
    rmSync(ROOT, { recursive: true, force: true })
  }
  console.log('done')
}
void main()

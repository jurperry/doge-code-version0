import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Sandbox the config dir BEFORE importing the settings chain: getInitialSettings()
// reads <CLAUDE_CONFIG_DIR>/settings.json (session-cached, invalidated via
// resetSettingsCache) — tests must never touch the real ~/.doge. Fixed path
// rebuilt at load (see useMainLoopModel.test.ts for why not mkdtemp); also
// re-pinned in beforeEach since bun test shares one process across files.
const TMP_CONFIG_DIR = join(tmpdir(), 'doge-session-shell-test-sandbox')
rmSync(TMP_CONFIG_DIR, { recursive: true, force: true })
mkdirSync(TMP_CONFIG_DIR, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR

const { resolveDefaultShell } = await import('./resolveDefaultShell.js')
const {
  getSessionShell,
  initSessionShellSnapshot,
  resetSessionShellForTests,
  setSessionShell,
} = await import('./sessionShell.js')
const { resetSettingsCache } = await import('../settings/settingsCache.js')
const { updateSettingsForSource } = await import('../settings/settings.js')
const { isPowerShellToolEnabled } = await import('./shellToolUtils.js')
const { getPlatform } = await import('../platform.js')

const savedPsToolEnv = process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL
const savedUserType = process.env.USER_TYPE

function writeUserSettings(settings: Record<string, unknown>): void {
  writeFileSync(
    join(TMP_CONFIG_DIR, 'settings.json'),
    JSON.stringify(settings),
    'utf8',
  )
  resetSettingsCache()
}

function readUserSettings(): Record<string, unknown> {
  try {
    return JSON.parse(
      readFileSync(join(TMP_CONFIG_DIR, 'settings.json'), 'utf8'),
    )
  } catch {
    return {}
  }
}

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR
  resetSessionShellForTests()
  rmSync(join(TMP_CONFIG_DIR, 'settings.json'), { force: true })
  resetSettingsCache()
})

afterEach(() => {
  if (savedPsToolEnv === undefined)
    delete process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL
  else process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL = savedPsToolEnv
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
})

describe('resolveDefaultShell three-tier resolution', () => {
  test("settings tier applies when no session override; 'bash' default when neither", () => {
    expect(getSessionShell()).toBe(null)
    expect(resolveDefaultShell()).toBe('bash')
    writeUserSettings({ defaultShell: 'powershell' })
    expect(resolveDefaultShell()).toBe('powershell')
  })

  test('session tier wins over settings', () => {
    writeUserSettings({ defaultShell: 'powershell' })
    setSessionShell('bash')
    expect(resolveDefaultShell()).toBe('bash')
    setSessionShell('powershell')
    expect(resolveDefaultShell()).toBe('powershell')
  })
})

describe('initSessionShellSnapshot', () => {
  test('freezes the disk-effective value at snapshot time', () => {
    expect(resolveDefaultShell()).toBe('bash') // no snapshot yet → live settings
    writeUserSettings({ defaultShell: 'powershell' })
    initSessionShellSnapshot()
    expect(getSessionShell()).toBe('powershell')
    expect(resolveDefaultShell()).toBe('powershell')
  })

  test('first call wins: later disk change + re-init does not move the session', () => {
    initSessionShellSnapshot() // empty disk → bash
    writeUserSettings({ defaultShell: 'powershell' })
    initSessionShellSnapshot() // idempotent no-op
    expect(resolveDefaultShell()).toBe('bash')
  })
})

describe('session isolation', () => {
  test('disk settings.json change does not retarget a running session', () => {
    initSessionShellSnapshot() // bash
    expect(resolveDefaultShell()).toBe('bash')
    // Another session runs /shell pwsh → disk flips
    writeUserSettings({ defaultShell: 'powershell' })
    expect(resolveDefaultShell()).toBe('bash') // this session stays put
    // A fresh process (no snapshot yet) picks up the new disk value
    resetSessionShellForTests()
    expect(resolveDefaultShell()).toBe('powershell')
  })
})

// /shell's applyShellSelection is not imported here (it lives in a .tsx Ink
// module with no test-import precedent in this repo) — this exercises exactly
// its two core calls, in order, against the sandboxed settings store.
describe('/shell sets the session override (applyShellSelection seam)', () => {
  test('persists userSettings AND switches this session immediately', () => {
    initSessionShellSnapshot() // bash on empty disk
    const result = updateSettingsForSource('userSettings', {
      defaultShell: 'powershell',
    })
    expect(result.error).toBe(null)
    setSessionShell('powershell')
    expect(resolveDefaultShell()).toBe('powershell') // session moved now
    expect(readUserSettings().defaultShell).toBe('powershell') // disk moved too
    // Later external disk edits still don't retarget this session
    writeUserSettings({ defaultShell: 'bash' })
    expect(resolveDefaultShell()).toBe('powershell')
  })
})

describe('gate composition with the session shell', () => {
  test('session powershell opens the PowerShellTool gate on Windows only', () => {
    delete process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL
    delete process.env.USER_TYPE
    setSessionShell('powershell')
    // isPowerShellToolEnabled() feeds resolveDefaultShell() into the gate;
    // defaultShell === 'powershell' opts in unconditionally on win32.
    expect(isPowerShellToolEnabled()).toBe(getPlatform() === 'windows')
  })

  test('session bash without env opt-in keeps the gate closed', () => {
    delete process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL
    delete process.env.USER_TYPE
    setSessionShell('bash')
    expect(isPowerShellToolEnabled()).toBe(false)
  })
})

// Throwaway e2e verification for AGENTS.md fallback loading (deleted after use).
// Drives the real getMemoryFiles() walk by chdir'ing into fixture projects
// before the dynamic import (bootstrap state captures cwd at import time).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import process from 'process'

const SCRATCH = mkdtempSync(join(tmpdir(), 'doge-agents-e2e-'))
const CONFIG = join(SCRATCH, 'config')
const PROJECT = join(SCRATCH, 'project')
mkdirSync(CONFIG, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = CONFIG
process.chdir(PROJECT)

const { enableConfigs } = await import('../src/utils/config.js')
enableConfigs()

const { getMemoryFiles, getClaudeMds, clearMemoryFileCaches } = await import(
  '../src/utils/claudemd.js'
)

function loadedPaths(files: { path: string; type: string }[]): string[] {
  return files.map(f => f.path)
}

// Case 1: AGENTS.md only → should be loaded as Project memory
writeFileSync(join(PROJECT, 'AGENTS.md'), 'Fixture agents instructions\n')
clearMemoryFileCaches()
let files = await getMemoryFiles()
let paths = loadedPaths(files)
console.log('[case1] AGENTS.md only:', paths)
if (!paths.includes(join(PROJECT, 'AGENTS.md'))) throw new Error('case1 FAIL')

// Case 2: add CLAUDE.md → CLAUDE.md wins, AGENTS.md no longer loaded
writeFileSync(join(PROJECT, 'CLAUDE.md'), 'Fixture claude instructions\n')
clearMemoryFileCaches()
files = await getMemoryFiles()
paths = loadedPaths(files)
console.log('[case2] both present:', paths)
if (!paths.includes(join(PROJECT, 'CLAUDE.md'))) throw new Error('case2 FAIL')
if (paths.includes(join(PROJECT, 'AGENTS.md'))) throw new Error('case2 FAIL')

// Case 3: remove CLAUDE.md → falls back to AGENTS.md again; getClaudeMds renders it
rmSync(join(PROJECT, 'CLAUDE.md'))
clearMemoryFileCaches()
files = await getMemoryFiles()
const rendered = getClaudeMds(files)
console.log('[case3] rendered context contains AGENTS.md:', rendered.includes('Fixture agents instructions'))
if (!rendered.includes(join(PROJECT, 'AGENTS.md'))) throw new Error('case3 FAIL')
if (!rendered.includes('project instructions, checked into the codebase')) {
  throw new Error('case3 FAIL (description)')
}

// Windows can't delete the dir holding process.cwd() — chdir out first
process.chdir('E:/ClaudeCode/doge-code')
rmSync(SCRATCH, { recursive: true, force: true })
console.log('ALL E2E CASES PASS')

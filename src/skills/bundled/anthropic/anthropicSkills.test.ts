// Tests for the vendored Anthropic bundled skills.
//
// Run standalone (it pins CLAUDE_CODE_TMPDIR + MACRO for this process):
//   bun test src/skills/bundled/anthropic/
//
// The extraction sandbox lives under test/ (never the system temp drive) and
// is removed in afterAll per the repo's C-drive/test-artifact discipline.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'

import {
  clearBundledSkills,
  getBundledSkillExtractDir,
  getBundledSkills,
  registerBundledSkill,
} from '../../bundledSkills.js'
import { initAnthropicSkills } from './index.js'
import { ANTHROPIC_SKILL_MANIFEST } from './manifest.js'
import { parseFrontmatter } from '../../../utils/frontmatterParser.js'

const VENDOR_ROOT = import.meta.dir
const SANDBOX = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'test',
  'tmp',
  'builtin-skills-test',
)

// Must land before the first getBundledSkillsRoot() call — it memoizes the
// temp root, and MACRO.VERSION is part of the extraction path.
process.env.CLAUDE_CODE_TMPDIR = SANDBOX
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: 'test',
  BUILD_TIME: '',
  PACKAGE_URL: 'test',
  NATIVE_PACKAGE_URL: 'test',
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER: '',
  FEEDBACK_CHANNEL: 'test',
}

function listFilesRecursive(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(dir, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(join(dir, rel)).isDirectory()) {
      out.push(...listFilesRecursive(dir, rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

describe('vendored anthropic bundled skills', () => {
  beforeAll(() => {
    mkdirSync(SANDBOX, { recursive: true })
  })

  afterAll(() => {
    rmSync(SANDBOX, { recursive: true, force: true })
  })

  test('manifest covers every vendored skill directory', () => {
    const diskSkillDirs = readdirSync(VENDOR_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
    expect(diskSkillDirs).toHaveLength(18)
    expect(ANTHROPIC_SKILL_MANIFEST.map(e => e.name).sort()).toEqual(
      diskSkillDirs,
    )
  })

  test('each content module matches the vendored directory on disk', async () => {
    for (const entry of ANTHROPIC_SKILL_MANIFEST) {
      const mod = await entry.load()
      const diskFiles = listFilesRecursive(
        join(VENDOR_ROOT, entry.name),
      ).filter(rel => rel !== 'SKILL.md')

      expect(Object.keys(mod.FILES).sort()).toEqual(diskFiles.sort())

      // Frontmatter-derived registration metadata stays in sync.
      const { frontmatter } = parseFrontmatter(mod.SKILL_MD)
      expect(frontmatter.name).toBe(entry.name)
      expect(entry.description.length).toBeGreaterThan(0)
      if (typeof frontmatter.description === 'string') {
        expect(entry.description).toBe(frontmatter.description)
      }
    }
  })

  test('initAnthropicSkills registers all vendored skills', () => {
    clearBundledSkills()
    initAnthropicSkills()

    const skills = getBundledSkills()
    expect(skills).toHaveLength(18)
    for (const entry of ANTHROPIC_SKILL_MANIFEST) {
      const skill = skills.find(s => s.name === entry.name)
      expect(skill).toBeDefined()
      expect(skill!.description).toBe(entry.description)
      expect(skill!.source).toBe('bundled')
      expect(skill!.userInvocable).not.toBe(false)
      expect(skill!.skillRoot).toBe(getBundledSkillExtractDir(entry.name))
    }
  })

  test('skips names already registered (claude-api precedence)', () => {
    clearBundledSkills()
    registerBundledSkill({
      name: 'claude-api',
      description: 'custom feature-gated claude-api',
      async getPromptForCommand() {
        return [{ type: 'text', text: 'custom' }]
      },
    })
    initAnthropicSkills()

    const skills = getBundledSkills()
    expect(skills.filter(s => s.name === 'claude-api')).toHaveLength(1)
    expect(skills.find(s => s.name === 'claude-api')!.description).toBe(
      'custom feature-gated claude-api',
    )
    expect(skills).toHaveLength(18)
  })

  test('docx invocation extracts text files and prefixes base dir', async () => {
    clearBundledSkills()
    initAnthropicSkills()
    const cmd = getBundledSkills().find(c => c.name === 'docx')!
    const blocks = await cmd.getPromptForCommand!('quarterly report', {} as never)

    expect(blocks[0]!.type).toBe('text')
    const text = (blocks[0] as { text: string }).text
    expect(text.startsWith('Base directory for this skill: ')).toBe(true)
    expect(text).toContain('## User Request\n\nquarterly report')
    // Body must be raw markdown (Bun's default .md loader would emit <h1>)
    // with frontmatter stripped.
    expect(text).toContain('# DOCX creation, editing, and analysis')
    expect(text).not.toContain('<h1>')

    const extractDir = getBundledSkillExtractDir('docx')
    const validatePy = join(extractDir, 'scripts', 'office', 'validate.py')
    expect(statSync(validatePy).isFile()).toBe(true)
  })

  test('canvas-design invocation extracts binary fonts byte-exact', async () => {
    clearBundledSkills()
    initAnthropicSkills()
    const cmd = getBundledSkills().find(c => c.name === 'canvas-design')!
    const blocks = await cmd.getPromptForCommand!('', {} as never)
    expect((blocks[0] as { text: string }).text).toContain(
      'Base directory for this skill: ',
    )

    const entry = ANTHROPIC_SKILL_MANIFEST.find(
      e => e.name === 'canvas-design',
    )!
    const mod = await entry.load()
    const fontKey = Object.keys(mod.FILES).find(k => k.endsWith('.ttf'))!
    const extracted = join(getBundledSkillExtractDir('canvas-design'), fontKey)
    expect(statSync(extracted).size).toBeGreaterThan(0)
    expect(
      Buffer.compare(await readFile(extracted), await readFile(join(VENDOR_ROOT, 'canvas-design', fontKey))),
    ).toBe(0)
  })

  test('theme-factory ships its referenced showcase PDF', async () => {
    clearBundledSkills()
    initAnthropicSkills()
    const cmd = getBundledSkills().find(c => c.name === 'theme-factory')!
    await cmd.getPromptForCommand!('', {} as never)
    const pdf = join(
      getBundledSkillExtractDir('theme-factory'),
      'theme-showcase.pdf',
    )
    expect(statSync(pdf).size).toBe(124310)
  })
})

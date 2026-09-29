import { join } from 'path'
import { describe, expect, test } from 'bun:test'

const { checkPathSafetyForAutoEdit, isConfigFolderSessionEditRule } =
  await import('./filesystem.js')

const PROJ = join('E:', 'proj')

describe('checkPathSafetyForAutoEdit — dangerous directory coverage', () => {
  test('blocks .git (existing behavior)', () => {
    const result = checkPathSafetyForAutoEdit(join(PROJ, '.git', 'config'))
    expect(result.safe).toBe(false)
  })

  test('blocks config files under .doge (fork config dir, was unprotected)', () => {
    const result = checkPathSafetyForAutoEdit(
      join(PROJ, '.doge', 'settings.json'),
    )
    expect(result.safe).toBe(false)
  })

  test('blocks hooks under .doge', () => {
    const result = checkPathSafetyForAutoEdit(
      join(PROJ, '.doge', 'hooks', 'hook.sh'),
    )
    expect(result.safe).toBe(false)
  })

  test('allows project sources inside .doge/worktrees/<slug> (worktree dev)', () => {
    const result = checkPathSafetyForAutoEdit(
      join(PROJ, '.doge', 'worktrees', 'my-feature', 'src', 'foo.ts'),
    )
    expect(result.safe).toBe(true)
  })

  test('nested .doge inside a worktree is still blocked', () => {
    const result = checkPathSafetyForAutoEdit(
      join(
        PROJ,
        '.doge',
        'worktrees',
        'my-feature',
        '.doge',
        'settings.json',
      ),
    )
    expect(result.safe).toBe(false)
  })

  test('blocks the official .claude directory (no fork writes there)', () => {
    const result = checkPathSafetyForAutoEdit(
      join(PROJ, '.claude', 'settings.json'),
    )
    expect(result.safe).toBe(false)
  })

  test('ordinary project files stay editable', () => {
    const result = checkPathSafetyForAutoEdit(join(PROJ, 'src', 'foo.ts'))
    expect(result.safe).toBe(true)
  })
})

describe('isConfigFolderSessionEditRule — step 1.6 scoped-rule gate', () => {
  // .doge/.claude are dangerous directories, so editing a skill file hits the
  // safety check; getClaudeSkillScope suggests a narrowed session rule like
  // '/.doge/skills/<name>/**'. Step 1.6 honors that rule family via this
  // gate, or the suggestion dead-loops (suggested → still blocked → again).
  test('accepts project and global .claude/.doge scoped rules', () => {
    expect(isConfigFolderSessionEditRule('/.claude/**')).toBe(true)
    expect(isConfigFolderSessionEditRule('/.claude/skills/my-skill/**')).toBe(true)
    expect(isConfigFolderSessionEditRule('~/.claude/**')).toBe(true)
    expect(isConfigFolderSessionEditRule('~/.claude/skills/my-skill/**')).toBe(true)
    expect(isConfigFolderSessionEditRule('/.doge/**')).toBe(true)
    expect(isConfigFolderSessionEditRule('/.doge/skills/my-skill/**')).toBe(true)
    expect(isConfigFolderSessionEditRule('~/.doge/**')).toBe(true)
    expect(isConfigFolderSessionEditRule('~/.doge/skills/my-skill/**')).toBe(true)
  })

  test('rejects other prefixes, traversal, and non-wildcard rules', () => {
    expect(isConfigFolderSessionEditRule('/src/**')).toBe(false)
    expect(isConfigFolderSessionEditRule('~/.ssh/**')).toBe(false)
    expect(isConfigFolderSessionEditRule('/.doge/skills/../**')).toBe(false)
    expect(isConfigFolderSessionEditRule('/.doge/settings.json')).toBe(false)
    expect(isConfigFolderSessionEditRule('')).toBe(false)
  })
})

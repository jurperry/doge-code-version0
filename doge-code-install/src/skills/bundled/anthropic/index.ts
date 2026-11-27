import { parseFrontmatter } from '../../../utils/frontmatterParser.js'
import {
  getBundledSkills,
  registerBundledSkill,
} from '../../bundledSkills.js'
import { ANTHROPIC_SKILL_MANIFEST } from './manifest.js'

/**
 * Register the vendored Anthropic skill set (docx/pdf/pptx/xlsx/
 * canvas-design/...) plus the homemade `python` skill as bundled skills.
 *
 * Registration is pure in-memory: name/description come from the generated
 * manifest, and each skill's content module (SKILL.md body + reference
 * files, ~10MB total) is dynamically imported only on first invocation.
 *
 * Called last from initBundledSkills() and skips names already registered —
 * the feature-gated custom claude-api skill (claudeApi.ts) takes precedence
 * in builds where its feature flag is on, while source runs (feature()
 * always false) get this vendored generic version instead.
 */
export function initAnthropicSkills(): void {
  const registered = new Set(getBundledSkills().map(skill => skill.name))

  for (const entry of ANTHROPIC_SKILL_MANIFEST) {
    if (registered.has(entry.name)) continue

    registerBundledSkill({
      name: entry.name,
      description: entry.description,
      userInvocable: true,
      files: async () => (await entry.load()).FILES,
      async getPromptForCommand(args) {
        const { SKILL_MD } = await entry.load()
        const { content } = parseFrontmatter(SKILL_MD)
        const parts = [content.trimStart()]
        if (args) {
          parts.push(`## User Request\n\n${args}`)
        }
        return [{ type: 'text', text: parts.join('\n\n') }]
      },
    })
  }
}

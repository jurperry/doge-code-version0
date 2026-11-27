import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'provider',
  description: 'Add, edit, or remove API providers (base URL, API key, models)',
  argumentHint: '[add|remove|list]',
  load: () => import('./provider.tsx'),
} satisfies Command

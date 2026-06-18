import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'remove-model',
  description: 'Remove a custom model from the saved model list',
  argumentHint: '[model]',
  load: () => import('./remove-model.tsx'),
} satisfies Command

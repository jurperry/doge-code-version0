import type { Command } from '../../commands.js'

const auto = {
  type: 'local-jsx',
  name: 'auto',
  description: 'Toggle auto mode (run all tools without permission prompts)',
  argumentHint: '[on|off]',
  immediate: true,
  load: () => import('./auto.js'),
} satisfies Command

export default auto

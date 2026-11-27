import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'shell',
  description: 'Select the command interpreter (Bash or Pwsh)',
  argumentHint: '[bash|pwsh|status]',
  load: () => import('./shell.js'),
} satisfies Command

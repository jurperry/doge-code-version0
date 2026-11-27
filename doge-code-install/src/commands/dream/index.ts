import type { Command } from '../../types/command.js'

const dream: Command = {
  type: 'local',
  name: 'dream',
  description: '立即整理当前项目的跨会话记忆',
  supportsNonInteractive: true,
  load: () => import('./dream.js'),
}

export default dream

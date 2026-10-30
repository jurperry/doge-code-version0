import { homedir } from 'os'
import { join } from 'path'

export function getDogeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.doge')
}

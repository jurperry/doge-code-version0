/** App 专用目录通知。stderr 不污染 stream-json；外部 CLI 默认完全静默。 */
import { writeSync } from 'node:fs'

export function emitShellWorkspaceMarker(cwd: string, sessionId: string): void {
  if (process.env.DOGE_APP_WORKSPACE_MARKER !== '1') return
  try {
    const payload = Buffer.from(JSON.stringify({ pid: process.pid, cwd, sessionId }), 'utf8').toString('base64')
    // Ink 可接管 stderr.write 并过滤不可见控制字；直写 fd 同时适配 PTY 与管道。
    writeSync(process.stderr.fd, `\x1b]7771;workspace:${payload}\x07`)
  } catch {
    // Parent/stdio may already be closed; notification cannot block CLI state.
  }
}

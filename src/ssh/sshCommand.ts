import { existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

export type SSHHostOptions = {
  host: string
  cwd?: string
  identityFile?: string
  remoteCliPath?: string
  port?: number
}

/** 本机 ssh 可执行文件：显式覆盖 > 随包 OpenSSH（Windows）> PATH。 */
export function sshExecutable(): string {
  if (process.env.DOGE_SSH_EXECUTABLE) return process.env.DOGE_SSH_EXECUTABLE
  if (process.platform === 'win32') {
    const bundled = join(dirname(process.execPath), 'openssh', 'ssh.exe')
    if (existsSync(bundled)) return bundled
  }
  return 'ssh'
}

/** `~` 开头的本机私钥路径展开为绝对路径。 */
export function identityPath(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : resolve(value)
}

export type SSHProbeResult = {
  ok: boolean
  host: string
  reason?: 'connection_failed' | 'cli_not_found' | 'cli_unusable' | 'cwd_not_found' | 'invalid_response'
  message: string
  details?: string
  remoteCwd?: string
  cliPath?: string
  version?: string
  installCommand: string
}

export const DOGE_SSH_INSTALL_COMMAND = 'git clone <repo-url> doge-code && cd doge-code && bun install && bun link'

export function validateSSHHost(host: string): string {
  const value = host.trim()
  if (!value || value.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('SSH 地址无效，请输入 user@host 或 ~/.ssh/config 中的别名')
  }
  return value
}

export function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function sshRemoteCommand(script: string): string[] {
  return ['sh', '-c', posixQuote(script)]
}

const remotePathPrelude = 'PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"\nexport PATH'

function remotePath(value: string): string {
  return value.startsWith('~/') ? `"$HOME"/${posixQuote(value.slice(2))}` : posixQuote(value)
}

export function sshHostArgs(options: Pick<SSHHostOptions, 'host' | 'identityFile' | 'port'>): string[] {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ]
  if (options.port !== undefined) args.push('-p', String(options.port))
  if (options.identityFile) args.push('-i', options.identityFile, '-o', 'IdentitiesOnly=yes')
  return args
}

export function remoteProbeScript(options: SSHHostOptions): string {
  const configured = options.remoteCliPath?.trim() ?? ''
  const cwd = options.cwd ?? ''
  return `${remotePathPrelude}
DOGE_SSH_CLI=${configured ? remotePath(configured) : "''"}
DOGE_SSH_RESOLVED=''
if [ -n "$DOGE_SSH_CLI" ]; then
  if [ -x "$DOGE_SSH_CLI" ]; then
    DOGE_SSH_RESOLVED=$DOGE_SSH_CLI
  else
    DOGE_SSH_RESOLVED=$(command -v "$DOGE_SSH_CLI" 2>/dev/null) || DOGE_SSH_RESOLVED=''
  fi
else
  for DOGE_SSH_CANDIDATE in doge "$HOME/.bun/bin/doge" "$HOME/.doge/bin/doge" "$HOME/.local/bin/doge"; do
    if [ -x "$DOGE_SSH_CANDIDATE" ]; then
      DOGE_SSH_RESOLVED=$DOGE_SSH_CANDIDATE
    else
      DOGE_SSH_RESOLVED=$(command -v "$DOGE_SSH_CANDIDATE" 2>/dev/null) || DOGE_SSH_RESOLVED=''
    fi
    if [ -n "$DOGE_SSH_RESOLVED" ]; then break; fi
  done
fi
if [ -z "$DOGE_SSH_RESOLVED" ]; then
  printf '%s\n' 'DOGE_SSH_ERROR=cli_not_found'
  exit 42
fi
DOGE_SSH_CLI=$DOGE_SSH_RESOLVED
DOGE_SSH_VERSION=$("$DOGE_SSH_CLI" --version 2>&1)
if [ $? -ne 0 ]; then
  printf '%s\n' 'DOGE_SSH_ERROR=cli_unusable'
  printf 'DOGE_SSH_DETAIL=%s\n' "$DOGE_SSH_VERSION"
  exit 43
fi
${cwd ? `DOGE_SSH_CWD=${remotePath(cwd)}\nif ! cd "$DOGE_SSH_CWD"; then\n  printf '%s\\n' 'DOGE_SSH_ERROR=cwd_not_found'\n  exit 44\nfi` : ''}
printf '%s\n' 'DOGE_SSH_PROBE=1'
printf 'DOGE_SSH_CWD=%s\n' "$(pwd)"
printf 'DOGE_SSH_CLI=%s\n' "$DOGE_SSH_CLI"
printf 'DOGE_SSH_VERSION=%s\n' "$DOGE_SSH_VERSION"`
}

export function remoteSessionScript(options: {
  cliPath: string
  cwd: string
  socketPath: string
  env: Record<string, string>
  args: string[]
}): string {
  const exports = Object.entries(options.env).map(([key, value]) => `${key}=${posixQuote(value)}`)
  return `${remotePathPrelude}
cd ${posixQuote(options.cwd)} || exit 45
trap 'rm -f ${posixQuote(options.socketPath)}' EXIT HUP INT TERM
env ${[...exports, posixQuote(options.cliPath), ...options.args.map(posixQuote)].join(' ')}`
}

/**
 * 由本机决定并同步到远端的模型与行为变量。密钥、端点和本机路径不在其中：
 * 远端的认证恒走隧道占位符，请求回到本机代理后再附加真实凭据。
 */
export const SSH_FORWARDED_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_MODEL_CONTEXT_WINDOW',
  'CLAUDE_CODE_COMPATIBLE_API_PROVIDER',
  'DOGE_ACTIVE_MODEL_PROFILE',
  'DOGE_ACTIVE_CONNECTION_ID',
  'DOGE_ACTIVE_MODEL_ID',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_DISABLE_EFFORT',
  'DOGE_HOST_EFFORT_DEFAULT',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
] as const

/** includeMissing 把白名单内本机未设置的变量以空串下发，远端据此删除旧值。 */
export function remoteModelEnvironment(
  env: Record<string, string | undefined>,
  includeMissing = false,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of SSH_FORWARDED_ENV_KEYS) {
    const value = env[key]
    if (value) result[key] = value
    else if (includeMissing) result[key] = ''
  }
  return result
}

/** 隧道凭据：initialize 应答后才经控制通道下发，不进入 argv 或远端启动环境。 */
export function tunnelCredentialEnvironment(token: string): Record<string, string> {
  return {
    DOGE_SSH_PROXY_TOKEN: token,
    ANTHROPIC_CUSTOM_HEADERS: `x-doge-ssh-proxy: ${token}`,
  }
}

/** 文件通道在远端常驻的 POSIX sh 循环：逐行读指令，按帧回写（见 sshFileService）。 */
export function remoteFileServiceScript(): string {
  return `${remotePathPrelude}
if [ "$(printf aGk= | base64 -d 2>/dev/null)" = "hi" ]; then B64D='base64 -d'; else B64D='base64 -D'; fi
if stat -c %Y . >/dev/null 2>&1; then
  mtime() { stat -c %Y -- "$1" 2>/dev/null || printf '0\\n'; }
else
  mtime() { stat -f %m "$1" 2>/dev/null || printf '0\\n'; }
fi
fail() { printf '@err\\n@end\\n'; }
bytes() { if [ -r "$1" ]; then wc -c < "$1" | tr -d ' \\t'; else printf '0'; fi; }
# 问候帧：调用方据此认定 SSH 已连通且循环已就绪（连接失败时走不到这里）
printf '@ready\\n'
while IFS= read -r line; do
  [ -n "$line" ] || continue
  op=\${line%% *}
  arg=\${line#* }
  [ "$op" = "$line" ] && arg=''
  case "$op" in
    H) printf '@ok\\n%s\\n%s\\n@end\\n' "$HOME" "\${CLAUDE_CONFIG_DIR:-\$HOME/.doge}" ;;
    S)
      p=$(printf '%s' "$arg" | $B64D) || { fail; continue; }
      if [ -d "$p" ]; then printf '@ok\\ndir\\n@end\\n'
      elif [ -f "$p" ]; then printf '@ok\\nfile %s %s\\n@end\\n' "$(bytes "$p")" "$(mtime "$p")"
      else fail; fi ;;
    L)
      p=$(printf '%s' "$arg" | $B64D) || { fail; continue; }
      [ -d "$p" ] || { fail; continue; }
      printf '@ok\\n'
      for e in "$p"/* "$p"/.[!.]* "$p"/..?*; do
        [ -e "$e" ] || [ -L "$e" ] || continue
        if [ -d "$e" ]; then printf 'd\\t0\\t0\\t%s\\n' "\${e##*/}"
        else printf 'f\\t%s\\t%s\\t%s\\n' "$(bytes "$e")" "$(mtime "$e")" "\${e##*/}"; fi
      done
      printf '@end\\n' ;;
    R)
      spec=\${arg#* }
      off=\${spec%% *}
      lim=\${spec#* }
      case "$off$lim" in *[!0-9]*) fail; continue ;; esac
      p=$(printf '%s' "\${arg%% *}" | $B64D) || { fail; continue; }
      [ -f "$p" ] || { fail; continue; }
      printf '@ok %s\\n' "$(bytes "$p")"
      tail -c "+$((off + 1))" -- "$p" 2>/dev/null | head -c "$lim" | base64 | tr -d '\\n'
      printf '\\n@end\\n' ;;
    *) fail ;;
  esac
done`
}

export function parseSSHProbeOutput(host: string, stdout: string, stderr: string, exitCode: number | null): SSHProbeResult {
  const output = `${stdout}\n${stderr}`
  const details = output.trim()
  const value = (key: string): string | undefined => {
    const match = stdout.match(new RegExp(`^${key}=(.*)$`, 'm'))
    return match?.[1]
  }
  const base = { host, details: details || undefined, installCommand: DOGE_SSH_INSTALL_COMMAND }
  const error = value('DOGE_SSH_ERROR')
  if (error === 'cli_not_found' || error === 'cli_unusable' || error === 'cwd_not_found') {
    const message = error === 'cli_not_found'
      ? 'Doge Code CLI 未安装或不在 PATH 中'
      : error === 'cli_unusable'
        ? 'Doge Code CLI 无法执行'
        : '远程工作目录不存在或不可进入'
    return { ...base, ok: false, reason: error, message }
  }
  if (value('DOGE_SSH_PROBE') === '1') {
    const remoteCwd = value('DOGE_SSH_CWD')
    const cliPath = value('DOGE_SSH_CLI')
    const version = value('DOGE_SSH_VERSION')
    if (remoteCwd && cliPath && version) {
      return { ...base, ok: true, message: `已连接 · ${version}`, remoteCwd, cliPath, version }
    }
  }
  return {
    ...base,
    ok: false,
    reason: exitCode === 0 ? 'invalid_response' : 'connection_failed',
    message: exitCode === 0 ? '远端返回了无法识别的探测结果' : 'SSH 连接失败，请检查地址、网络和密钥',
  }
}

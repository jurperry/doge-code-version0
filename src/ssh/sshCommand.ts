export type SSHHostOptions = {
  host: string
  cwd?: string
  identityFile?: string
  remoteCliPath?: string
  port?: number
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
  const cwd = options.cwd?.trim() ?? ''
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

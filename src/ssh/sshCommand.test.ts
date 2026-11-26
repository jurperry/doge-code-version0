import { describe, expect, test } from 'bun:test'
import { parse as shellQuoteParse } from 'shell-quote'
import {
  parseSSHProbeOutput,
  posixQuote,
  remoteProbeScript,
  remoteSessionScript,
  sshHostArgs,
  sshRemoteCommand,
  validateSSHHost,
} from './sshCommand.js'

describe('SSH command construction', () => {
  test('validates host input without allowing option injection', () => {
    expect(validateSSHHost(' ubuntu@example.com ')).toBe('ubuntu@example.com')
    expect(() => validateSSHHost('-oProxyCommand=bad')).toThrow()
    expect(() => validateSSHHost('host other')).toThrow()
    expect(() => validateSSHHost('host\nrm -rf /')).toThrow()
  })

  test('quotes POSIX arguments literally', () => {
    expect(posixQuote(`/tmp/a'b; touch /tmp/nope`)).toBe(`'/tmp/a'"'"'b; touch /tmp/nope'`)
    const script = remoteSessionScript({
      cliPath: '/opt/doge bin/doge',
      cwd: '/work/project',
      socketPath: '/tmp/doge.sock',
      env: { DOGE_API_KEY: 'placeholder' },
      args: ['--model', 'model with spaces'],
    })
    expect(script).toContain(`'/opt/doge bin/doge'`)
    expect(script).toContain(`'model with spaces'`)
    expect(script).toContain(`trap 'rm -f '/tmp/doge.sock''`)
  })

  test('adds connection, identity and port options', () => {
    const args = sshHostArgs({ host: 'host', identityFile: '/tmp/id', port: 2222 })
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('StrictHostKeyChecking=accept-new')
    expect(args.slice(-6)).toEqual(['-p', '2222', '-i', '/tmp/id', '-o', 'IdentitiesOnly=yes'])
  })

  test('preserves multiline scripts as one quoted SSH remote command', () => {
    const script = remoteProbeScript({ host: 'host', remoteCliPath: '/opt/doge bin/doge' })
    const command = sshRemoteCommand(script)
    expect(command).toEqual(['sh', '-c', posixQuote(script)])
    expect(command[2]?.startsWith("'PATH=")).toBe(true)
    expect(command[2]?.includes('\n')).toBe(true)
    expect(command[2]?.endsWith("'")).toBe(true)
  })

  test('round trips quotes and operators without creating shell commands', () => {
    const script = remoteSessionScript({
      cliPath: "/opt/doge bin/'; touch /tmp/nope; 'doge",
      cwd: "/work/$(touch /tmp/nope);'project",
      socketPath: '/tmp/doge.sock',
      env: { DOGE_API_KEY: "placeholder'; touch /tmp/nope; #" },
      args: ['--model', "model'; touch /tmp/nope; #"],
    })
    expect(shellQuoteParse(sshRemoteCommand(script).join(' '))).toEqual(['sh', '-c', script])
  })

  test('uses configured remote paths and probes cwd', () => {
    const script = remoteProbeScript({ host: 'host', remoteCliPath: '~/bin/doge', cwd: '~/work' })
    expect(script).toContain('"$HOME"/\'bin/doge\'')
    expect(script).toContain('"$HOME"/\'work\'')
    expect(script).toContain('"$HOME/.bun/bin/doge"')
    expect(script).toContain('DOGE_SSH_ERROR=cwd_not_found')
  })
})

describe('SSH probe parsing', () => {
  test('parses a successful probe', () => {
    const result = parseSSHProbeOutput('host', [
      'DOGE_SSH_PROBE=1',
      'DOGE_SSH_CWD=/home/ubuntu/project',
      'DOGE_SSH_CLI=/home/ubuntu/.doge/bin/doge',
      'DOGE_SSH_VERSION=2.1.359 (Claude Code)',
      '',
    ].join('\n'), '', 0)
    expect(result.ok).toBe(true)
    expect(result.remoteCwd).toBe('/home/ubuntu/project')
    expect(result.cliPath).toBe('/home/ubuntu/.doge/bin/doge')
    expect(result.version).toContain('2.1.359')
  })

  test('distinguishes missing CLI, bad cwd and connection errors', () => {
    expect(parseSSHProbeOutput('host', 'DOGE_SSH_ERROR=cli_not_found\n', '', 42).reason).toBe('cli_not_found')
    expect(parseSSHProbeOutput('host', 'DOGE_SSH_ERROR=cwd_not_found\n', '', 44).reason).toBe('cwd_not_found')
    expect(parseSSHProbeOutput('host', '', 'ssh: connect to host host port 22: Connection refused', 255).reason).toBe('connection_failed')
    expect(parseSSHProbeOutput('host', 'unrecognized', '', 0).reason).toBe('invalid_response')
  })
})

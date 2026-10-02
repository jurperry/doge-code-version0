import { afterEach, describe, expect, test } from 'bun:test'
import { getPlatform } from './platform.js'
import { probeGitBashPath } from './windowsPaths.js'

const ENV_KEY = 'CLAUDE_CODE_GIT_BASH_PATH'
const savedEnv = process.env[ENV_KEY]

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
})

describe('probeGitBashPath', () => {
  test('returns null off Windows', () => {
    if (getPlatform() === 'windows') return
    delete process.env[ENV_KEY]
    expect(probeGitBashPath()).toBeNull()
  })

  test('env override wins when the path exists', () => {
    if (getPlatform() !== 'windows') return
    // process.execPath (bun.exe) definitely exists — stands in for bash.exe.
    process.env[ENV_KEY] = process.execPath
    expect(probeGitBashPath()).toBe(process.execPath)
  })

  test('invalid env override is skipped, never fatal', () => {
    if (getPlatform() !== 'windows') return
    process.env[ENV_KEY] = 'C:\\definitely\\missing\\doge-bash.exe'
    // Must not throw or exit (that's the whole point vs findGitBashPath).
    // Falls through to registry/PATH/well-known dirs, so the result is
    // either a real git-bash on this machine or null — never the bogus path.
    const result = probeGitBashPath()
    expect(result).not.toBe('C:\\definitely\\missing\\doge-bash.exe')
    if (result !== null) {
      expect(result.toLowerCase().endsWith('bash.exe')).toBe(true)
    }
  })
})

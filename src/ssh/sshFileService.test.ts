import { afterAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { delimiter, dirname, join } from 'path'
import { PassThrough } from 'stream'
import {
  FileFrameParser,
  fileServiceCommand,
  parseFileFrame,
  parseFileServiceRequest,
  serveFileChannel,
  type FileServiceRequest,
  type FileServiceResponse,
} from './sshFileService.js'
import { remoteFileServiceScript } from './sshCommand.js'

describe('file service protocol', () => {
  test('requests require an id, an absolute path and bounded numeric ranges', () => {
    expect(parseFileServiceRequest({ id: 1, op: 'home' })).toEqual({ id: 1, op: 'home' })
    expect(parseFileServiceRequest({ id: 2, op: 'list', path: '/home/me/.doge' })).toEqual({ id: 2, op: 'list', path: '/home/me/.doge' })
    expect(parseFileServiceRequest({ id: 3, op: 'read', path: '/a', offset: 10, limit: 5 })).toEqual({ id: 3, op: 'read', path: '/a', offset: 10, limit: 5 })
    expect(parseFileServiceRequest({ id: 4, op: 'read', path: '/a', offset: -1, limit: 5 })).toBeUndefined()
    expect(parseFileServiceRequest({ id: 5, op: 'read', path: '/a', offset: 0, limit: 1e12 })).toEqual({ id: 5, op: 'read', path: '/a', offset: 0, limit: 8 * 1024 * 1024 })
    expect(parseFileServiceRequest({ id: 6, op: 'read', path: 'relative/a', offset: 0, limit: 1 })).toBeUndefined()
    expect(parseFileServiceRequest({ id: 7, op: 'list', path: '/a\u0000b' })).toBeUndefined()
    expect(parseFileServiceRequest({ id: 'x', op: 'home' })).toBeUndefined()
    expect(parseFileServiceRequest({ id: 8, op: 'delete', path: '/a' })).toBeUndefined()
  })

  test('paths travel base64-encoded so shell metacharacters never reach the remote command line', () => {
    const hostile = "/tmp/it's; rm -rf /$(touch nope)"
    const command = fileServiceCommand({ id: 1, op: 'read', path: hostile, offset: 3, limit: 9 })
    expect(command).toBe(`R ${Buffer.from(hostile).toString('base64')} 3 9`)
    expect(command).not.toContain('rm -rf')
    expect(fileServiceCommand({ id: 1, op: 'home' })).toBe('H')
  })

  test('frame parser reassembles frames split across chunks and skips noise outside frames', () => {
    const parser = new FileFrameParser()
    expect(parser.push('@ready\nnoise\n@ok 12\nabc')).toEqual([])
    expect(parser.push('def\n@end\r\n@err\n@end\n')).toEqual([
      { ok: true, extra: '12', lines: ['abcdef'] },
      { ok: false },
    ])
    const read: FileServiceRequest = { id: 1, op: 'read', path: '/a', offset: 0, limit: 10 }
    expect(parseFileFrame(read, { ok: true, extra: '12', lines: ['abcdef'] })).toEqual({ id: 1, ok: true, size: 12, data: 'abcdef' })
    expect(parseFileFrame(read, { ok: false })).toEqual({ id: 1, ok: false, error: '远端无法完成该文件操作' })
    expect(parseFileFrame({ id: 2, op: 'list', path: '/a' }, { ok: true, lines: ['d\t0\t0\tsrc', 'f\t12\t1700000000\ta b', 'garbage'] }))
      .toEqual({ id: 2, ok: true, entries: [
        { name: 'src', dir: true, size: 0, mtimeMs: 0 },
        { name: 'a b', dir: false, size: 12, mtimeMs: 1700000000000 },
      ] })
    expect(parseFileFrame({ id: 3, op: 'stat', path: '/a' }, { ok: true, lines: ['file 12 1700000000'] }))
      .toEqual({ id: 3, ok: true, size: 12, mtimeMs: 1700000000000, dir: false })
    expect(parseFileFrame({ id: 4, op: 'home' }, { ok: true, lines: ['/home/me', '/home/me/.doge'] }))
      .toEqual({ id: 4, ok: true, home: '/home/me', configDir: '/home/me/.doge' })
  })
})

const shell = findPosixShell()

type Answer = FileServiceResponse & { id: number }

/** 真实 POSIX sh 上跑远端循环：协议帧、路径解码与边界条件以实际行为为准。 */
describe.skipIf(!shell)('remote file loop on a real POSIX shell', () => {
  const root = join(import.meta.dirname, '..', '..', 'test', 'ssh-file-service')
  /** Git Bash 的 sh 只认 POSIX 形态路径：E:\\a\\b → /e/a/b（与真实远端一致，请求校验也只放行绝对路径）。 */
  const posix = (path: string): string => process.platform === 'win32'
    ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    : path

  const hostIn = new PassThrough()
  const hostOut = new PassThrough()
  const hostErr = new PassThrough()
  const answers = new Map<number, Answer>()
  const events: string[] = []
  let proc: ChildProcessWithoutNullStreams | undefined
  let exited: Promise<number> | undefined
  let seq = 0

  function collect(): void {
    let pending = ''
    hostOut.setEncoding('utf8')
    hostOut.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line) as Answer & { event?: string }
        if (message.event) events.push(message.event)
        else answers.set(message.id, message)
      }
    })
    hostErr.setEncoding('utf8')
  }

  async function ask(request: { op: string; path?: string; offset?: number; limit?: number }): Promise<Answer> {
    const id = ++seq
    hostIn.write(`${JSON.stringify({ id, ...request })}\n`)
    const deadline = Date.now() + 5000
    while (!answers.has(id)) {
      if (Date.now() > deadline) throw new Error(`No response for ${request.op}`)
      await Bun.sleep(15)
    }
    return answers.get(id)!
  }

  test('answers home, stat, list and ranged reads in order', async () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, "dir with space's"), { recursive: true })
    mkdirSync(join(root, 'empty'), { recursive: true })
    writeFileSync(join(root, 'hello.txt'), 'hello world')
    utimesSync(join(root, 'hello.txt'), 1700000000, 1700000000)
    writeFileSync(join(root, '.hidden'), 'x')
    writeFileSync(join(root, '中文 名.txt'), '你好')
    collect()
    proc = spawn(shell!, ['-c', remoteFileServiceScript()], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Directly invoking Git Bash's sh.exe bypasses its login-shell PATH setup.
      env: {
        ...process.env,
        PATH: [dirname(shell!), process.env.PATH].filter(Boolean).join(delimiter),
      },
    }) as ChildProcessWithoutNullStreams
    exited = serveFileChannel(proc, { stdin: hostIn, stdout: hostOut, stderr: hostErr })
    const deadline = Date.now() + 5000
    while (!events.includes('ready')) {
      if (Date.now() > deadline) throw new Error('Channel never became ready')
      await Bun.sleep(10)
    }

    const home = await ask({ op: 'home' })
    expect(home).toMatchObject({ ok: true })
    expect((home as { home: string }).home.startsWith('/')).toBe(true)
    expect((home as { configDir: string }).configDir.endsWith('/.doge')).toBe(true)

    const file = posix(join(root, 'hello.txt'))
    expect(await ask({ op: 'stat', path: file })).toMatchObject({ ok: true, size: 11, mtimeMs: 1700000000000, dir: false })
    expect(await ask({ op: 'stat', path: posix(root) })).toMatchObject({ ok: true, dir: true })
    expect(await ask({ op: 'stat', path: `${file}.missing` })).toMatchObject({ ok: false })

    const listed = await ask({ op: 'list', path: posix(root) }) as Extract<Answer, { entries: unknown[] }>
    expect(listed.ok).toBe(true)
    const byName = Object.fromEntries(listed.entries.map(entry => [(entry as { name: string }).name, entry]))
    expect(Object.keys(byName).sort()).toEqual(['.hidden', "dir with space's", 'empty', 'hello.txt', '中文 名.txt'].sort())
    expect(byName.empty).toMatchObject({ dir: true })
    expect(byName["dir with space's"]).toMatchObject({ dir: true })
    expect(byName['hello.txt']).toMatchObject({ dir: false, size: 11, mtimeMs: 1700000000000 })
    expect(await ask({ op: 'list', path: `${posix(root)}/missing` })).toMatchObject({ ok: false })

    expect(await ask({ op: 'read', path: file, offset: 0, limit: 5 })).toMatchObject({ ok: true, size: 11, data: Buffer.from('hello').toString('base64') })
    expect(await ask({ op: 'read', path: file, offset: 6, limit: 100 })).toMatchObject({ ok: true, size: 11, data: Buffer.from('world').toString('base64') })
    expect(await ask({ op: 'read', path: file, offset: 11, limit: 10 })).toMatchObject({ ok: true, data: '' })
    expect(await ask({ op: 'read', path: posix(join(root, '中文 名.txt')), offset: 0, limit: 100 }))
      .toMatchObject({ ok: true, data: Buffer.from('你好').toString('base64') })
  })

  test('rejects invalid requests locally and keeps serving after an unknown operation', async () => {
    expect(await ask({ op: 'wipe', path: posix(root) })).toMatchObject({ ok: false, error: '无效的文件通道请求' })
    expect(await ask({ op: 'read', path: posix(join(root, 'hello.txt')), offset: -5, limit: 4 })).toMatchObject({ ok: false, error: '无效的文件通道请求' })
    expect(await ask({ op: 'stat', path: posix(join(root, 'hello.txt')) })).toMatchObject({ ok: true, size: 11 })
  })

  test('closing stdin ends the remote loop and the channel exits cleanly', async () => {
    hostIn.end()
    expect(await exited).toBe(0)
    expect(proc!.exitCode).toBe(0)
    expect(events).toEqual(['ready', 'down'])
  })

  afterAll(() => {
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill()
    rmSync(root, { recursive: true, force: true })
  })
})

function findPosixShell(): string | undefined {
  const candidates = ['sh']
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles ?? 'C:\\Program Files', 'E:\\Git', 'D:\\Git']) {
      candidates.push(join(base, 'Git', 'usr', 'bin', 'sh.exe'), join(base, 'usr', 'bin', 'sh.exe'))
    }
  }
  return candidates.find(candidate => spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0)
}

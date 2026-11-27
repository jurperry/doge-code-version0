import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
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
    expect(parseFileServiceRequest({ id: 6, op: 'list', path: 'relative/a' })).toBeUndefined()
    expect(parseFileServiceRequest({ id: 7, op: 'list', path: '/a\u0000b' })).toBeUndefined()
    expect(parseFileServiceRequest({ id: 'x', op: 'home' })).toBeUndefined()
    expect(parseFileServiceRequest({ id: 8, op: 'delete', path: '/a' })).toBeUndefined()
  })

  test('project management requests carry structured names, never paths', () => {
    expect(parseFileServiceRequest({ id: 1, op: 'projects' })).toEqual({ id: 1, op: 'projects' })
    expect(parseFileServiceRequest({ id: 2, op: 'gitRoot', path: '/srv/app' })).toEqual({ id: 2, op: 'gitRoot', path: '/srv/app' })
    expect(parseFileServiceRequest({ id: 3, op: 'archive', dir: '~srv~app', sessionId: 'aaaa-1', restore: false }))
      .toEqual({ id: 3, op: 'archive', dir: '~srv~app', sessionId: 'aaaa-1', restore: false })
    expect(parseFileServiceRequest({ id: 4, op: 'removeSession', dir: '~srv~app', sessionId: 'aaaa-1' }))
      .toEqual({ id: 4, op: 'removeSession', dir: '~srv~app', sessionId: 'aaaa-1' })
    expect(parseFileServiceRequest({ id: 5, op: 'removeProject', dir: '~srv~app' })).toEqual({ id: 5, op: 'removeProject', dir: '~srv~app' })
    expect(parseFileServiceRequest({ id: 6, op: 'removeMemory', dir: 'C%3a~Users~me' })).toEqual({ id: 6, op: 'removeMemory', dir: 'C%3a~Users~me' })
    for (const dir of ['', '.', '..', '../mem', '/etc', 'a/b', 'a\\b', 'x y', 'x;y', '$(id)', 'a\u0000b']) {
      expect(parseFileServiceRequest({ id: 9, op: 'removeProject', dir })).toBeUndefined()
      expect(parseFileServiceRequest({ id: 9, op: 'removeMemory', dir })).toBeUndefined()
      expect(parseFileServiceRequest({ id: 9, op: 'removeSession', dir, sessionId: 'aaaa-1' })).toBeUndefined()
    }
    // memory 与 archived 是项目目录里另有含义的子目录名，不能当会话号
    for (const sessionId of ['', '../mem', 'a/b', 'a;b', 'x y', 'a\u0000b', 'memory', 'archived', 'abc\n', 'abc\r', 'a\tb']) {
      expect(parseFileServiceRequest({ id: 9, op: 'removeSession', dir: '~srv~app', sessionId })).toBeUndefined()
      expect(parseFileServiceRequest({ id: 9, op: 'archive', dir: '~srv~app', sessionId, restore: true })).toBeUndefined()
    }
    expect(parseFileServiceRequest({ id: 9, op: 'archive', dir: '~srv~app', sessionId: 'aaaa-1', restore: 'yes' })).toBeUndefined()
    expect(parseFileServiceRequest({ id: 9, op: 'archive', dir: '~srv~app', sessionId: 'aaaa-1' })).toBeUndefined()
  })

  test('paths travel base64-encoded so shell metacharacters never reach the remote command line', () => {
    const hostile = "/tmp/it's; rm -rf /$(touch nope)"
    const command = fileServiceCommand({ id: 1, op: 'read', path: hostile, offset: 3, limit: 9 })
    expect(command).toBe(`R ${Buffer.from(hostile).toString('base64')} 3 9`)
    expect(command).not.toContain('rm -rf')
    expect(fileServiceCommand({ id: 1, op: 'home' })).toBe('H')
    expect(fileServiceCommand({ id: 1, op: 'gitRoot', path: hostile })).toBe(`G ${Buffer.from(hostile).toString('base64')}`)
    expect(fileServiceCommand({ id: 1, op: 'projects' })).toBe('P')
    expect(fileServiceCommand({ id: 1, op: 'archive', dir: hostile, sessionId: 'aaaa-1', restore: true }))
      .toBe(`A ${Buffer.from(hostile).toString('base64')} aaaa-1 1`)
    expect(fileServiceCommand({ id: 1, op: 'removeSession', dir: hostile, sessionId: 'aaaa-1' }))
      .toBe(`X ${Buffer.from(hostile).toString('base64')} aaaa-1`)
    expect(fileServiceCommand({ id: 1, op: 'removeProject', dir: hostile })).toBe(`D ${Buffer.from(hostile).toString('base64')}`)
    expect(fileServiceCommand({ id: 1, op: 'removeMemory', dir: hostile })).toBe(`M ${Buffer.from(hostile).toString('base64')}`)
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

  test('project frames decode into directory markers, git roots and plain acknowledgements', () => {
    expect(parseFileFrame({ id: 1, op: 'projects' }, { ok: true, lines: ['~srv~app\t1\t0', 'C%3a~Users~me\t0\t1', '../escape\t1\t1', 'a/b\t0\t0', 'thin\t1'] }))
      .toEqual({ id: 1, ok: true, projects: [
        { dir: '~srv~app', memory: true, archived: false },
        { dir: 'C%3a~Users~me', memory: false, archived: true },
        { dir: 'thin', memory: true, archived: false },
      ] })
    expect(parseFileFrame({ id: 2, op: 'gitRoot', path: '/srv/app' }, { ok: true, lines: ['/srv'] })).toEqual({ id: 2, ok: true, root: '/srv' })
    expect(parseFileFrame({ id: 3, op: 'gitRoot', path: '/srv/app' }, { ok: true, lines: [''] })).toEqual({ id: 3, ok: true, root: null })
    for (const op of ['archive', 'removeSession', 'removeProject', 'removeMemory'] as const) {
      const request = { id: 4, op } as FileServiceRequest
      expect(parseFileFrame(request, { ok: true })).toEqual({ id: 4, ok: true })
      expect(parseFileFrame(request, { ok: false })).toEqual({ id: 4, ok: false, error: '远端无法完成该文件操作' })
    }
  })
})

const shell = findPosixShell()

type Answer = FileServiceResponse & { id: number }
interface Ask { op: string; path?: string; offset?: number; limit?: number; dir?: string; sessionId?: string; restore?: boolean }

/** Git Bash 的 sh 只认 POSIX 形态路径：E:\\a\\b → /e/a/b（与真实远端一致，请求校验也只放行绝对路径）。 */
const posix = (path: string): string => process.platform === 'win32'
  ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
  : path

/** env 里取 undefined 的变量从子进程环境里删掉（用于验证远端的缺省落点）。 */
const loopEnv = (env: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {
    ...process.env,
    // Directly invoking Git Bash's sh.exe bypasses its login-shell PATH setup.
    PATH: [dirname(shell!), process.env.PATH].filter(Boolean).join(delimiter),
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete result[key]
    else result[key] = value
  }
  return result
}

/**
 * 起一条真实 POSIX sh 上的远端循环并接上宿主协议：ask 走与生产相同的请求
 * 校验与帧解析，协议帧、路径解码与边界条件都以实际行为为准。
 */
function startRemoteLoop(env: Record<string, string | undefined> = {}) {
  const hostIn = new PassThrough()
  const hostOut = new PassThrough()
  const hostErr = new PassThrough()
  const answers = new Map<number, Answer>()
  const events: string[] = []
  let seq = 0
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
  const proc = spawn(shell!, ['-c', remoteFileServiceScript()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: loopEnv(env),
  }) as ChildProcessWithoutNullStreams
  const exited = serveFileChannel(proc, { stdin: hostIn, stdout: hostOut, stderr: hostErr })
  const ask = async (request: Ask): Promise<Answer> => {
    const id = ++seq
    hostIn.write(`${JSON.stringify({ id, ...request })}\n`)
    const deadline = Date.now() + 5000
    while (!answers.has(id)) {
      if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`No response for ${request.op}`)
      await Bun.sleep(15)
    }
    return answers.get(id)!
  }
  return { proc, exited, ask, events, hostIn }
}

/** 不经宿主协议、直接把一行指令写给远端循环：验证远端自己对越界参数的拒绝。 */
function startRawLoop(env: Record<string, string | undefined> = {}) {
  const proc = spawn(shell!, ['-c', remoteFileServiceScript()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: loopEnv(env),
  }) as ChildProcessWithoutNullStreams
  const frames: string[] = []
  let buffer = ''
  let greeted = false
  let wake: (() => void) | undefined
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    if (!greeted && buffer.includes('@ready\n')) {
      buffer = buffer.replace('@ready\n', '')
      greeted = true
    }
    let end: number
    while ((end = buffer.indexOf('@end\n')) !== -1) {
      frames.push(buffer.slice(0, end + '@end\n'.length))
      buffer = buffer.slice(end + '@end\n'.length)
    }
    wake?.()
  })
  const run = async (command: string): Promise<string> => {
    proc.stdin.write(`${command}\n`)
    const deadline = Date.now() + 5000
    while (frames.length === 0) {
      if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`No frame for ${command}`)
      await new Promise<void>(resolve => { wake = resolve })
    }
    return frames.shift()!
  }
  return { proc, run }
}

const touch = (path: string, content = 'x'): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

describe.skipIf(!shell)('remote file loop on a real POSIX shell', () => {
  const root = join(import.meta.dirname, '..', '..', 'test', 'ssh-file-service')
  let loop: ReturnType<typeof startRemoteLoop>

  test('answers home, stat, list and ranged reads in order', async () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, "dir with space's"), { recursive: true })
    mkdirSync(join(root, 'empty'), { recursive: true })
    writeFileSync(join(root, 'hello.txt'), 'hello world')
    utimesSync(join(root, 'hello.txt'), 1700000000, 1700000000)
    writeFileSync(join(root, '.hidden'), 'x')
    writeFileSync(join(root, '中文 名.txt'), '你好')
    // 不继承宿主的配置目录：这里验证的是远端缺省落到 $HOME/.doge
    loop = startRemoteLoop({ CLAUDE_CONFIG_DIR: undefined })
    const deadline = Date.now() + 5000
    while (!loop.events.includes('ready')) {
      if (Date.now() > deadline) throw new Error('Channel never became ready')
      await Bun.sleep(10)
    }
    const { ask } = loop

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
    expect(await loop.ask({ op: 'wipe', path: posix(root) })).toMatchObject({ ok: false, error: '无效的文件通道请求' })
    expect(await loop.ask({ op: 'read', path: posix(join(root, 'hello.txt')), offset: -5, limit: 4 })).toMatchObject({ ok: false, error: '无效的文件通道请求' })
    expect(await loop.ask({ op: 'removeProject', dir: '../..' })).toMatchObject({ ok: false, error: '无效的文件通道请求' })
    expect(await loop.ask({ op: 'stat', path: posix(join(root, 'hello.txt')) })).toMatchObject({ ok: true, size: 11 })
  })

  test('closing stdin ends the remote loop and the channel exits cleanly', async () => {
    loop.hostIn.end()
    expect(await loop.exited).toBe(0)
    expect(loop.proc.exitCode).toBe(0)
    expect(loop.events).toEqual(['ready', 'down'])
  })

  afterAll(() => {
    if (loop?.proc.exitCode === null && loop.proc.signalCode === null) loop.proc.kill()
    rmSync(root, { recursive: true, force: true })
  })
})

/** 一套远端会话数据：项目目录（会话、归档、子代理副本、记忆）与会话附属数据。 */
function seedSessionData(root: string): { configDir: string; projects: string } {
  rmSync(root, { recursive: true, force: true })
  const configDir = join(root, 'cfg')
  const projects = join(configDir, 'projects')
  for (const session of ['live', 'done', 'old']) {
    touch(join(configDir, 'session-env', session, 'env.json'))
    touch(join(configDir, 'tasks', session, 'tasks.json'))
  }
  for (const session of ['live', 'done']) {
    touch(join(projects, '~srv~app', `${session}.jsonl`))
    touch(join(projects, '~srv~app', session, 'subagents', 'agent-a.jsonl'))
  }
  touch(join(projects, '~srv~app', 'archived', 'old.jsonl'))
  touch(join(projects, '~srv~app', 'memory', 'MEMORY.md'))
  touch(join(projects, '~srv~mem', 'memory', 'MEMORY.md'))
  touch(join(projects, '~srv~solo', 'only.jsonl'))
  touch(join(root, 'outside', 'keep.txt'))
  return { configDir, projects }
}

describe.skipIf(!shell)('remote project management on a real POSIX shell', () => {
  const root = join(import.meta.dirname, '..', '..', 'test', 'ssh-project-ops')
  const paths = { configDir: '', projects: '' }
  let loop: ReturnType<typeof startRemoteLoop>

  beforeAll(() => {
    Object.assign(paths, seedSessionData(root))
    loop = startRemoteLoop({ CLAUDE_CONFIG_DIR: posix(paths.configDir) })
  })

  test('lists project directories with their memory and archived markers', async () => {
    expect(await loop.ask({ op: 'home' })).toMatchObject({ ok: true, configDir: posix(paths.configDir) })
    expect(await loop.ask({ op: 'projects' })).toEqual({ id: expect.any(Number), ok: true, projects: [
      { dir: '~srv~app', memory: true, archived: true },
      { dir: '~srv~mem', memory: true, archived: false },
      { dir: '~srv~solo', memory: false, archived: false },
    ] })
  })

  test('resolves the git top-level and reports directories outside a repository as empty', async () => {
    const repo = join(root, 'repo')
    touch(join(repo, 'sub', '.keep'))
    if (spawnSync('git', ['init', '-q', repo], { stdio: 'ignore' }).status === 0) {
      const { root: found } = await loop.ask({ op: 'gitRoot', path: posix(join(repo, 'sub')) }) as { root: string | null }
      // Windows 的 git 输出 E:/… 形态，统一成 POSIX 路径再比
      expect(posix(found ?? '').toLowerCase()).toBe(posix(realpathSync(repo)).toLowerCase())
    }
    expect(await loop.ask({ op: 'gitRoot', path: posix(realpathSync(tmpdir())) })).toMatchObject({ ok: true, root: null })
    expect(await loop.ask({ op: 'gitRoot', path: `${posix(root)}/missing` })).toMatchObject({ ok: false })
  })

  test('reports directories outside a repository as empty even when no timeout binary exists', async () => {
    // 没有 coreutils timeout 的远端（BSD、精简的 BusyBox）走无限时的那条分支
    const bare = startRemoteLoop({ CLAUDE_CONFIG_DIR: posix(paths.configDir), PATH: dirname(shell!) })
    try {
      const deadline = Date.now() + 5000
      while (!bare.events.includes('ready')) {
        if (Date.now() > deadline) throw new Error('Bare channel never became ready')
        await Bun.sleep(10)
      }
      const outside = realpathSync(tmpdir())
      // 系统临时目录若恰好落在某个 git 工作树里（TMPDIR / GIT_DIR 被改过）就不拿它当「仓库之外」的样本
      if (spawnSync('git', ['-C', outside, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' }).status !== 0) {
        expect(await bare.ask({ op: 'gitRoot', path: posix(outside) })).toMatchObject({ ok: true, root: null })
      }
    } finally {
      bare.hostIn.end()
      await bare.exited
    }
  })

  test('archives and restores a transcript in place, leaving its sidecar directory behind', async () => {
    const app = join(paths.projects, '~srv~app')
    expect(await loop.ask({ op: 'archive', dir: '~srv~app', sessionId: 'done', restore: false })).toMatchObject({ ok: true })
    expect(existsSync(join(app, 'archived', 'done.jsonl'))).toBe(true)
    expect(existsSync(join(app, 'done.jsonl'))).toBe(false)
    expect(existsSync(join(app, 'done', 'subagents', 'agent-a.jsonl'))).toBe(true)
    expect(await loop.ask({ op: 'archive', dir: '~srv~app', sessionId: 'done', restore: false })).toMatchObject({ ok: true })
    expect(await loop.ask({ op: 'archive', dir: '~srv~app', sessionId: 'missing', restore: false })).toMatchObject({ ok: false })
    expect(await loop.ask({ op: 'archive', dir: '~no~such', sessionId: 'done', restore: false })).toMatchObject({ ok: false })
    expect(await loop.ask({ op: 'archive', dir: '~srv~app', sessionId: 'done', restore: true })).toMatchObject({ ok: true })
    expect(existsSync(join(app, 'done.jsonl'))).toBe(true)
    expect(existsSync(join(app, 'archived', 'done.jsonl'))).toBe(false)
    expect(await loop.ask({ op: 'archive', dir: '~srv~app', sessionId: 'done', restore: true })).toMatchObject({ ok: true })
    // 两份都在：归档时未归档的那份较新（会话在别处续写过），盖掉归档副本
    touch(join(app, 'archived', 'done.jsonl'), 'older')
    touch(join(app, 'done.jsonl'), 'newer')
    expect(await loop.ask({ op: 'archive', dir: '~srv~app', sessionId: 'done', restore: false })).toMatchObject({ ok: true })
    expect(existsSync(join(app, 'done.jsonl'))).toBe(false)
    expect(readFileSync(join(app, 'archived', 'done.jsonl'), 'utf8')).toBe('newer')
    // 恢复时未归档的那份已经在：以它为准，归档副本留在原处
    touch(join(app, 'done.jsonl'), 'restored')
    expect(await loop.ask({ op: 'archive', dir: '~srv~app', sessionId: 'done', restore: true })).toMatchObject({ ok: true })
    expect(readFileSync(join(app, 'done.jsonl'), 'utf8')).toBe('restored')
    expect(existsSync(join(app, 'archived', 'done.jsonl'))).toBe(true)
    rmSync(join(app, 'archived', 'done.jsonl'))
  })

  test('refuses to manage a project directory that is a symbolic link', async () => {
    // 链接指向的别处不能被改；删链接又会留下真身。Windows 的 Git Bash 不建真链接，跳过
    const link = spawnSync(shell!, ['-c', `ln -s ${JSON.stringify(posix(join(paths.projects, '~srv~app')))} ${JSON.stringify(posix(join(paths.projects, '~srv~link')))} 2>/dev/null`], { stdio: 'ignore' })
    if (process.platform === 'win32' || link.status !== 0 || !lstatSync(join(paths.projects, '~srv~link')).isSymbolicLink()) return
    for (const request of [
      { op: 'archive', dir: '~srv~link', sessionId: 'live', restore: false },
      { op: 'removeSession', dir: '~srv~link', sessionId: 'live' },
      { op: 'removeMemory', dir: '~srv~link' },
      { op: 'removeProject', dir: '~srv~link' },
    ]) {
      expect(await loop.ask(request)).toMatchObject({ ok: false })
    }
    expect(existsSync(join(paths.projects, '~srv~app', 'live.jsonl'))).toBe(true)
    expect(existsSync(join(paths.projects, '~srv~app', 'memory', 'MEMORY.md'))).toBe(true)
  })

  test('removes one session with its sidecar data and keeps the rest of the project', async () => {
    expect(await loop.ask({ op: 'removeSession', dir: '~srv~app', sessionId: 'done' })).toMatchObject({ ok: true })
    for (const gone of [join(paths.projects, '~srv~app', 'done.jsonl'), join(paths.projects, '~srv~app', 'done'),
      join(paths.configDir, 'session-env', 'done'), join(paths.configDir, 'tasks', 'done')]) {
      expect(existsSync(gone)).toBe(false)
    }
    for (const kept of [join(paths.projects, '~srv~app', 'live.jsonl'), join(paths.projects, '~srv~app', 'live'),
      join(paths.projects, '~srv~app', 'archived', 'old.jsonl'), join(paths.projects, '~srv~app', 'memory', 'MEMORY.md')]) {
      expect(existsSync(kept)).toBe(true)
    }
    expect(await loop.ask({ op: 'removeSession', dir: '~srv~app', sessionId: 'done' })).toMatchObject({ ok: true })
    expect(await loop.ask({ op: 'removeSession', dir: '~no~such', sessionId: 'done' })).toMatchObject({ ok: true })
  })

  test('leaves the sidecar data of a session alone when it lives in another project', async () => {
    // CLI 会跨同仓的兄弟工作树回退解析会话：同一个会话号可能被报在别的项目目录下
    expect(await loop.ask({ op: 'removeSession', dir: '~srv~mem', sessionId: 'live' })).toMatchObject({ ok: true })
    expect(existsSync(join(paths.projects, '~srv~app', 'live.jsonl'))).toBe(true)
    expect(existsSync(join(paths.configDir, 'session-env', 'live'))).toBe(true)
    expect(existsSync(join(paths.configDir, 'tasks', 'live'))).toBe(true)
  })

  test('drops a project directory once its last session is gone, empty archived/ included', async () => {
    // 归档再恢复之后远端会剩一个空的 archived/：它不该把已清空的项目目录钉在远端
    mkdirSync(join(paths.projects, '~srv~solo', 'archived'))
    expect(await loop.ask({ op: 'removeSession', dir: '~srv~solo', sessionId: 'only' })).toMatchObject({ ok: true })
    expect(existsSync(join(paths.projects, '~srv~solo'))).toBe(false)
  })

  test('removes only the memory directory', async () => {
    expect(await loop.ask({ op: 'removeMemory', dir: '~srv~app' })).toMatchObject({ ok: true })
    expect(existsSync(join(paths.projects, '~srv~app', 'memory'))).toBe(false)
    expect(existsSync(join(paths.projects, '~srv~app', 'live.jsonl'))).toBe(true)
    expect(await loop.ask({ op: 'removeMemory', dir: '~no~such' })).toMatchObject({ ok: true })
    // 记忆删完项目目录已空：一并撤掉，不在清单里留一个空壳
    touch(join(paths.projects, '~srv~ghost', 'memory', 'MEMORY.md'))
    expect(await loop.ask({ op: 'removeMemory', dir: '~srv~ghost' })).toMatchObject({ ok: true })
    expect(existsSync(join(paths.projects, '~srv~ghost'))).toBe(false)
  })

  test('removes the whole project with every session sidecar and nothing outside it', async () => {
    expect(await loop.ask({ op: 'removeProject', dir: '~srv~app' })).toMatchObject({ ok: true })
    for (const gone of [join(paths.projects, '~srv~app'), join(paths.configDir, 'session-env', 'live'),
      join(paths.configDir, 'session-env', 'old'), join(paths.configDir, 'tasks', 'live'), join(paths.configDir, 'tasks', 'old')]) {
      expect(existsSync(gone)).toBe(false)
    }
    expect(existsSync(join(paths.projects, '~srv~mem', 'memory', 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(root, 'outside', 'keep.txt'))).toBe(true)
    expect(await loop.ask({ op: 'removeProject', dir: '~srv~app' })).toMatchObject({ ok: true })
  })

  afterAll(() => {
    if (loop?.proc.exitCode === null && loop.proc.signalCode === null) loop.proc.kill()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
})

describe.skipIf(!shell)('remote project management refuses out-of-bounds targets', () => {
  const root = join(import.meta.dirname, '..', '..', 'test', 'ssh-project-guards')
  const paths = { configDir: '', projects: '' }
  const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
  let loop: ReturnType<typeof startRawLoop>

  beforeAll(() => {
    Object.assign(paths, seedSessionData(root))
    loop = startRawLoop({ CLAUDE_CONFIG_DIR: posix(paths.configDir) })
  })

  test('directory names must be a single safe path segment', async () => {
    for (const dir of ['', '.', '..', '../..', '../mem', '/', '/etc', 'a/b', 'a\\b', 'x y', 'x;y', '$(id)', 'ok\n..', '~srv~app/']) {
      for (const command of [`D ${b64(dir)}`, `M ${b64(dir)}`, `X ${b64(dir)} done`, `A ${b64(dir)} done 0`]) {
        expect(await loop.run(command)).toBe('@err\n@end\n')
      }
    }
    for (const command of ['D !!not-base64!!', 'D', 'M ', 'X', 'A', 'X !!', 'A !! 0']) {
      expect(await loop.run(command)).toBe('@err\n@end\n')
    }
  })

  test('session ids and archive flags must be plain tokens, never the reserved sub-directory names', async () => {
    // memory 与 archived 当会话号会把整份归档或记忆当成「一个会话」删掉
    for (const sessionId of ['', '../mem', 'a/b', 'a;b', 'x y', 'a..', '..', 'memory', 'archived']) {
      expect(await loop.run(`X ${b64('~srv~app')} ${sessionId}`)).toBe('@err\n@end\n')
      expect(await loop.run(`A ${b64('~srv~app')} ${sessionId} 0`)).toBe('@err\n@end\n')
    }
    const dir = b64('~srv~app')
    for (const command of [`A ${dir} done`, `A ${dir} done 2`, `A ${dir} done -1`, `A ${dir} done yes`, `X ${dir}`, `X ${dir} done extra`]) {
      expect(await loop.run(command)).toBe('@err\n@end\n')
    }
  })

  test('refused commands leave every file untouched while a valid one still works', async () => {
    for (const kept of [join(paths.projects, '~srv~app', 'live.jsonl'), join(paths.projects, '~srv~app', 'memory', 'MEMORY.md'),
      join(paths.projects, '~srv~app', 'archived', 'old.jsonl'), join(paths.projects, '~srv~mem', 'memory', 'MEMORY.md'),
      join(paths.projects, '~srv~solo', 'only.jsonl'), join(paths.configDir, 'session-env', 'live'),
      join(paths.configDir, 'tasks', 'done'), join(root, 'outside', 'keep.txt')]) {
      expect(existsSync(kept)).toBe(true)
    }
    expect(await loop.run(`D ${b64('~srv~mem')}`)).toBe('@ok\n@end\n')
    expect(existsSync(join(paths.projects, '~srv~mem'))).toBe(false)
    expect(existsSync(join(paths.projects, '~srv~app', 'live.jsonl'))).toBe(true)
  })

  afterAll(() => {
    loop?.proc.kill()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
})

function findPosixShell(): string | undefined {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles ?? 'C:\\Program Files', 'E:\\Git', 'D:\\Git']) {
      // 真实远端的 sh 多是 dash：Git for Windows 自带 dash.exe，开发机上优先拿它跑
      candidates.push(join(base, 'Git', 'usr', 'bin', 'dash.exe'), join(base, 'usr', 'bin', 'dash.exe'))
    }
  }
  candidates.push('sh')
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles ?? 'C:\\Program Files', 'E:\\Git', 'D:\\Git']) {
      candidates.push(join(base, 'Git', 'usr', 'bin', 'sh.exe'), join(base, 'usr', 'bin', 'sh.exe'))
    }
  }
  return candidates.find(candidate => spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0)
}

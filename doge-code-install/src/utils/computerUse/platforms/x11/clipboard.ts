import { execFileNoThrow } from '../../../execFileNoThrow.js'
import { withX11Desktop } from './desktop.js'

const TEXT_TARGET = /^(TARGETS|MULTIPLE|TIMESTAMP|SAVE_TARGETS|UTF8_STRING|TEXT|STRING|COMPOUND_TEXT|text\/plain(?:;[^\s]+)?)$/

async function readSelection(...args: string[]): Promise<string> {
  const { code, stdout } = await execFileNoThrow('xclip', ['-selection', 'clipboard', '-out', ...args], {
    useCwd: false, stripFinalNewline: false, timeout: 3000,
  })
  if (code !== 0) throw new Error(`xclip exited with code ${code}`)
  return stdout
}

export async function readX11Clipboard(): Promise<string> {
  if (!await withX11Desktop(desktop => desktop.clipboardOwner())) return ''
  const formats = (await readSelection('-target', 'TARGETS')).trim()
  if (!formats || !formats.split(/\s+/).every(target => TEXT_TARGET.test(target))) {
    throw new Error('The X11 clipboard offers non-text or unknown formats. It was left unchanged.')
  }
  return readSelection()
}

export async function writeX11Clipboard(text: string): Promise<void> {
  // xclip forks the selection owner. That process must not inherit output
  // pipes or the caller can wait for a clipboard replacement before returning.
  const child = Bun.spawn(['xclip', '-selection', 'clipboard', '-in'], {
    stdin: Buffer.from(text),
    stdout: 'ignore',
    stderr: 'ignore',
    signal: AbortSignal.timeout(3000),
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`xclip exited with code ${code}`)
}

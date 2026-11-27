import { execa } from 'execa'
import instances from '../../ink/instances.js'
import { classifyGuiEditor, editorArgv, getExternalEditor } from '../../utils/editor.js'

/** Persistent files can be opened in a GUI without giving up the terminal. */
export async function openMemoryEditor(path: string): Promise<void> {
  const editor = getExternalEditor()
  if (!editor) throw new Error('No editor found. Set VISUAL or EDITOR.')

  const command = process.platform === 'win32' && editor === 'start /wait notepad'
    ? 'notepad.exe'
    : editor
  const [file, ...args] = editorArgv(command)
  if (!file) throw new Error('No editor found. Set VISUAL or EDITOR.')

  if (classifyGuiEditor(command)) {
    // Execa hides Windows children by default, including native GUI windows.
    // Keep hiding console launchers such as VS Code's code.cmd.
    const windowsExecutable = process.platform === 'win32' &&
      /\.(?:exe|com)$/i.test((typeof Bun !== 'undefined' ? Bun.which(file) : null) ?? file)
    const child = execa(file, [...args.filter(arg => !['-w', '-wait', '--wait'].includes(arg)), path], {
      detached: true,
      cleanup: false,
      stdio: 'ignore',
      windowsHide: !windowsExecutable,
    })
    // Surface immediate spawn failures. An open editor can outlive this CLI.
    await new Promise<void>((resolve, reject) => {
      void child.catch(reject)
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
    return
  }

  const ink = instances.get(process.stdout)
  ink?.enterAlternateScreen()
  try {
    await execa(file, [...args, path], { stdio: 'inherit' })
  } finally {
    ink?.exitAlternateScreen()
  }
}

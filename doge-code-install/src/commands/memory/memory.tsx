import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { useRef, type ReactNode } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { MemoryFileSelector } from '../../components/memory/MemoryFileSelector.js'
import { Box } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { openPath } from '../../utils/browser.js'
import { clearMemoryFileCaches, getMemoryFiles, type MemoryFileInfo } from '../../utils/claudemd.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { openMemoryEditor } from './openMemoryEditor.js'

function MemoryCommand({ onDone, files }: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  files: MemoryFileInfo[]
}): ReactNode {
  const finish = (message: string) => onDone(message, { display: 'system' })
  const opening = useRef(false)

  async function openFile(path: string) {
    if (opening.current) return
    opening.current = true
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, '', { encoding: 'utf8', flag: 'wx' }).catch(error => {
        if (getErrnoCode(error) !== 'EEXIST') throw error
      })
      await openMemoryEditor(path)
      finish(`Opened memory file at ${getDisplayPath(path)}`)
    } catch (error) {
      finish(`Could not open memory file ${getDisplayPath(path)}: ${String(error)}`)
    }
  }

  async function openFolder(path: string) {
    if (opening.current) return
    opening.current = true
    try {
      await mkdir(path, { recursive: true })
      if (!await openPath(path)) throw new Error('The system could not open that folder')
      finish(`Opened memory folder at ${getDisplayPath(path)}`)
    } catch (error) {
      finish(`Could not open memory folder ${getDisplayPath(path)}: ${String(error)}`)
    }
  }

  const cancel = () => { if (!opening.current) finish('Cancelled memory editing') }
  return (
    <Dialog title="Memory" onCancel={cancel} color="remember">
      <Box flexDirection="column">
        <MemoryFileSelector memoryFiles={files} onSelect={openFile} onOpenFolder={openFolder} onCancel={cancel} />
      </Box>
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  resetSettingsCache()
  clearMemoryFileCaches()
  const files = await getMemoryFiles()
  return <MemoryCommand onDone={onDone} files={files} />
}

import { expect, test } from 'bun:test'
import { getClipboardPathFor, getWindowsClipboardCommand } from './osc.js'

test('native clipboard paths are selected per platform and transport', () => {
  expect(getClipboardPathFor('win32', false, false)).toBe('native')
  expect(getClipboardPathFor('win32', false, true)).toBe('native')
  expect(getClipboardPathFor('darwin', false, false)).toBe('native')
  expect(getClipboardPathFor('darwin', false, true)).toBe('native')
  // Linux native tools are probed asynchronously; the synchronous estimate
  // stays OSC 52, matching the pre-existing toast behavior.
  expect(getClipboardPathFor('linux', false, false)).toBe('osc52')
  expect(getClipboardPathFor('linux', false, true)).toBe('tmux-buffer')
  expect(getClipboardPathFor('win32', true, false)).toBe('osc52')
  expect(getClipboardPathFor('linux', true, true)).toBe('tmux-buffer')
  expect(getClipboardPathFor('darwin', true, true)).toBe('tmux-buffer')
})

test('Windows clipboard writes use UTF-8 PowerShell instead of clip.exe', () => {
  const command = getWindowsClipboardCommand()
  const script = command.args[command.args.indexOf('-Command') + 1]

  expect(command.file).toBe('powershell.exe')
  expect(command.args).toContain('-NoProfile')
  expect(command.args).toContain('-NonInteractive')
  expect(script).toContain('[Console]::OpenStandardInput()')
  expect(script).toContain('[System.Text.UTF8Encoding]::new($false)')
  expect(script).toContain('.ReadToEnd() | Set-Clipboard -ErrorAction Stop')
  expect(command.timeout).toBe(10_000)
})

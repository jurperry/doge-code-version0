import { describe, expect, test } from 'bun:test'
import { MAX_BATCH_ACTIONS, MAX_TYPE_TEXT_LENGTH } from './limits.js'
import { buildComputerUseTools } from './tools.js'

const windows = buildComputerUseTools({ screenshotFiltering: 'none', platform: 'win32' }, 'pixels')
const mac = buildComputerUseTools({ screenshotFiltering: 'native', platform: 'darwin' }, 'pixels')
const sharedFields: Record<string, string[]> = {
  request_access: ['apps', 'reason', 'clipboardRead', 'clipboardWrite', 'systemKeyCombos'],
  screenshot: ['save_to_disk'], zoom: ['region', 'save_to_disk'],
  left_click: ['coordinate', 'text'], double_click: ['coordinate', 'text'], triple_click: ['coordinate', 'text'],
  right_click: ['coordinate', 'text'], middle_click: ['coordinate', 'text'],
  type: ['text'], key: ['text', 'repeat'], scroll: ['coordinate', 'scroll_direction', 'scroll_amount'],
  left_click_drag: ['coordinate', 'start_coordinate'], mouse_move: ['coordinate'], open_application: ['app'],
  switch_display: ['display'], list_granted_applications: [], read_clipboard: [], write_clipboard: ['text'],
  wait: ['duration'], cursor_position: [], hold_key: ['text', 'duration'], left_mouse_down: [], left_mouse_up: [],
  computer_batch: ['actions'],
}
const windowsFields = {
  ...sharedFields,
  open_application: ['app', 'window_id'],
  list_granted_applications: ['include_windows', 'include_desktop'],
  list_windows: ['visible_only', 'granted_only', 'limit'], activate_window: ['hwnd'], get_window: ['hwnd'],
}

describe('Computer Use model contract', () => {
  test('the Windows and macOS schemas expose exactly the fields accepted by their handlers', () => {
    for (const [tools, fields] of [[windows, windowsFields], [mac, sharedFields]] as const) {
      expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(fields).sort())
      for (const tool of tools) {
        const properties = Object.keys(tool.inputSchema.properties ?? {}).sort()
        expect(properties).toEqual([...fields[tool.name as keyof typeof fields]].sort())
        expect(tool.inputSchema.required?.every(key => properties.includes(key)) ?? true).toBe(true)
      }
    }
  })

  test('batch advertises only fields used by its actions and keeps the declared limits', () => {
    const actions = windows.find(tool => tool.name === 'computer_batch')?.inputSchema.properties?.actions as {
      maxItems: number
      items: { properties: Record<string, { enum?: string[]; maxLength?: number }> }
    }
    const properties = actions.items.properties
    expect(actions.maxItems).toBe(MAX_BATCH_ACTIONS)
    expect(properties.text?.maxLength).toBe(MAX_TYPE_TEXT_LENGTH)
    const actionTools = windows.filter(tool => properties.action?.enum?.includes(tool.name))
    expect(actionTools).toHaveLength(properties.action?.enum?.length ?? 0)
    const fields = new Set(actionTools.flatMap(tool => Object.keys(tool.inputSchema.properties ?? {})))
    expect(Object.keys(properties).sort()).toEqual(['action', ...fields].sort())
  })
})

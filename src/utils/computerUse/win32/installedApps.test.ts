import { expect, test } from 'bun:test'
import {
  mergeInstalledEntries,
  parseAppLines,
} from './installedApps.js'

// ── parseAppLines ───────────────────────────────────────────────────────────

test('parses name|path|id lines and tolerates a missing extra segment', () => {
  const entries = parseAppLines('Notepad|C:\\Windows\\notepad.exe|C:\\Windows\\notepad.exe\nQQ||QQ\n')
  expect(entries).toHaveLength(2)
  expect(entries[0]).toEqual({
    displayName: 'Notepad',
    path: 'C:\\Windows\\notepad.exe',
    id: 'C:\\Windows\\notepad.exe',
    extraPaths: undefined,
  })
  // Registry entry without InstallLocation — path falls back to id
  expect(entries[1]!.path).toBe('QQ')
})

test('parses ;;-separated extras (running-window titles)', () => {
  const entries = parseAppLines(
    'dnplayer|D:\\LDPlayer\\dnplayer.exe|D:\\LDPlayer\\dnplayer.exe|雷电模拟器;;LDPlayer',
  )
  expect(entries[0]!.extraPaths).toEqual(['雷电模拟器', 'LDPlayer'])
})

test('skips blank lines and lines without a display name', () => {
  expect(parseAppLines('\n\n   \n|C:\\x.exe|C:\\x.exe\n')).toEqual([])
})

// ── mergeInstalledEntries ───────────────────────────────────────────────────

test('shortcut (exe id) beats registry entry and keeps its paths as extras', () => {
  const merged = mergeInstalledEntries([
    { displayName: 'QQ', path: '', id: 'QQ' },
    {
      displayName: 'QQ',
      path: 'D:\\QQ.exe',
      id: 'D:\\QQ.exe',
    },
  ])
  expect(merged).toHaveLength(1)
  expect(merged[0]!.id).toBe('D:\\QQ.exe')
  expect(merged[0]!.extraPaths).toContain('QQ')
})

test('running-window entry merges its titles into the matched app', () => {
  const merged = mergeInstalledEntries([
    {
      displayName: 'Android Studio',
      path: '',
      id: '{64-a-b}',
    },
    {
      displayName: 'studio64',
      path: 'C:\\Program Files\\Android\\studio64.exe',
      id: 'C:\\Program Files\\Android\\studio64.exe',
      extraPaths: ['MyApp — Android Studio'],
    },
  ])
  // Different display names → two entries (resolution matches both), and the
  // running entry carries its title token for path-based matching.
  expect(merged).toHaveLength(2)
  const running = merged.find(m => m.displayName === 'studio64')!
  expect(running.extraPaths).toContain('MyApp — Android Studio')
})

test('exe entry arriving after exe entry accumulates extra paths', () => {
  const merged = mergeInstalledEntries([
    {
      displayName: 'MuMu模拟器',
      path: 'D:\\MuMu\\MuMu.exe',
      id: 'D:\\MuMu\\MuMu.exe',
    },
    {
      displayName: 'MuMu模拟器',
      path: 'D:\\MuNm\\shell\\MuMuPlayer.exe',
      id: 'D:\\MuNm\\shell\\MuMuPlayer.exe',
      extraPaths: ['MuMu模拟器 12'],
    },
  ])
  expect(merged).toHaveLength(1)
  expect(merged[0]!.extraPaths).toContain('D:\\MuNm\\shell\\MuMuPlayer.exe')
  expect(merged[0]!.extraPaths).toContain('MuMu模拟器 12')
})

test('empty input merges to empty output', () => {
  expect(mergeInstalledEntries([])).toEqual([])
})

test('display-name matching is case-insensitive', () => {
  const merged = mergeInstalledEntries([
    { displayName: 'weChat', path: '', id: 'wechat' },
    {
      displayName: 'WeChat',
      path: 'D:\\WeChat\\WeChat.exe',
      id: 'D:\\WeChat\\WeChat.exe',
    },
  ])
  expect(merged).toHaveLength(1)
  expect(merged[0]!.id).toBe('D:\\WeChat\\WeChat.exe')
})

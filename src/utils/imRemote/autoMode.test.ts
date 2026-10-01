import { describe, expect, test } from 'bun:test'
import { remoteAutoTargetMode } from './autoMode.js'

// 0.2.92 Auto 死开关的判定规则钉死：只有 killswitch、已处 bypass、autoMode
// 关三况不动，其余一律切 bypassPermissions。
describe('remoteAutoTargetMode 远程 Auto 强切判定', () => {
  test('常规会话且 autoMode 开 → 切 bypass', () => {
    expect(remoteAutoTargetMode(true, 'default', false)).toBe('bypassPermissions')
    expect(remoteAutoTargetMode(true, 'acceptEdits', false)).toBe('bypassPermissions')
  })

  test('三不动：autoMode 关 / 已是 bypass / killswitch 禁用', () => {
    expect(remoteAutoTargetMode(false, 'default', false)).toBeNull()
    expect(remoteAutoTargetMode(true, 'bypassPermissions', false)).toBeNull()
    expect(remoteAutoTargetMode(true, 'default', true)).toBeNull()
  })

  test('killswitch 禁用优先于 autoMode（即使已请求也不破例）', () => {
    expect(remoteAutoTargetMode(true, 'acceptEdits', true)).toBeNull()
  })
})

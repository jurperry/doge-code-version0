/**
 * 远程接入的 Auto 强切判定（TUI 与 headless 三处调用收敛到这一单点）：
 * autoMode 关、已是 bypass、或设置层 killswitch 显式禁用时不动（返回
 * null），否则返回 'bypassPermissions'。
 *
 * 0.2.92 修复背景：曾用 isBypassPermissionsModeAvailable 门——它只有以
 * bypass/危险旗标**启动**的会话才为 true（permissionSetup 按 launch 形态
 * 计算），普通会话恒 false，切换是死代码。fork 语义（与
 * handleSetPermissionMode 一致）只看 killswitch。
 */
export function remoteAutoTargetMode(
  autoMode: boolean,
  currentMode: string,
  bypassDisabled: boolean,
): 'bypassPermissions' | null {
  if (!autoMode || currentMode === 'bypassPermissions' || bypassDisabled) return null
  return 'bypassPermissions'
}

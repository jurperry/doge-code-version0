import { expect, mock, test } from 'bun:test'
import React from 'react'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureBootstrapMacro } from '../../bootstrapMacro.js'

ensureBootstrapMacro()
process.env.CLAUDE_CONFIG_DIR ??= resolve(import.meta.dir, '../../../../doge-code-app/test/cli-logo-config')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
process.env.CLAUDE_CODE_FORCE_FULL_LOGO = '1'
const { enableConfigs } = await import('../../utils/config.js')
enableConfigs()
let model = 'glm-5.3[1m]', columns = 140, visible = true
let cache: any[], refs: any[], refIndex = 0
const realState = await import('../../state/AppState.js')
mock.module('../../state/AppState.tsx', () => ({ ...realState, useAppState: (selector: any) => selector({}) }))
const realModel = await import('../../hooks/useMainLoopModel.js')
mock.module('../../hooks/useMainLoopModel.ts', () => ({ ...realModel, useMainLoopModel: () => model }))
mock.module('../../hooks/useTerminalSize.ts', () => ({ useTerminalSize: () => ({ columns, rows: 28 }) }))
mock.module('../../ink/hooks/use-terminal-viewport.ts', () => ({ useTerminalViewport: () => [() => {}, { isVisible: visible }] }))
mock.module('react/compiler-runtime', () => ({ c: (size: number) => cache ??= Array(size).fill(Symbol.for('react.memo_cache_sentinel')) }))
const logoUtils = await import('../../utils/logoV2Utils.js')
mock.module('../../utils/logoV2Utils.ts', () => ({ ...logoUtils,
  getLogoDisplayData: () => ({ version: 'test', cwd: 'E:/fixture', billingType: 'API Usage', agentName: undefined }),
  getRecentActivitySync: () => [], getRecentReleaseNotesSync: () => [],
}))
// Exercise real component memo caches and the real freeze wrapper without a terminal renderer.
;(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = {
  useEffect: () => {}, useState: (init: any) => [typeof init === 'function' ? init() : init, () => {}],
  useContext: () => false,
  useRef: (value: any) => refs[refIndex++] ??= { current: value },
}
const { OffscreenFreeze } = await import('../OffscreenFreeze.js')
const { CondensedLogo } = await import('./CondensedLogo.js')
const { LogoV2 } = await import('./LogoV2.js')

function findFreeze(node: any): any {
  if (!node || typeof node !== 'object') return
  if (node.type === OffscreenFreeze) return node
  for (const child of React.Children.toArray(node.props?.children)) {
    const found = findFreeze(child)
    if (found) return found
  }
}
function text(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return React.Children.toArray(node?.props?.children).map(text).join(' ')
}

for (const [label, Component, width] of [
  ['full', LogoV2, 140], ['narrow', LogoV2, 60], ['condensed', CondensedLogo, 140],
] as const) {
  test(`${label} welcome updates the model while frozen outside the viewport`, () => {
    cache = undefined; refs = []; columns = width; visible = true; model = 'glm-5.3[1m]'
    let key: string | null | undefined
    const render = () => {
      const freeze = findFreeze(Component())
      expect(freeze).toBeDefined()
      if (freeze.key !== key) refs = [] // React remounts keyed children.
      key = freeze.key; refIndex = 0
      return text(OffscreenFreeze(freeze.props))
    }
    expect(render()).toContain('glm-5.3')
    visible = false
    model = 'deepseek-flash[1m]'
    expect(render()).toContain('deepseek-flash')
    expect(render()).not.toContain('glm-5.3')
  })
}

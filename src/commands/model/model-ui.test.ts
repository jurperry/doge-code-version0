import { expect, test, mock } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureBootstrapMacro } from '../../bootstrapMacro.js'
ensureBootstrapMacro()
process.env.CLAUDE_CONFIG_DIR ??= resolve(import.meta.dir, '../../../../doge-code-app/test/cli-model-ui-config')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
const realState = await import('../../state/AppState.js')
let state = { mainLoopModel: 'glm-5.3[1m]', mainLoopModelForSession: null as string | null, fastMode: false }
mock.module('../../state/AppState.tsx', () => ({ ...realState,
  useAppState: (selector: any) => selector(state),
  useSetAppState: () => (update: any) => { state = update(state) },
}))
const realModel = await import('../../hooks/useMainLoopModel.js')
mock.module('../../hooks/useMainLoopModel.ts', () => ({ ...realModel,
  useMainLoopModel: () => realModel.resolveMainLoopModel({ ...state, permissionMode: 'default', exceeds200kTokens: false }),
}))
let cache: any[]
mock.module('react/compiler-runtime', () => ({ c: (size: number) => cache ??= Array(size).fill(Symbol.for('react.memo_cache_sentinel')) }))
const { call } = await import('./model.js')

test('/model cancel reports the current model after only the session override changes', async () => {
  cache = undefined
  const outputs: string[] = []
  const command: any = await call((message: string) => outputs.push(message), {} as any, '')
  const first = command.type(command.props)
  first.props.onCancel()
  expect(outputs.at(-1)).toContain('glm-5.3')
  state = { ...state, mainLoopModelForSession: 'deepseek-flash[1m]' }
  const second = command.type(command.props)
  second.props.onCancel()
  expect(outputs.at(-1)).toContain('deepseek-flash')
  expect(outputs.at(-1)).not.toContain('glm-5.3')
  expect(state.mainLoopModel).toBe('glm-5.3[1m]')
  expect(state.mainLoopModelForSession).toBe('deepseek-flash[1m]')
})

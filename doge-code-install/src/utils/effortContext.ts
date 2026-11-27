/** Request-local effort overrides; never mutate a concurrent session's env. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { EffortValue } from './effort.js'
import { isEnvTruthy } from './envUtils.js'
import { getModelEnvironment } from './model/runtimeModelContext.js'
const scope = new AsyncLocalStorage<{ value: EffortValue | undefined }>()
export const getScopedEffort = () => scope.getStore()

export function suppressEffort(): boolean {
  const env = getModelEnvironment()
  if (isEnvTruthy(env.CLAUDE_CODE_DISABLE_EFFORT)) return true
  const level = env.CLAUDE_CODE_EFFORT_LEVEL?.toLowerCase()
  const hostAuto = isEnvTruthy(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) && isEnvTruthy(env.DOGE_HOST_EFFORT_DEFAULT)
  return !getScopedEffort() && (level === 'auto' || (level === 'unset' && !hostAuto))
}
export async function* withScopedEffort<T>(iterator: AsyncGenerator<T>, value: EffortValue | undefined): AsyncGenerator<T> {
  try {
    while (true) {
      const next = await scope.run({ value }, () => iterator.next())
      if (next.done) return
      yield next.value
    }
  } finally { await scope.run({ value }, () => iterator.return(undefined as never)) }
}

/** Request-local effort overrides; never mutate a concurrent session's env. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { EffortValue } from './effort.js'
const scope = new AsyncLocalStorage<{ value: EffortValue | undefined }>()
export const getScopedEffort = () => scope.getStore()
export async function* withScopedEffort<T>(iterator: AsyncGenerator<T>, value: EffortValue | undefined): AsyncGenerator<T> {
  try {
    while (true) {
      const next = await scope.run({ value }, () => iterator.next())
      if (next.done) return
      yield next.value
    }
  } finally { await scope.run({ value }, () => iterator.return(undefined as never)) }
}

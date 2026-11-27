type Listener = () => void
const listeners = new Set<Listener>()

export function onModelChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitModelChanged(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      /* swallow; signal is best-effort */
    }
  }
}

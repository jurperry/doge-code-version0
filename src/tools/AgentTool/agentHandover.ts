/** Transfer ownership of an already-running generator, including its pending next. */
export async function* takeOverAgentIterator<T>(
  iterator: AsyncIterator<T>, pending: Promise<IteratorResult<T>>,
): AsyncGenerator<T> {
  let done=false
  try {
    let next=await pending
    while(!next.done){
      yield next.value
      next=await iterator.next()
    }
    done=true
  } finally {
    if(!done)await iterator.return?.()
  }
}

/** Ordinary agents follow main cancellation only until they become independent. */
export function linkForegroundAbort(parent: AbortSignal, child: AbortController): () => void {
  const forward=()=>child.abort(parent.reason)
  if(parent.aborted)forward()
  else parent.addEventListener('abort',forward,{once:true})
  return ()=>parent.removeEventListener('abort',forward)
}

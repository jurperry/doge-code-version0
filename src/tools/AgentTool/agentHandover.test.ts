import { expect, test } from 'bun:test'
import { takeOverAgentIterator, linkForegroundAbort } from './agentHandover.js'

test('handover consumes the in-flight result without replaying the agent or tools', async () => {
  let requests=0, tools=0, cleaned=0, release!:()=>void
  const ready=new Promise<void>(resolve=>{release=resolve})
  async function* agent(){
    try { requests++; await ready; yield 'late first response'; tools++; yield 'one tool result' }
    finally { cleaned++ }
  }
  const iterator=agent(), pending=iterator.next(), messages:string[]=[]
  const background=(async()=>{for await(const message of takeOverAgentIterator(iterator,pending))messages.push(message)})()
  expect(requests).toBe(1)
  release(); await background
  expect(messages).toEqual(['late first response','one tool result'])
  expect([requests,tools,cleaned]).toEqual([1,1,1])
})

test('stopping the transferred consumer closes the original iterator once', async()=>{
  let cleaned=0
  async function* agent(){try{yield 'first';yield 'second'}finally{cleaned++}}
  const iterator=agent()
  for await(const _ of takeOverAgentIterator(iterator,iterator.next()))break
  expect(cleaned).toBe(1)
})

test('foreground parent cancellation propagates, and detaches for independent background tasks',()=>{
  const parent=new AbortController(), child=new AbortController()
  const detach=linkForegroundAbort(parent.signal,child)
  detach(); parent.abort('main stopped')
  expect(child.signal.aborted).toBe(false)
  child.abort('task stopped')
  expect(child.signal.reason).toBe('task stopped')
  const activeParent=new AbortController(), activeChild=new AbortController()
  const clean=linkForegroundAbort(activeParent.signal,activeChild)
  activeParent.abort('foreground stopped')
  expect(activeChild.signal.reason).toBe('foreground stopped')
  clean()
})

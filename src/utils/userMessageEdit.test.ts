import { describe, expect, test } from 'bun:test'
import { UserMessageEditTracker, commitUserMessageReplacement, latestEditableUser, rewriteUserMessageTranscript } from './userMessageEdit.js'
import { deserializeMessages } from './conversationRecovery.js'

const user = (uuid: string, content = 'original') => ({ type: 'user', uuid, message: { content } }) as any
const thinking = { type: 'assistant', uuid: 'thinking', message: { content: [{ type: 'thinking', thinking: 'hmm' }], model: 'model', id: 'attempt', usage: { input_tokens: 4, output_tokens: 3 } } } as any
const interrupted = { type: 'user', uuid: 'interruption', isUserInterruption: true, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } } as any

describe('user message replacement authority', () => {
  test('only an explicitly interrupted thinking-only attempt can be replaced and restored', () => {
    const tracker = new UserMessageEditTracker([])
    tracker.receive('original')
    tracker.observe({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } })
    tracker.interrupt()
    tracker.settle()
    expect(tracker.snapshot()).toEqual({ user_message_id: 'original', can_replace: true })
    const restored = new UserMessageEditTracker([{ ...user('original'), userMessageEditState: 'interrupted-thinking' }, thinking, interrupted])
    expect(restored.snapshot()).toEqual({ user_message_id: 'original', can_replace: true })
  })

  for (const activity of [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } },
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', input: {} } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } },
    { type: 'control_request', request: { subtype: 'can_use_tool' } },
    { type: 'system', subtype: 'task_started' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'already answered' }] } },
  ]) test(`activity stays sticky across preview reset: ${JSON.stringify(activity)}`, () => {
    const tracker = new UserMessageEditTracker([])
    tracker.receive('original')
    tracker.observe(activity)
    tracker.observe({ type: 'system', subtype: 'api_retry' })
    tracker.interrupt()
    tracker.settle()
    expect(tracker.snapshot().can_replace).toBe(false)
  })

  test('normal completion, failure, unknown history and late interrupt never gain authority', () => {
    for (const is_error of [false, true]) {
      const tracker = new UserMessageEditTracker([])
      tracker.receive('original')
      tracker.observe({ type: 'result', is_error })
      tracker.interrupt()
      tracker.settle()
      expect(tracker.snapshot().can_replace).toBe(false)
    }
    expect(new UserMessageEditTracker([user('old')]).snapshot().can_replace).toBe(false)
  })

  test('the existing canceled-query error result does not turn an explicit interruption into a model failure', () => {
    const tracker = new UserMessageEditTracker([])
    tracker.receive('original'); tracker.interrupt()
    tracker.observe({ type: 'result', subtype: 'error_during_execution', is_error: true })
    tracker.settle()
    expect(tracker.snapshot().can_replace).toBe(true)
  })

  test('superseding user input invalidates a stopped target', () => {
    const tracker = new UserMessageEditTracker([])
    tracker.receive('first'); tracker.interrupt(); tracker.settle()
    tracker.receive('second')
    expect(tracker.snapshot()).toEqual({ user_message_id: 'second', can_replace: false })
  })

  test('a real prompt matching the displayed interruption text is still a new user input', () => {
    expect(latestEditableUser([user('first'), user('real-input', '[Request interrupted by user]')])?.uuid).toBe('real-input')
  })

  test('whitespace is still nonempty assistant output', () => {
    const tracker = new UserMessageEditTracker([])
    tracker.receive('original')
    tracker.observe({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' ' } } })
    tracker.interrupt(); tracker.settle()
    expect(tracker.snapshot().can_replace).toBe(false)
  })

  test('resume API-validity sentinel does not revoke a persisted interrupted-thinking state', () => {
    const restored = deserializeMessages([{ ...user('original'), userMessageEditState: 'interrupted-thinking' }, interrupted])
    expect(new UserMessageEditTracker(restored).snapshot()).toEqual({ user_message_id: 'original', can_replace: true })
  })
})

describe('replacement commit boundary', () => {
  test('waits for durable commit and never mutates memory on write failure', async () => {
    const messages = [user('earlier'), user('original'), thinking, interrupted]
    let release!: () => void
    const durable = new Promise<void>(resolve => { release = resolve })
    const work = commitUserMessageReplacement(messages, 'original', [user('replacement', 'edited')], () => durable)
    await Promise.resolve()
    expect(messages.map(m => m.uuid)).toEqual(['earlier', 'original', 'thinking', 'interruption'])
    release(); await work
    expect(messages.map(m => m.uuid)).toEqual(['earlier', 'replacement'])
    const failed = [user('original'), thinking]
    await expect(commitUserMessageReplacement(failed, 'original', [user('new')], async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    expect(failed.map(m => m.uuid)).toEqual(['original', 'thinking'])
  })

  test('stale targets and visible/tool tails are rejected before commit', async () => {
    let committed = false
    const save = async () => { committed = true }
    await expect(commitUserMessageReplacement([user('old'), user('latest')], 'old', [user('replacement')], save)).rejects.toThrow()
    await expect(commitUserMessageReplacement([user('latest'), { type: 'assistant', message: { content: [{ type: 'tool_use' }] } } as any], 'latest', [user('replacement')], save)).rejects.toThrow()
    expect(committed).toBe(false)
  })

  test('atomic transcript rewrite preserves metadata, historical chains and billed thinking usage', () => {
    const records = [
      { ...user('earlier'), parentUuid: null },
      { ...user('original'), parentUuid: 'earlier', sessionId: 'session', userMessageEditState: 'interrupted-thinking' },
      { type: 'file-history-snapshot', messageId: 'original', snapshot: { files: [] } },
      { ...thinking, parentUuid: 'original', sessionId: 'session' },
      interrupted,
      { type: 'custom-title', customTitle: 'keep title', sessionId: 'session' },
    ]
    const result = rewriteUserMessageTranscript(records.map(r => JSON.stringify(r)).join('\n') + '\n', 'original', [user('replacement', 'edited')])
    const after = result.trim().split('\n').map(l => JSON.parse(l))
    expect(after.filter(r => r.type === 'user').map(r => [r.uuid, r.message.content])).toEqual([['earlier', 'original'], ['replacement', 'edited']])
    expect(after.find(r => r.uuid === 'replacement').parentUuid).toBe('earlier')
    expect(after.find(r => r.type === 'custom-title').customTitle).toBe('keep title')
    expect(after.find(r => r.type === 'file-history-snapshot').messageId).toBe('original')
    expect(after.find(r => r.type === 'network-retry-usage').message.usage).toEqual({ input_tokens: 4, output_tokens: 3 })
    expect(after.some(r => r.uuid === 'thinking' || r.uuid === 'interruption')).toBe(false)
    expect(latestEditableUser(after)?.uuid).toBe('replacement')
  })

  test('qualification and replacement preserve the exact UTF-8 prefix and unrelated raw lines', () => {
    const prefix = '  { "type" : "user", "uuid" : "earlier", "message" : { "content" : "历史🙂" } }\r\n\r\n'
    const metadata = '{ "type" : "custom-title", "customTitle" : "keep raw spacing" }\r\n'
    const original = JSON.stringify({ ...user('original'), parentUuid: 'earlier' }) + '\r\n'
    const marked = rewriteUserMessageTranscript(prefix + original + '\n' + metadata, 'original')
    expect(marked.startsWith(prefix)).toBe(true)
    expect(marked.endsWith('\n' + metadata)).toBe(true)
    const replaced = rewriteUserMessageTranscript(marked, 'original', [user('replacement')])
    expect(replaced.startsWith(prefix)).toBe(true)
    expect(replaced.endsWith('\n' + metadata)).toBe(true)
    expect(Buffer.byteLength(replaced.slice(0, prefix.length), 'utf8')).toBe(Buffer.byteLength(prefix, 'utf8'))
  })
})

import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as storage from './sessionStorage.js'
import { relinkDeferredApiRetries } from './apiRetryTranscript.js'

const root = resolve(import.meta.dir, '../../test')
mkdirSync(root, { recursive: true })
const sandbox = mkdtempSync(join(root, 'error-resume-'))
const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
afterAll(() => {
  storage.resetProjectForTesting()
  if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
  rmSync(sandbox, { recursive: true, force: true })
})

function message(type: string, parentUuid: string | null, tick: number, extra = {}) {
  return { parentUuid, isSidechain: false, type, uuid: randomUUID(), timestamp: new Date(tick * 1000).toISOString(),
    sessionId: '11111111-1111-4111-8111-111111111111',
    message: { role: type, content: [{ type: 'text', text: `message-${tick}` }] }, ...extra } as any
}

test('retry progress stays out of logging and the parent chain; terminal errors remain', () => {
  const retry = message('system', null, 1, { subtype: 'api_error' })
  const terminal = message('assistant', null, 2, { isApiErrorMessage: true })
  expect(storage.cleanMessagesForLogging([retry, terminal])).toEqual([terminal])
  expect(storage.isChainParticipant(retry)).toBe(false)
})

test('late retry progress cannot fork the next recorded turn away from accepted replies', async () => {
  storage.resetProjectForTesting()
  const file = join(sandbox, 'writer.jsonl')
  writeFileSync(file, '')
  storage.setSessionFileForTesting(file)
  const user = message('user', null, 1)
  const retry = message('system', user.uuid, 2, { subtype: 'api_error' })
  const reply = message('assistant', user.uuid, 3)
  const error = message('assistant', reply.uuid, 4, { isApiErrorMessage: true })
  // Live Message objects have no serialized parentUuid. The writer assigns it.
  for (const entry of [user, retry, reply, error]) delete entry.parentUuid
  await storage.recordTranscript([user, reply, error])
  const next = message('user', error.uuid, 5)
  delete next.parentUuid
  await storage.recordTranscript([user, retry, reply, error, next])
  await storage.flushSessionStorage()
  const records = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(records.find(r => r.uuid === next.uuid).parentUuid).toBe(error.uuid)
  expect(records.some(r => r.subtype === 'api_error')).toBe(false)
})

for (const large of [false, true]) {
  test(`legacy deferred retry batch restores the pre-error branch (${large ? 'large' : 'small'})`, async () => {
    const first = message('user', null, 1)
    const reply = message('assistant', first.uuid, 4)
    const tool = message('user', reply.uuid, 5)
    const error = message('assistant', tool.uuid, 6, { isApiErrorMessage: true })
    const retry1 = message('system', first.uuid, 2, { subtype: 'api_error' })
    const retry2 = message('system', retry1.uuid, 3, { subtype: 'api_error' })
    const next = message('user', retry2.uuid, 7)
    const records = [first, reply, tool, error, retry1, retry2, next]
    if (large) reply.message.content[0].text = 'x'.repeat(6 * 1024 * 1024)
    const file = join(sandbox, `legacy-${large}.jsonl`)
    const raw = records.map(r => JSON.stringify(r)).join('\n') + '\n'
    writeFileSync(file, raw)
    const { messages } = await storage.loadTranscriptFile(file)
    const chain = storage.buildConversationChain(messages, messages.get(next.uuid)!)
    expect(chain.filter(m => m.type !== 'system').map(m => m.uuid)).toEqual([first, reply, tool, error, next].map(m => m.uuid))
    expect(readFileSync(file, 'utf8')).toBe(raw)
  })
}

test('legacy retry repair does not join intentional forks or another agent scope', async () => {
  const root = message('user', null, 1)
  const branch = message('assistant', root.uuid, 2)
  const alternate = message('user', null, 3)
  const retry = message('system', branch.uuid, 2, { subtype: 'api_error' })
  const next = message('user', retry.uuid, 4)
  const file = join(sandbox, 'fork.jsonl')
  writeFileSync(file, [root, branch, alternate, retry, next].map(r => JSON.stringify(r)).join('\n'))
  const { messages } = await storage.loadTranscriptFile(file)
  expect(storage.buildConversationChain(messages, messages.get(next.uuid)!).map(m => m.uuid)).toEqual([root, branch, retry, next].map(m => m.uuid))
})

test('legacy repair rejects sibling forks, cross-scope paths and a new cycle', () => {
  for (const mode of ['sibling', 'scope', 'cycle', 'compact']) {
    const root = message('user', null, 1)
    const retry = message('system', root.uuid, 2, { subtype: 'api_error' })
    const middle = message('assistant', root.uuid, 3,
      mode === 'scope' ? { isSidechain: true, agentId: 'other' } :
      mode === 'compact' ? { type: 'system', subtype: 'compact_boundary' } : {})
    const prior = message('assistant', mode === 'cycle' ? retry.uuid : mode === 'sibling' ? root.uuid : middle.uuid, 4)
    const map = new Map([root, middle, prior, retry].map(entry => [entry.uuid, entry]))
    relinkDeferredApiRetries(map)
    expect(map.get(retry.uuid)!.parentUuid).toBe(root.uuid)
  }
})

test('legacy repair accepts parallel tool-result siblings', () => {
  const root = message('user', null, 1)
  const assistant = message('assistant', root.uuid, 3)
  const result = (id: string) => ({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
  const one = message('user', assistant.uuid, 4, result('one'))
  const two = message('user', assistant.uuid, 5, result('two'))
  const terminal = message('assistant', two.uuid, 6, { isApiErrorMessage: true })
  const retry = message('system', root.uuid, 2, { subtype: 'api_error' })
  const map = new Map([root, assistant, one, two, terminal, retry].map(entry => [entry.uuid, entry]))
  relinkDeferredApiRetries(map)
  expect(map.get(retry.uuid)!.parentUuid).toBe(terminal.uuid)
})

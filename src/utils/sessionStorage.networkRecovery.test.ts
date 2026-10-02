import { test, expect, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import * as storage from './sessionStorage.js'

const testRoot = resolve(import.meta.dir, '../../test')
mkdirSync(testRoot, { recursive: true })
const sandbox = mkdtempSync(join(testRoot, 'network-storage-'))
const previous = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
afterAll(() => {
  storage.resetProjectForTesting()
  if (previous === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previous
  rmSync(sandbox, { recursive: true, force: true })
})

test('tombstone prevents queued and later-recorded orphan blocks from returning to disk', async () => {
  storage.resetProjectForTesting()
  const path = join(sandbox, 'tombstone.jsonl')
  writeFileSync(path, '')
  storage.setSessionFileForTesting(path)
  const orphan = { type: 'assistant', uuid: '12345678-1234-1234-1234-123456789012', timestamp: new Date().toISOString(), message: { id: 'orphan-message', role: 'assistant', type: 'message', model: 'test', content: [{ type: 'text', text: 'orphan' }], usage: { input_tokens: 1, output_tokens: 1 } } } as any
  await storage.recordTranscript([orphan])
  await storage.removeTranscriptMessage(orphan.uuid)
  await storage.flushSessionStorage()
  await storage.recordTranscript([orphan])
  await storage.flushSessionStorage()
  expect(readFileSync(path, 'utf8')).not.toContain('orphan')
})

test('retry usage is an independent metadata fact outside the parent message chain', async () => {
  storage.resetProjectForTesting()
  const path = join(sandbox, 'usage.jsonl')
  writeFileSync(path, '')
  storage.setSessionFileForTesting(path)
  const writer = (storage as any).recordNetworkRetryUsage
  expect(typeof writer).toBe('function')
  await writer('test', { input_tokens: 7, output_tokens: 27 })
  await storage.flushSessionStorage()
  const entries = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const entry = entries.find(entry => entry.type === 'network-retry-usage')
  expect(entry.message.usage).toEqual({ input_tokens: 7, output_tokens: 27 })
  expect(entry.message.id).toBe('network-retry-' + entry.uuid)
  expect(entry.parentUuid).toBeUndefined()
})

test('retained tool correction shares the original API message identity without joining its chain', async () => {
  storage.resetProjectForTesting()
  const path = join(sandbox, 'correction.jsonl')
  writeFileSync(path, '')
  storage.setSessionFileForTesting(path)
  const source = { messageId: 'provider-request-one', messageUuid: '11111111-1111-1111-1111-111111111111' }
  await (storage.recordNetworkRetryUsage as any)('test', { input_tokens: 7, output_tokens: 27 }, source)
  await storage.flushSessionStorage()
  const entry = JSON.parse(readFileSync(path, 'utf8').trim())
  expect(entry.message.id).toBe(source.messageId)
  expect(entry.sourceUuid).toBe(source.messageUuid)
  expect(entry.uuid).not.toBe(source.messageUuid)
  expect(entry.parentUuid).toBeUndefined()
})

test('concurrent tombstones preserve unrelated tail entries and concurrent appends', async () => {
  for (let iteration = 0; iteration < 20; iteration++) {
    storage.resetProjectForTesting()
    const path = join(sandbox, 'concurrent.jsonl')
    const entries = [
      { type: 'assistant', uuid: '11111111-1111-1111-1111-111111111111', message: { content: 'first orphan' } },
      { type: 'assistant', uuid: '22222222-2222-2222-2222-222222222222', message: { content: 'second orphan' } },
      { type: 'assistant', uuid: '33333333-3333-3333-3333-333333333333', message: { content: 'keep tail' } },
    ]
    writeFileSync(path, entries.map(entry => JSON.stringify(entry) + '\n').join(''))
    storage.setSessionFileForTesting(path)
    await Promise.all([
      storage.removeTranscriptMessage(entries[0].uuid as any),
      storage.removeTranscriptMessage(entries[1].uuid as any),
      storage.recordNetworkRetryUsage('test', { input_tokens: 7, output_tokens: 27 }).then(() => storage.flushSessionStorage()),
      (async () => {
        await Bun.sleep(0)
        await storage.saveCustomTitle('33333333-3333-3333-3333-333333333333' as any, 'keep title', path)
      })(),
    ])
    await storage.flushSessionStorage()
    const persisted = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(persisted.filter(entry => entry.type === 'assistant')).toEqual([entries[2]])
    expect(persisted.filter(entry => entry.type === 'network-retry-usage')).toHaveLength(1)
    expect(persisted.filter(entry => entry.type === 'custom-title')).toHaveLength(1)
  }
})

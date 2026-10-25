import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import * as storage from './sessionStorage.js'

const root = resolve(import.meta.dir, '../../test')
mkdirSync(root, { recursive: true })
const sandbox = mkdtempSync(join(root, 'user-message-edit-'))
const previous = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
beforeEach(() => storage.resetProjectForTesting())
afterAll(() => {
  storage.resetProjectForTesting()
  if (previous === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previous
  rmSync(sandbox, { recursive: true, force: true })
})

test('replacement drains queued transcript writes and records the prepared prompt exactly once', async () => {
  const file = join(sandbox, 'queued.jsonl')
  writeFileSync(file, '')
  storage.setSessionFileForTesting(file)
  const uuid = randomUUID()
  await storage.recordTranscript([{ type: 'user', uuid, timestamp: new Date().toISOString(), message: { content: 'old' } }])
  await storage.markUserMessageReplaceable(uuid)
  const next = randomUUID()
  const prepared = { type: 'user', uuid: next, timestamp: new Date().toISOString(), message: { content: 'new' } } as any
  await storage.replaceUserMessageTranscript(uuid, [prepared])
  // A subsequent ordinary writer sees the already committed UUID and does not duplicate it.
  await storage.recordTranscript([prepared])
  await storage.flushSessionStorage()
  const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(records.filter(record => record.type === 'user').map(record => [record.uuid, record.message.content])).toEqual([[next, 'new']])
  expect(records[0].userMessageEditState).toBeUndefined()
})

test('invalid durable target leaves the file byte-for-byte unchanged', async () => {
  const file = join(sandbox, 'stale.jsonl')
  const raw = JSON.stringify({ type: 'user', uuid: randomUUID(), message: { content: 'existing' } }) + '\n'
  writeFileSync(file, raw)
  storage.setSessionFileForTesting(file)
  await expect(storage.replaceUserMessageTranscript(randomUUID(), [{ type: 'user', uuid: randomUUID(), message: { content: 'new' } }])).rejects.toThrow()
  expect(readFileSync(file, 'utf8')).toBe(raw)
})

test('durable replacement accepts CRLF and whitespace-only lines without changing the historical prefix', async () => {
  const file = join(sandbox, 'crlf-whitespace.jsonl')
  const earlier = randomUUID(), target = randomUUID(), next = randomUUID()
  const prefix = JSON.stringify({ type: 'user', uuid: earlier, message: { content: '历史🙂' } }) + '\r\n\r\n \t \r\n'
  const original = JSON.stringify({ type: 'user', uuid: target, parentUuid: earlier, message: { content: 'old' } }) + '\r\n'
  writeFileSync(file, prefix + original)
  storage.setSessionFileForTesting(file)
  await storage.markUserMessageReplaceable(target)
  await storage.replaceUserMessageTranscript(target, [{ type: 'user', uuid: next, message: { content: 'new' } }])
  await storage.flushSessionStorage()
  const actual = readFileSync(file, 'utf8')
  expect(actual.startsWith(prefix)).toBe(true)
  const records = actual.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  expect(records.map(record => [record.uuid, record.message.content])).toEqual([[earlier, '历史🙂'], [next, 'new']])
  expect(records[1].parentUuid).toBe(earlier)
})

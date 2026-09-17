// getLeaderModel — the lead's EFFECTIVE model for teammate spawns. All three
// spawn handlers used to read the RAW mainLoopModel field, so a lead that had
// switched models in-session spawned teammates on the stale global model.
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { test, expect, afterAll } from 'bun:test'

// Fixed sandbox path, rebuilt at load (see useMainLoopModel.test.ts for why:
// bun test neither runs process exit handlers nor tolerates afterAll dir
// deletion once sibling files captured lockfile paths under the dir).
const TMP = join(tmpdir(), 'doge-spawnmodel-test-sandbox')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = TMP
// getDefaultMainLoopModel() bottoms out in the auth chain, which throws when
// no key is resolvable — give the empty sandbox a dummy key.
const savedKey = process.env.DOGE_API_KEY
process.env.DOGE_API_KEY = savedKey ?? 'sk-test-dummy-spawnmodel'

const { getLeaderModel } = await import('./spawnMultiAgent.js')

// Restore env BETWEEN files (a leaked dummy key breaks sibling tests that
// assert env-key priority, e.g. restoreTierState "heals wiped credentials").
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (savedKey === undefined) delete process.env.DOGE_API_KEY
  else process.env.DOGE_API_KEY = savedKey
})

test('session override outranks the global slot', () => {
  expect(
    getLeaderModel({
      mainLoopModel: 'kimi-k3',
      mainLoopModelForSession: 'glm-5',
    } as never),
  ).toBe('glm-5')
})

test('global slot used when no session override', () => {
  expect(
    getLeaderModel({
      mainLoopModel: 'kimi-k3',
      mainLoopModelForSession: null,
    } as never),
  ).toBe('kimi-k3')
})

test('both slots empty resolves the configured default without throwing', () => {
  const out = getLeaderModel({
    mainLoopModel: null,
    mainLoopModelForSession: null,
  } as never)
  expect(typeof out).toBe('string')
  expect(out.length).toBeGreaterThan(0)
  expect(out).not.toBe('haiku')
})

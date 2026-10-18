import { test, expect } from 'bun:test'
import matrix from './effortMatrix.json'
import { planEffortWire } from './effortGateway.js'
import { EFFORT_LEVELS } from './effortCapabilities.js'

/**
 * Cross-repo contract: App `tools/check-effort-matrix-sync.mjs` runs the same
 * JSON cases against its own gateway mapper. Keep implementations in sync
 * rather than duplicating expectations by hand on each side.
 */
test('shared effort matrix declares the full ladder and all maps', () => {
  expect(matrix.levels).toEqual([...EFFORT_LEVELS])
  for (const [name, map] of Object.entries(matrix.maps)) {
    expect(Object.keys(map).sort(), name).toEqual([...EFFORT_LEVELS].sort())
    for (const level of EFFORT_LEVELS) {
      expect(typeof map[level].wire, `${name}.${level}.wire`).toBe('string')
      expect(EFFORT_LEVELS).toContain(map[level].applied)
    }
  }
  for (const level of EFFORT_LEVELS) {
    expect(matrix.qwenBudgets[level]).toBeGreaterThan(0)
  }
})

test('CLI gateway mapper satisfies every shared matrix case', () => {
  for (const testCase of matrix.cases) {
    const plan = planEffortWire({
      model: testCase.model,
      protocol: testCase.protocol as 'anthropic' | 'openai' | 'responses',
      baseURL: testCase.baseURL,
      requested: testCase.requested as
        | 'low'
        | 'medium'
        | 'high'
        | 'xhigh'
        | 'max',
    })
    const expected = testCase.expect as {
      gateway: string
      wireEffort?: string | null
      applied?: string | null
      downgraded?: boolean
      reason?: string
      extraBody?: Record<string, unknown>
    }
    expect(plan.gateway, testCase.name).toBe(expected.gateway)
    expect(plan.wireEffort ?? null, testCase.name).toBe(
      expected.wireEffort ?? null,
    )
    expect(plan.applied ?? null, testCase.name).toBe(expected.applied ?? null)
    if (expected.downgraded !== undefined) {
      expect(plan.downgraded, testCase.name).toBe(expected.downgraded)
    }
    if (expected.reason) expect(plan.reason, testCase.name).toBe(expected.reason)
    if (expected.extraBody) {
      expect(plan.extraBody, testCase.name).toEqual(expected.extraBody)
    }
  }
})

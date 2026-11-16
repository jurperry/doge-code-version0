import { describe, expect, test } from 'bun:test'
import { FIRST_FORM_STEP, STEP_ORDER } from './provider-form.js'

describe('/provider form flow', () => {
  test('opens on the first step of the flow (Provider name)', () => {
    // The form used to open on 'provider' (API format): STEP_ORDER gained
    // 'name' at its head but the initial state kept the old value.
    expect(FIRST_FORM_STEP).toBe(STEP_ORDER[0])
    expect(FIRST_FORM_STEP).toBe('name')
  })

  test('step order is the documented 1-11 sequence ending in review', () => {
    expect(STEP_ORDER).toEqual([
      'name',
      'provider',
      'baseURL',
      'apiKey',
      'authTokenType',
      'model',
      'contextWindow',
      'opus',
      'sonnet',
      'haiku',
      'review',
    ])
    expect(STEP_ORDER).toHaveLength(11)
  })
})

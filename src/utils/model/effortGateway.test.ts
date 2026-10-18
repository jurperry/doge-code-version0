import { test, expect } from 'bun:test'
import { planEffortWire } from './effortGateway.js'

const OPENAI = { protocol: 'openai' as const, baseURL: 'https://api.deepseek.com' }

test('official Anthropic and OpenAI endpoints pass levels through', () => {
  expect(
    planEffortWire({ model: 'claude-opus-4-8', requested: 'xhigh', protocol: 'anthropic', baseURL: 'https://api.anthropic.com' }),
  ).toMatchObject({ gateway: 'anthropic', wireEffort: 'xhigh', applied: 'xhigh', downgraded: false })

  expect(
    planEffortWire({ model: 'gpt-5.6', requested: 'max', protocol: 'openai', baseURL: 'https://api.openai.com' }),
  ).toMatchObject({ gateway: 'openai', wireEffort: 'max', applied: 'max', downgraded: false })
})

test('DeepSeek maps our ladder onto none/low/high/max', () => {
  expect(planEffortWire({ model: 'deepseek-v4-pro', requested: 'medium', ...OPENAI })).toMatchObject({
    gateway: 'deepseek',
    wireEffort: 'high',
    applied: 'high',
    downgraded: true,
  })
  expect(planEffortWire({ model: 'deepseek-v4-pro', requested: 'xhigh', ...OPENAI })).toMatchObject({
    wireEffort: 'high',
    applied: 'high',
  })
  expect(planEffortWire({ model: 'deepseek-v4-pro', requested: 'max', ...OPENAI })).toMatchObject({
    wireEffort: 'max',
    applied: 'max',
  })
})

test('DeepSeek Anthropic endpoint has no effort strength above max/high', () => {
  expect(
    planEffortWire({
      model: 'deepseek-v4-pro',
      requested: 'xhigh',
      protocol: 'anthropic',
      baseURL: 'https://api.deepseek.com/anthropic',
    }),
  ).toMatchObject({ gateway: 'deepseek', wireEffort: 'high', applied: 'high' })
})

test('GLM 5.3 only accepts low/high/max', () => {
  const base = { model: 'glm-5.3', protocol: 'openai' as const, baseURL: 'https://open.bigmodel.cn/api/paas/v4' }
  expect(planEffortWire({ requested: 'medium', ...base })).toMatchObject({ gateway: 'glm', wireEffort: 'high', applied: 'high' })
  expect(planEffortWire({ requested: 'xhigh', ...base })).toMatchObject({ wireEffort: 'max', applied: 'max' })
})

test('GLM 5.2 maps low/medium → high and xhigh → max server-side', () => {
  const base = { model: 'glm-5.2', protocol: 'openai' as const, baseURL: 'https://open.bigmodel.cn/api/paas/v4' }
  expect(planEffortWire({ requested: 'xhigh', ...base })).toMatchObject({ wireEffort: 'xhigh', applied: 'max', downgraded: true })
  expect(planEffortWire({ requested: 'medium', ...base })).toMatchObject({ wireEffort: 'medium', applied: 'high', downgraded: true })
})

test('Kimi k3 accepts low/high/max; forced-thinking variants cannot tune effort', () => {
  const base = { protocol: 'openai' as const, baseURL: 'https://api.moonshot.cn/v1' }
  expect(planEffortWire({ model: 'kimi-k3', requested: 'medium', ...base })).toMatchObject({ gateway: 'kimi', wireEffort: 'high', applied: 'high' })
  const forced = planEffortWire({ model: 'kimi-k2.7-code', requested: 'high', ...base })
  expect(forced.gateway).toBe('kimi')
  expect(forced.wireEffort).toBeUndefined()
  expect(forced.applied).toBeUndefined()
  expect(forced.reason).toBe('gateway-unsupported')
})

test('Qwen Anthropic endpoint maps by underlying model family', () => {
  const base = { protocol: 'anthropic' as const, baseURL: 'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy' }
  expect(planEffortWire({ model: 'qwen3.8-max', requested: 'high', ...base })).toMatchObject({
    gateway: 'qwen',
    wireEffort: 'xhigh',
    applied: 'xhigh',
    downgraded: true,
  })
  expect(planEffortWire({ model: 'glm-5.3', requested: 'xhigh', ...base })).toMatchObject({
    gateway: 'qwen',
    wireEffort: 'max',
    applied: 'max',
  })
})

test('Qwen OpenAI endpoint uses enable_thinking + thinking_budget', () => {
  const plan = planEffortWire({
    model: 'qwen3.8-max',
    requested: 'high',
    protocol: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  })
  expect(plan.gateway).toBe('qwen')
  expect(plan.wireEffort).toBeUndefined()
  expect(plan.extraBody).toEqual({ enable_thinking: true, thinking_budget: 16384 })
  expect(plan.applied).toBe('high')
})

test('Qwen budget is capped by the output-token ceiling and respects disabled thinking', () => {
  const base = {
    model: 'qwen3.8-max',
    protocol: 'openai' as const,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  }
  const capped = planEffortWire({ ...base, requested: 'high', maxOutputTokens: 8000 })
  expect((capped.extraBody as Record<string, unknown>).thinking_budget).toBe(6976)

  const disabled = planEffortWire({ ...base, requested: 'max', thinkingEnabled: false })
  expect(disabled.extraBody).toBeUndefined()
  expect(disabled.applied).toBeUndefined()
})

test('xAI has no max; only 4.6+ expose xhigh; OpenRouter follows the full ladder', () => {
  expect(
    planEffortWire({ model: 'grok-4.6', requested: 'max', protocol: 'openai', baseURL: 'https://api.x.ai/v1' }),
  ).toMatchObject({ gateway: 'xai', wireEffort: 'xhigh', applied: 'xhigh', downgraded: true })
  expect(
    planEffortWire({ model: 'grok-4.5', requested: 'max', protocol: 'openai', baseURL: 'https://api.x.ai/v1' }),
  ).toMatchObject({ gateway: 'xai', wireEffort: 'high', applied: 'high' })
  expect(
    planEffortWire({ model: 'anthropic/claude-opus-4-8', requested: 'max', protocol: 'openai', baseURL: 'https://openrouter.ai/api/v1' }),
  ).toMatchObject({ gateway: 'openrouter', wireEffort: 'max', applied: 'max' })
})

test('unknown custom gateways pass through and auto means no wire value', () => {
  expect(
    planEffortWire({ model: 'mystery-model', requested: 'high', protocol: 'openai', baseURL: 'https://gw.example.test' }),
  ).toMatchObject({ gateway: 'generic', wireEffort: 'high', applied: 'high' })
  const auto = planEffortWire({
    model: 'claude-opus-4-8',
    requested: undefined,
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com',
  })
  expect(auto.wireEffort).toBeUndefined()
  expect(auto.applied).toBeUndefined()
  expect(auto.downgraded).toBe(false)
})

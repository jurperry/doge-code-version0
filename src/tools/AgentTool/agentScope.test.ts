import { expect, test } from 'bun:test'
import { scopedAgentDefinitions } from './agentScope.js'

test('Agent(Explore) carries its restriction into nested agent options', () => {
  const definitions = { activeAgents: [], allAgents: [] }
  expect(scopedAgentDefinitions(definitions, ['Explore']).allowedAgentTypes).toEqual(['Explore'])
  expect(scopedAgentDefinitions({ ...definitions, allowedAgentTypes: ['Explore', 'worker'] }, ['Explore', 'general-purpose']).allowedAgentTypes).toEqual(['Explore'])
  expect(scopedAgentDefinitions({ ...definitions, allowedAgentTypes: ['worker'] }, ['Explore']).allowedAgentTypes).toEqual([])
  expect(scopedAgentDefinitions(definitions, undefined)).toBe(definitions)
})

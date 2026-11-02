import { expect, test } from 'bun:test'
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { ensureBootstrapMacro } from '../../bootstrapMacro.js'

ensureBootstrapMacro()
const { validateWebSearchResponse } = await import('./WebSearchTool.js')

function output(results: Array<string | { content: unknown[] }>) {
  return {
    query: 'query',
    results: results as never,
    durationSeconds: 0,
  }
}

test('native web search error blocks fail instead of becoming successful commentary', () => {
  const blocks = [{
    type: 'web_search_tool_result',
    tool_use_id: 'search_1',
    content: { error_code: 'unavailable' },
  }] as unknown as BetaContentBlock[]
  expect(() =>
    validateWebSearchResponse(
      blocks,
      output(['Web search error: unavailable']),
      false,
    ),
  ).toThrow('Web search failed: unavailable')
})

test('server_tool_use plus commentary is not sufficient search evidence', () => {
  const blocks = [{
    type: 'server_tool_use',
    id: 'search_1',
    name: 'web_search',
    input: { query: 'query' },
  }] as unknown as BetaContentBlock[]
  expect(() =>
    validateWebSearchResponse(blocks, output(['I cannot search']), false),
  ).toThrow('no verifiable web search activity')
})

test('an empty completed search with explanatory text remains a valid response', () => {
  const blocks = [{
    type: 'web_search_tool_result',
    tool_use_id: 'search_1',
    content: [],
  }] as unknown as BetaContentBlock[]
  expect(() =>
    validateWebSearchResponse(blocks, output(['No matching pages found.']), false),
  ).not.toThrow()
})

test('a completed search with neither hits nor text fails as an empty result', () => {
  const blocks = [{
    type: 'web_search_tool_result',
    tool_use_id: 'search_1',
    content: [],
  }] as unknown as BetaContentBlock[]
  expect(() => validateWebSearchResponse(blocks, output([]), false)).toThrow(
    'Web search failed: the current API endpoint returned no search results',
  )
})

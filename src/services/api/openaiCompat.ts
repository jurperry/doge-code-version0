import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

type AnyBlock = Record<string, unknown>

type OpenAICompatConfig = {
  apiKey: string
  baseURL: string
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
}

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type OpenAIImageURLPart = {
  type: 'image_url'
  image_url: { url: string }
}

type OpenAIContentPart = { type: 'text'; text: string } | OpenAIImageURLPart

type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<OpenAIContentPart> | null
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

export type OpenAIChatRequest = {
  model: string
  messages: OpenAIChatMessage[]
  stream?: boolean
  temperature?: number
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description?: string
      parameters?: unknown
    }
  }>
  tool_choice?: 'auto' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  // Chat Completions-native web search knob (e.g. gpt-4o-search-preview).
  web_search_options?: {
    search_context_size?: 'low' | 'medium' | 'high'
  }
}

type OpenAIStreamChunk = {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: 'assistant'
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
      // gpt-4o-search-preview style citations; some providers only emit
      // these on the final chunk.
      annotations?: Array<{
        type?: string
        url_citation?: {
          url?: string
          title?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    // Cache-hit fields across OpenAI-compatible vendors (all subsets of
    // prompt_tokens): prompt_tokens_details.cached_tokens (OpenAI/GLM/Qwen/
    // DeepSeek details form), top-level prompt_cache_hit_tokens (DeepSeek),
    // top-level cached_tokens (Kimi legacy). Writes: cache_write_tokens (Kimi)
    // / cache_creation_input_tokens (Qwen explicit cache).
    prompt_cache_hit_tokens?: number
    cached_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
      cache_write_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

/** Vendor cache fields → anthropic-shape pair. cached ⊆ prompt_tokens, so
 *  input_tokens must exclude the cached/written parts to keep the input-side
 *  total (= prompt_tokens) unchanged for updateUsage/cost tracking. */
function openaiUsageCache(usage: OpenAIStreamChunk['usage']): { cacheRead: number; cacheWrite: number } {
  if (!usage) return { cacheRead: 0, cacheWrite: 0 }
  const details = usage.prompt_tokens_details
  const read = details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens
  const write = details?.cache_write_tokens ?? details?.cache_creation_input_tokens
  const pos = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)
  return { cacheRead: pos(read), cacheWrite: pos(write) }
}

export function joinBaseUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/$/, '')}${path}`
}

export function contentToText(content: BetaMessageParam['content']): string {
  if (typeof content === 'string') return content
  return content
    .map(block => {
      if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
      if (block.type === 'tool_result') {
        return typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content)
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function toBlocks(content: BetaMessageParam['content']): AnyBlock[] {
  return Array.isArray(content)
    ? (content as unknown as AnyBlock[])
    : [{ type: 'text', text: content }]
}

// Convert an Anthropic image block to a URL string usable by both OpenAI
// protocols: base64 sources become data: URLs, url sources pass through.
// Returns undefined for non-image blocks or malformed sources.
export function imageBlockToImageURL(block: AnyBlock): string | undefined {
  if (block.type !== 'image') return undefined
  const source = block.source
  if (!source || typeof source !== 'object') return undefined
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType =
      typeof source.media_type === 'string' ? source.media_type : 'image/png'
    return `data:${mediaType};base64,${source.data}`
  }
  if (source.type === 'url' && typeof source.url === 'string') return source.url
  return undefined
}

// Tool-result content must be plain text in both OpenAI protocols; images
// cannot ride inside tool messages. Split an Anthropic tool_result content
// into its textual part and image URL list so callers can emit the images as
// a follow-up user message.
export function splitToolResultContent(content: unknown): {
  text: string
  imageURLs: string[]
} {
  if (typeof content === 'string') return { text: content, imageURLs: [] }
  if (!Array.isArray(content)) return { text: '', imageURLs: [] }
  const texts: string[] = []
  const imageURLs: string[] = []
  for (const block of content as AnyBlock[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
      continue
    }
    const url = imageBlockToImageURL(block)
    if (url) imageURLs.push(url)
  }
  return { text: texts.join('\n'), imageURLs }
}

function getToolDefinitions(tools?: BetaToolUnion[]): OpenAIChatRequest['tools'] {
  if (!tools || tools.length === 0) return undefined
  const mapped = tools.flatMap(tool => {
    const record = tool as unknown as Record<string, unknown>
    // Anthropic server-side web search is not a callable function tool.
    // Converting it would produce a parameterless function and lose all
    // search semantics — it is mapped to web_search_options instead.
    if (record.type === 'web_search_20250305') return []
    const name = typeof record.name === 'string' ? record.name : undefined
    if (!name) return []
    return [{
      type: 'function' as const,
      function: {
        name,
        description:
          typeof record.description === 'string' ? record.description : undefined,
        parameters: record.input_schema,
      },
    }]
  })
  return mapped.length > 0 ? mapped : undefined
}

export function convertAnthropicRequestToOpenAI(input: {
  model: string
  system?: string | Array<{ type?: string; text?: string }>
  messages: BetaMessageParam[]
  tools?: BetaToolUnion[]
  tool_choice?: BetaToolChoiceAuto | BetaToolChoiceTool
  temperature?: number
  max_tokens?: number
  output_config?: { effort?: string }
}): OpenAIChatRequest {
  // Trust the model from the query engine's resolution chain (which already
  // accounts for /model overrides, settings, and env vars). Do NOT re-read
  // process.env.ANTHROPIC_MODEL here — that would ignore mid-session switches.
  const rawModel = input.model
  // Strip [1m]/[2m] suffixes — same normalization as Anthropic native path (model.ts)
  const targetModel = rawModel.replace(/\[(1|2)m\]/gi, '')
  const messages: OpenAIChatMessage[] = []

  if (input.system) {
    const systemText = Array.isArray(input.system)
      ? input.system.map(block => block.text ?? '').join('\n')
      : input.system
    if (systemText) messages.push({ role: 'system', content: systemText })
  }

  for (const message of input.messages) {
    if (message.role === 'user') {
      const blocks = toBlocks(message.content)

      const toolResults = blocks.filter(block => block.type === 'tool_result')
      for (const result of toolResults) {
        const toolUseId =
          typeof result.tool_use_id === 'string' ? result.tool_use_id : undefined
        const { text, imageURLs } = splitToolResultContent(result.content)
        const hasImages = imageURLs.length > 0
        // Chat Completions tool messages are text-only. Images are emitted as
        // a follow-up user message right below; JSON.stringify would send raw
        // base64 as text, which the model cannot interpret as an image.
        const toolContent = text
          ? text
          : hasImages
            ? '(tool returned image content)'
            : JSON.stringify(result.content)
        messages.push({
          role: 'tool',
          tool_call_id: toolUseId,
          content: toolContent,
        })
        if (hasImages) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `[Images returned by tool call ${toolUseId ?? ''}]`,
              },
              ...imageURLs.map(url => ({
                type: 'image_url' as const,
                image_url: { url },
              })),
            ],
          })
        }
      }

      const nonToolBlocks = blocks.filter(block => block.type !== 'tool_result')
      const imageURLs = nonToolBlocks
        .map(block => imageBlockToImageURL(block))
        .filter((url): url is string => url !== undefined)
      const text = contentToText(
        nonToolBlocks as unknown as BetaMessageParam['content'],
      )
      if (imageURLs.length > 0) {
        // Multimodal user content: text + image_url parts. Text-only requests
        // keep the plain string content for maximal gateway compatibility.
        messages.push({
          role: 'user',
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...imageURLs.map(url => ({
              type: 'image_url' as const,
              image_url: { url },
            })),
          ],
        })
      } else if (text) {
        messages.push({ role: 'user', content: text })
      }
      continue
    }

    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content)
        ? (message.content as unknown as AnyBlock[])
        : []
      const text = blocks
        .filter(block => block.type === 'text')
        .map(block => (typeof block.text === 'string' ? block.text : ''))
        .join('')

      // Extract reasoning_content from thinking blocks (DeepSeek compat)
      const reasoningText = blocks
        .filter(block => block.type === 'thinking')
        .map(block => (typeof block.thinking === 'string' ? block.thinking : ''))
        .join('')

      const toolCalls = blocks
        .filter(block => block.type === 'tool_use')
        .map(block => ({
          id: String(block.id),
          type: 'function' as const,
          function: {
            name: String(block.name),
            arguments:
              typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input ?? {}),
          },
        }))

      messages.push({
        role: 'assistant',
        content: text || null,
        ...(reasoningText ? { reasoning_content: reasoningText } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
  }

  // Handle model-specific max_tokens limits
  let maxTokens = input.max_tokens
  // DeepSeek API has a max_tokens limit of 8192, can be adjusted to 32000 for newer models
  if (maxTokens && maxTokens > 32000 && process.env.ANTHROPIC_BASE_URL?.includes('deepseek')) {
    maxTokens = 32000
  }

  // Anthropic's server-side web_search tool has no function equivalent in
  // Chat Completions; map it to the native web_search_options knob instead.
  // allowed_domains / blocked_domains have no Chat Completions counterpart
  // and are silently ignored.
  const webSearchTool = input.tools?.find(
    tool =>
      (tool as unknown as Record<string, unknown>).type ===
      'web_search_20250305',
  ) as unknown as { name?: string; max_uses?: number | null } | undefined

  return {
    model: targetModel,
    messages,
    temperature: input.temperature,
    max_tokens: maxTokens,
    ...(getToolDefinitions(input.tools)
      ? { tools: getToolDefinitions(input.tools) }
      : {}),
    ...(webSearchTool
      ? {
          web_search_options: {
            search_context_size:
              (webSearchTool.max_uses ?? 0) >= 5
                ? ('high' as const)
                : ('medium' as const),
          },
        }
      : {}),
    // Drop tool_choice when it names the filtered-out server-side web_search
    // tool — emitting {type:'function', function:{name:'web_search'}} would
    // reference a tool that no longer exists in the request.
    ...(input.tool_choice?.type === 'tool' &&
    input.tool_choice.name !== webSearchTool?.name
      ? {
          tool_choice: {
            type: 'function' as const,
            function: { name: input.tool_choice.name },
          },
        }
      : input.tool_choice?.type === 'auto'
        ? { tool_choice: 'auto' as const }
        : {}),
    ...(input.output_config?.effort ? { effort: input.output_config.effort } : {}),
  }
}

// Some OpenAI-compatible gateways (e.g. opencode zen) wrap upstream provider
// outages in a 400/422 with a generic body like
// "Error from provider (Console Go): Upstream request failed" instead of
// passing through a 5xx. These are transient capacity/availability failures,
// not malformed requests — they must be retried like 5xx instead of
// surfacing as permanent request errors.
const TRANSIENT_UPSTREAM_PATTERN =
  /upstream request failed|upstream[^"]*(failed|failure|error|timeout|unavailable)|temporarily unavailable|overloaded|try again later/i

// Exported so responsesCompat can apply the same transient classification.
export function isTransientUpstreamError(status: number, responseText: string): boolean {
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return true
  }
  return (
    (status === 400 || status === 422) &&
    TRANSIENT_UPSTREAM_PATTERN.test(responseText)
  )
}

export async function createOpenAICompatStream(
  config: OpenAICompatConfig,
  request: OpenAIChatRequest,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  let response: Response
  try {
    response = await (config.fetch ?? globalThis.fetch)(
      joinBaseUrl(config.baseURL, '/v1/chat/completions'),
      {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          ...config.headers,
        },
        body: JSON.stringify({ ...request, stream: true }),
      },
    )
  } catch (error) {
    // Never convert an intentional abort into a retryable connection error.
    if (signal?.aborted) throw error
    // Network-level failure (DNS, reset, TLS). The Anthropic-native path gets
    // APIConnectionError from the SDK and withRetry retries it — give the
    // OpenAI-compatible path the same treatment.
    throw new APIConnectionError({
      message: `OpenAI compatible request connection error: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    })
  }

  if (!response.ok || !response.body) {
    let responseText = ''
    try {
      responseText = await response.text()
    } catch {
      responseText = ''
    }
    // Detect context length overflow from OpenAI-format APIs and throw
    // a standardized error that upstream PTL detection can recognize.
    // OpenAI-format APIs return errors like:
    //   - "context_length_exceeded" (OpenAI, DeepSeek code)
    //   - "maximum context length is XXXX tokens" (OpenAI, DeepSeek message)
    //   - "This model's maximum context length" (common pattern)
    //   - "too many tokens" (some providers)
    const isContextOverflow =
      response.status === 400 ||
      response.status === 413
    if (isContextOverflow) {
      const lowerResponse = responseText.toLowerCase()
      if (
        lowerResponse.includes('context_length_exceeded') ||
        lowerResponse.includes('context length') ||
        lowerResponse.includes('maximum context') ||
        lowerResponse.includes('too many tokens') ||
        lowerResponse.includes('token limit')
      ) {
        // Throw with "Prompt is too long" prefix so errors.ts PTL detection works
        throw new Error(`Prompt is too long: ${responseText}`)
      }
    }
    if (response.ok || isTransientUpstreamError(response.status, responseText)) {
      // Throw a real APIError so withRetry's shouldRetry() classification
      // applies (408/409/429/5xx are retryable there). A plain Error is NOT
      // an APIError instance and would abort the turn without any retry —
      // a single transient gateway blip used to kill the whole turn.
      // 408/409/429/5xx keep their native status; gateway 400/422
      // "upstream failed" wrappers (and ok-with-empty-body) map to 503.
      const normalizedStatus =
        response.ok || response.status === 400 || response.status === 422
          ? 503
          : response.status
      const detail = `OpenAI compatible request failed with status ${response.status}${responseText ? `: ${responseText}` : ''}`
      // Pass the body as the message (not as APIError.error) so the final
      // error text keeps the original gateway status and payload verbatim.
      throw new APIError(normalizedStatus, undefined, detail, response.headers)
    }
    throw new Error(
      `OpenAI compatible request failed with status ${response.status}${responseText ? `: ${responseText}` : ''}`,
    )
  }

  return response.body.getReader()
}

function parseSSEChunk(buffer: string): { events: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const remainder = parts.pop() ?? ''
  return { events: parts, remainder }
}

function mapFinishReason(reason: string | null | undefined): BetaMessage['stop_reason'] {
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

export async function* createAnthropicStreamFromOpenAI(input: {
  reader: ReadableStreamDefaultReader<Uint8Array>
  model: string
}): AsyncGenerator<BetaRawMessageStreamEvent, BetaMessage, void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let started = false
  let textStarted = false
  let textContentIndex: number | null = null
  let toolIndexByOpenAIIndex = new Map<number, number>()
  let nextContentIndex = 0
  let promptTokens = 0
  let completionTokens = 0
  // Vendor cache fields (DeepSeek/GLM/Kimi/Qwen) mapped into the anthropic
  // usage shape — zero until a chunk reports them.
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let emittedAnyContent = false
  // DeepSeek reasoning_content tracking
  let reasoningStarted = false
  let reasoningContentIndex: number | null = null
  let reasoningClosed = false
  const toolCallState = new Map<number, { id: string; name: string; arguments: string }>()
  // url_citation annotations accumulated across chunks (deduped by url) —
  // some providers only emit them on the final chunk.
  const urlCitations = new Map<string, string>()

  while (true) {
    const { done, value } = await input.reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parsed = parseSSEChunk(buffer)
    buffer = parsed.remainder

    for (const rawEvent of parsed.events) {
      const dataLines = rawEvent
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())

      for (const data of dataLines) {
        if (!data || data === '[DONE]') continue
        const chunk = JSON.parse(data) as OpenAIStreamChunk
        if (!chunk || typeof chunk !== 'object') {
          throw new Error(
            `[openaiCompat] invalid stream chunk: ${String(data).slice(0, 500)}`,
          )
        }
        const choice = chunk.choices?.[0]
        const delta = choice?.delta

        if (!choice && data !== '[DONE]') {
          throw new Error(
            `[openaiCompat] chunk missing choices[0]: ${JSON.stringify(chunk).slice(0, 1000)}`,
          )
        }

        // Update usage from every chunk — many OpenAI-compatible APIs
        // (e.g. DeepSeek) only report usage in the final chunk, not the
        // first one. Without this, promptTokens stays 0, causing
        // tokenCountWithEstimation to drastically undercount and
        // auto-compact never triggers.
        if (chunk.usage?.prompt_tokens !== undefined && chunk.usage.prompt_tokens > 0) {
          promptTokens = chunk.usage.prompt_tokens
        }
        if (chunk.usage?.completion_tokens !== undefined && chunk.usage.completion_tokens > 0) {
          completionTokens = chunk.usage.completion_tokens
        }
        const cache = openaiUsageCache(chunk.usage)
        if (cache.cacheRead > 0) cacheReadTokens = cache.cacheRead
        if (cache.cacheWrite > 0) cacheWriteTokens = cache.cacheWrite

        // Collect web search citations (gpt-4o-search-preview style) so a
        // web_search_tool_result block can be synthesized at stream end.
        for (const annotation of delta?.annotations ?? []) {
          if (annotation?.type !== 'url_citation') continue
          const url = annotation.url_citation?.url
          if (!url || urlCitations.has(url)) continue
          urlCitations.set(url, annotation.url_citation?.title ?? '')
        }

        if (!started) {
          started = true
          yield {
            type: 'message_start',
            message: {
              id: chunk.id ?? 'openai-compat',
              type: 'message',
              role: 'assistant',
              model: input.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: promptTokens,
                output_tokens: 0,
              },
            },
          } as BetaRawMessageStreamEvent
        }

        if (delta?.reasoning_content) {
          if (!reasoningStarted) {
            reasoningStarted = true
            reasoningContentIndex = nextContentIndex
            nextContentIndex++
            yield {
              type: 'content_block_start',
              index: reasoningContentIndex,
              content_block: {
                type: 'thinking',
                thinking: '',
              },
            } as BetaRawMessageStreamEvent
          }
          yield {
            type: 'content_block_delta',
            index: reasoningContentIndex ?? 0,
            delta: {
              type: 'thinking_delta',
              thinking: delta.reasoning_content,
            },
          } as BetaRawMessageStreamEvent
          emittedAnyContent = true
        }

        // Close reasoning block when transitioning to content or tool_calls
        if (reasoningStarted && !reasoningClosed && (delta?.content || (delta?.tool_calls && delta.tool_calls.length > 0))) {
          reasoningClosed = true
          yield {
            type: 'content_block_stop',
            index: reasoningContentIndex ?? 0,
          } as BetaRawMessageStreamEvent
        }

        if (delta?.content) {
          if (!textStarted) {
            textStarted = true
            textContentIndex = nextContentIndex
            yield {
              type: 'content_block_start',
              index: textContentIndex,
              content_block: {
                type: 'text',
                text: '',
              },
            } as BetaRawMessageStreamEvent
          }

          yield {
            type: 'content_block_delta',
            index: textContentIndex ?? 0,
            delta: {
              type: 'text_delta',
              text: delta.content,
            },
          } as BetaRawMessageStreamEvent
          emittedAnyContent = true
        }

        for (const toolCall of delta?.tool_calls ?? []) {
          const openAIIndex = toolCall.index ?? 0
          let anthropicIndex = toolIndexByOpenAIIndex.get(openAIIndex)
          if (anthropicIndex === undefined) {
            anthropicIndex = textStarted ? nextContentIndex + 1 : nextContentIndex
            toolIndexByOpenAIIndex.set(openAIIndex, anthropicIndex)
            // Without a preceding text block the +1 above never applies, so
            // advancing only to anthropicIndex hands the same index to every
            // tool call and their input_json_delta streams interleave.
            nextContentIndex = textStarted
              ? Math.max(nextContentIndex, anthropicIndex)
              : anthropicIndex + 1
            const state = {
              id: toolCall.id ?? `toolu_${openAIIndex}`,
              name: toolCall.function?.name ?? '',
              arguments: '',
            }
            toolCallState.set(openAIIndex, state)
            yield {
              type: 'content_block_start',
              index: anthropicIndex,
              content_block: {
                type: 'tool_use',
                id: state.id,
                name: state.name,
                input: '',
              },
            } as BetaRawMessageStreamEvent
            // A tool_use block is content: a zero-argument tool streams no
            // argument deltas, and without this flag the synthetic empty-text
            // block at finish would clobber this block at index 0.
            emittedAnyContent = true
          }

          const state = toolCallState.get(openAIIndex)
          if (!state) continue
          if (toolCall.id) state.id = toolCall.id
          if (toolCall.function?.name) state.name = toolCall.function.name
          if (toolCall.function?.arguments) {
            state.arguments += toolCall.function.arguments
            yield {
              type: 'content_block_delta',
              index: anthropicIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: toolCall.function.arguments,
              },
            } as BetaRawMessageStreamEvent
            emittedAnyContent = true
          }
        }

        if (choice?.finish_reason) {
          // Close reasoning block if still open (edge case: no content/tool_calls after reasoning)
          if (reasoningStarted && !reasoningClosed) {
            reasoningClosed = true
            yield {
              type: 'content_block_stop',
              index: reasoningContentIndex ?? 0,
            } as BetaRawMessageStreamEvent
          }
          if (!emittedAnyContent) {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'text',
                text: '',
              },
            } as BetaRawMessageStreamEvent
            yield {
              type: 'content_block_stop',
              index: 0,
            } as BetaRawMessageStreamEvent
          }
          // completionTokens already updated from chunk.usage above
          if (textStarted && textContentIndex !== null) {
            yield {
              type: 'content_block_stop',
              index: textContentIndex,
            } as BetaRawMessageStreamEvent
          }

          for (const anthropicIndex of toolIndexByOpenAIIndex.values()) {
            yield {
              type: 'content_block_stop',
              index: anthropicIndex,
            } as BetaRawMessageStreamEvent
          }

          // Synthesize Anthropic server_tool_use + web_search_tool_result
          // blocks from collected url_citation annotations so downstream
          // consumers (e.g. WebSearchTool) can reuse the native Anthropic
          // parsing path. The search query is unknown on this API, so the
          // input_json_delta carries an empty query.
          let webSearchRequests = 0
          if (urlCitations.size > 0) {
            webSearchRequests = 1
            const searchBlockIndex = nextContentIndex + 1
            const resultBlockIndex = nextContentIndex + 2
            nextContentIndex = resultBlockIndex
            const searchToolUseId = `srvtoolu_${chunk.id ?? 'openai_compat'}`
            yield {
              type: 'content_block_start',
              index: searchBlockIndex,
              content_block: {
                type: 'server_tool_use',
                id: searchToolUseId,
                name: 'web_search',
                input: {},
              },
            } as BetaRawMessageStreamEvent
            yield {
              type: 'content_block_delta',
              index: searchBlockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify({ query: '' }),
              },
            } as BetaRawMessageStreamEvent
            yield {
              type: 'content_block_stop',
              index: searchBlockIndex,
            } as BetaRawMessageStreamEvent
            yield {
              type: 'content_block_start',
              index: resultBlockIndex,
              content_block: {
                type: 'web_search_tool_result',
                tool_use_id: searchToolUseId,
                content: [...urlCitations].map(([url, title]) => ({
                  type: 'web_search_result',
                  title,
                  url,
                  encrypted_content: '',
                  page_age: null,
                })),
              },
            } as BetaRawMessageStreamEvent
            yield {
              type: 'content_block_stop',
              index: resultBlockIndex,
            } as BetaRawMessageStreamEvent
          }

          yield {
            type: 'message_delta',
            delta: {
              stop_reason: mapFinishReason(choice.finish_reason),
              stop_sequence: null,
            },
            usage: {
              // Include input_tokens here so updateUsage() in claude.ts can
              // correct the initial 0 from message_start. This is critical for
              // APIs like DeepSeek that only report usage in the final chunk.
              // Cache-hit mapping (desktop-app 0.2.78): cached ⊆ prompt_tokens,
              // so input_tokens excludes the cached/written parts while the
              // input-side total still equals prompt_tokens.
              input_tokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
              output_tokens: completionTokens,
              ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
              ...(cacheWriteTokens > 0 ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
              ...(webSearchRequests > 0
                ? { server_tool_use: { web_search_requests: webSearchRequests } }
                : {}),
            },
          } as BetaRawMessageStreamEvent

          yield {
            type: 'message_stop',
          } as BetaRawMessageStreamEvent

          return {
            id: chunk.id ?? 'openai-compat',
            type: 'message',
            role: 'assistant',
            model: input.model,
            content: [],
            stop_reason: mapFinishReason(choice.finish_reason),
            stop_sequence: null,
            usage: {
              input_tokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
              output_tokens: completionTokens,
              ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
              ...(cacheWriteTokens > 0 ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
            },
          } as BetaMessage
        }
      }
    }
  }

  throw new Error(
    `[openaiCompat] stream ended unexpectedly before message_stop for model=${input.model}`,
  )
}

import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { requestFetch } from './requestLifecycle.js'
import { streamAPIError } from './streamErrors.js'
import type {
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  contentToText,
  imageBlockToImageURL,
  isTransientUpstreamError,
  joinBaseUrl,
  splitToolResultContent,
  toBlocks,
} from './openaiCompat.js'

type ResponsesCompatConfig = {
  apiKey: string
  baseURL: string
  headers?: Record<string, string>
  fetch?: typeof globalThis.fetch
}

type ResponsesInputText = {
  type: 'input_text' | 'output_text'
  text: string
}

// Responses API image part: image_url is a bare string (data: URL or remote
// URL), unlike Chat Completions' { image_url: { url } } wrapper.
type ResponsesInputImage = {
  type: 'input_image'
  image_url: string
}

type ResponsesMessageInputItem = {
  type: 'message'
  role: 'user' | 'assistant'
  content: Array<ResponsesInputText | ResponsesInputImage>
}

type ResponsesFunctionCallItem = {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

type ResponsesFunctionCallOutputItem = {
  type: 'function_call_output'
  call_id?: string
  output: string
}

type ResponsesInputItem =
  | ResponsesMessageInputItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

type ResponsesTool =
  | {
      type: 'function'
      name: string
      description?: string
      parameters?: unknown
      strict?: boolean
    }
  | {
      // Current built-in tool name (OpenAI stable + DeepSeek's /responses
      // endpoint). The legacy 'web_search_preview' name is NOT accepted by
      // DeepSeek — requests with it fail tool validation.
      type: 'web_search'
      search_context_size?: 'low' | 'medium' | 'high'
      filters?: { allowed_domains?: string[] }
    }

type ResponsesRequest = {
  model: string
  input: ResponsesInputItem[]
  instructions?: string
  stream?: boolean
  temperature?: number
  tools?: ResponsesTool[]
  tool_choice?:
    | 'auto'
    | {
        type: 'function'
        name: string
      }
    | {
        type: 'web_search'
      }
  max_output_tokens?: number
  // Standard Responses API reasoning field (OpenAI + DeepSeek both expect
  // effort here). A top-level `effort` field is NOT part of the spec and
  // DeepSeek silently ignores it.
  reasoning?: { effort?: string }
}

type ResponsesUsage = {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  // Responses API cache fields (subset of input_tokens): cached_tokens =
  // cache hits, cache_write_tokens = explicit writes (GPT-5.6+).
  input_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
  }
}

type ResponsesAnnotation = {
  type?: string
  url?: string
  title?: string
}

type ResponsesContentPart = {
  type?: string
  text?: string
  annotations?: ResponsesAnnotation[]
}

type ResponsesItem = {
  id?: string
  type?: string
  name?: string
  call_id?: string
  arguments?: string
  status?: string
  action?: {
    type?: string
    query?: string
    queries?: string[]
    // OpenAI's web_search_call action may carry the sources it used;
    // entries are objects ({url, title?}) or bare URL strings.
    sources?: Array<string | { url?: string; title?: string }>
  }
  // message items carry content parts; their annotations hold url_citation
  // entries (DeepSeek attaches them here instead of streaming
  // response.output_text.annotation.added events).
  content?: ResponsesContentPart[]
}

type ResponsesStreamEvent = {
  type?: string
  response?: {
    id?: string
    model?: string
    usage?: ResponsesUsage
    status?: string
    // response.completed/incomplete/failed carry the full response object;
    // output holds every output item (message, web_search_call, ...).
    output?: ResponsesItem[]
  }
  item?: ResponsesItem
  output_index?: number
  item_id?: string
  delta?: string
  text?: string
  arguments?: string
  usage?: ResponsesUsage
  status?: string
  incomplete_details?: {
    reason?: string
  }
  response_id?: string
  annotation?: ResponsesAnnotation
}

type ToolCallState = {
  anthropicIndex: number
  id: string
  name: string
  arguments: string
  stopped: boolean
}

type WebSearchCallState = {
  anthropicIndex: number
  id: string
  stopped: boolean
}

function getToolDefinitions(tools?: BetaToolUnion[]): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const mapped = tools.flatMap((tool): ResponsesTool[] => {
    const record = tool as unknown as Record<string, unknown>
    // Anthropic's server-side web search maps to the Responses API's built-in
    // web_search tool (the current name; DeepSeek's /responses endpoint only
    // accepts 'web_search', not the legacy 'web_search_preview').
    // blocked_domains and max_uses have no Responses API equivalent and are
    // dropped.
    if (record.type === 'web_search_20250305') {
      const allowedDomains = Array.isArray(record.allowed_domains)
        ? record.allowed_domains.filter(
            (domain): domain is string => typeof domain === 'string',
          )
        : []
      return [
        {
          type: 'web_search' as const,
          search_context_size: 'medium' as const,
          ...(allowedDomains.length > 0
            ? { filters: { allowed_domains: allowedDomains } }
            : {}),
        },
      ]
    }
    const name = typeof record.name === 'string' ? record.name : undefined
    if (!name) return []
    return [
      {
        type: 'function' as const,
        name,
        description:
          typeof record.description === 'string' ? record.description : undefined,
        parameters: record.input_schema,
        strict: false,
      },
    ]
  })
  return mapped.length > 0 ? mapped : undefined
}

function getSystemInstructions(
  system?: string | Array<{ type?: string; text?: string }>,
): string | undefined {
  if (!system) return undefined
  const systemText = Array.isArray(system)
    ? system.map(block => block.text ?? '').join('\n')
    : system
  return systemText || undefined
}

export function convertAnthropicRequestToResponses(input: {
  model: string
  system?: string | Array<{ type?: string; text?: string }>
  messages: BetaMessageParam[]
  tools?: BetaToolUnion[]
  tool_choice?: BetaToolChoiceAuto | BetaToolChoiceTool
  temperature?: number
  max_tokens?: number
  output_config?: { effort?: string }
}): ResponsesRequest {
  // Trust the model from the query engine's resolution chain (which already
  // accounts for /model overrides, settings, and env vars). Do NOT re-read
  // process.env.ANTHROPIC_MODEL here — that would ignore mid-session switches.
  const rawModel = input.model
  // Strip [1m]/[2m] suffixes — same normalization as Anthropic native path (model.ts)
  const targetModel = rawModel.replace(/\[(1|2)m\]/gi, '')
  const convertedInput: ResponsesInputItem[] = []

  for (const message of input.messages) {
    if (message.role === 'user') {
      const blocks = toBlocks(message.content)

      const toolResults = blocks.filter(block => block.type === 'tool_result')
      for (const result of toolResults) {
        const toolUseId =
          typeof result.tool_use_id === 'string' ? result.tool_use_id : undefined
        const { text, imageURLs } = splitToolResultContent(result.content)
        const hasImages = imageURLs.length > 0
        // function_call_output takes a plain string; images are emitted as a
        // follow-up user message right below. JSON.stringify would send raw
        // base64 as text, which the model cannot interpret as an image.
        const output = text
          ? text
          : hasImages
            ? '(tool returned image content)'
            : JSON.stringify(result.content)
        convertedInput.push({
          type: 'function_call_output',
          call_id: toolUseId,
          output,
        })
        if (hasImages) {
          convertedInput.push({
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `[Images returned by tool call ${toolUseId ?? ''}]`,
              },
              ...imageURLs.map(url => ({
                type: 'input_image' as const,
                image_url: url,
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
        convertedInput.push({
          type: 'message',
          role: 'user',
          content: [
            ...(text ? [{ type: 'input_text' as const, text }] : []),
            ...imageURLs.map(url => ({
              type: 'input_image' as const,
              image_url: url,
            })),
          ],
        })
      } else if (text) {
        convertedInput.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        })
      }
      continue
    }

    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content)
        ? (message.content as unknown as Array<Record<string, unknown>>)
        : []
      const text = blocks
        .filter(block => block.type === 'text')
        .map(block => (typeof block.text === 'string' ? block.text : ''))
        .join('')

      if (text) {
        convertedInput.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }

      for (const block of blocks.filter(block => block.type === 'tool_use')) {
        convertedInput.push({
          type: 'function_call',
          call_id: String(block.id),
          name: String(block.name),
          arguments:
            typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? {}),
        })
      }
    }
  }

  let maxOutputTokens = input.max_tokens
  if (
    maxOutputTokens &&
    maxOutputTokens > 32000 &&
    process.env.ANTHROPIC_BASE_URL?.includes('deepseek')
  ) {
    maxOutputTokens = 32000
  }

  return {
    model: targetModel,
    input: convertedInput,
    instructions: getSystemInstructions(input.system),
    temperature: input.temperature,
    max_output_tokens: maxOutputTokens,
    ...(getToolDefinitions(input.tools)
      ? { tools: getToolDefinitions(input.tools) }
      : {}),
    ...(input.tool_choice?.type === 'tool'
      ? {
          tool_choice:
            // web_search is a server-side tool; select the Responses built-in
            // web_search tool instead of a (nonexistent) function.
            input.tool_choice.name === 'web_search'
              ? ({ type: 'web_search' } as const)
              : {
                  type: 'function' as const,
                  name: input.tool_choice.name,
                },
        }
      : input.tool_choice?.type === 'auto'
        ? { tool_choice: 'auto' as const }
        : {}),
    ...(input.output_config?.effort
      ? // Pass effort through unchanged (under the standard `reasoning`
        // field) — providers handle their own level mapping. DeepSeek
        // natively supports low/high/max and maps medium/xhigh server-side;
        // clamping here would silently downgrade the user's chosen level.
        { reasoning: { effort: input.output_config.effort } }
      : {}),
  }
}

export async function createResponsesCompatStream(
  config: ResponsesCompatConfig,
  request: ResponsesRequest,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  let response: Response
  try {
    response = await requestFetch(config.fetch ?? globalThis.fetch,
      joinBaseUrl(config.baseURL, '/v1/responses'),
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
    if (signal?.aborted || !(error instanceof APIConnectionError)) throw error
    // Network-level failure (DNS, reset, TLS) — same treatment as the
    // OpenAI-compatible path so withRetry can retry it.
    throw new APIConnectionError({
      message: `Responses compatible request connection error: ${error instanceof Error ? error.message : String(error)}`,
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
    // Detect context length overflow from Responses-format APIs
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
        throw new Error(`Prompt is too long: ${responseText}`)
      }
    }
    if (response.ok || isTransientUpstreamError(response.status, responseText)) {
      // Throw a real APIError so withRetry's shouldRetry() classification
      // applies (408/409/429/5xx are retryable there). A plain Error is NOT
      // an APIError instance and would abort the turn without any retry.
      // 408/409/429/5xx keep their native status; gateway 400/422
      // "upstream failed" wrappers (and ok-with-empty-body) map to 503.
      const normalizedStatus =
        response.ok || response.status === 400 || response.status === 422
          ? 503
          : response.status
      const detail = `Responses compatible request failed with status ${response.status}${responseText ? `: ${responseText}` : ''}`
      // Pass the body as the message (not as APIError.error) so the final
      // error text keeps the original gateway status and payload verbatim.
      throw new APIError(normalizedStatus, undefined, detail, response.headers)
    }
    throw new Error(
      `Responses compatible request failed with status ${response.status}${responseText ? `: ${responseText}` : ''}`,
    )
  }

  return response.body.getReader()
}

function parseSSEEvents(buffer: string): {
  events: Array<{ event?: string; data: string[] }>
  remainder: string
} {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const remainder = parts.pop() ?? ''
  const events = parts.map(rawEvent => {
    const lines = rawEvent.split('\n')
    let event: string | undefined
    const data: string[] = []
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
        continue
      }
      if (line.startsWith('data:')) {
        data.push(line.slice(5).trim())
      }
    }
    return { event, data }
  })
  return { events, remainder }
}

function normalizeEventType(event: ResponsesStreamEvent, sseEvent?: string): string {
  return event.type ?? sseEvent ?? ''
}

function mapResponsesStopReason(event: ResponsesStreamEvent): BetaMessage['stop_reason'] {
  const reason = event.incomplete_details?.reason
  const status = event.status ?? event.response?.status ?? event.item?.status
  if (reason === 'max_output_tokens' || reason === 'max_tokens') return 'max_tokens'
  if (reason === 'tool_use' || status === 'requires_action') return 'tool_use'
  return 'end_turn'
}

function getUsage(event: ResponsesStreamEvent): ResponsesUsage | undefined {
  return event.usage ?? event.response?.usage
}

function mapUsageToAnthropic(
  usage: ResponsesUsage,
  cache: { read: number; write: number } = { read: 0, write: 0 },
): BetaUsage {
  // cached ⊆ input_tokens (Responses semantics): keep the input-side total
  // equal to input_tokens while splitting the cached/written parts out.
  const read = cache.read > 0 ? cache.read : 0
  const write = cache.write > 0 ? cache.write : 0
  return {
    input_tokens: Math.max(0, (usage.input_tokens ?? 0) - read - write),
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: write,
    cache_read_input_tokens: read,
  } as BetaUsage
}

function makeBetaMessage(params: {
  id: string
  model: string
  inputTokens: number
  outputTokens: number
  stopReason: BetaMessage['stop_reason']
  cache?: { read: number; write: number }
}): BetaMessage {
  return {
    id: params.id,
    type: 'message',
    role: 'assistant',
    model: params.model,
    content: [],
    stop_reason: params.stopReason,
    stop_sequence: null,
    usage: mapUsageToAnthropic(
      { input_tokens: params.inputTokens, output_tokens: params.outputTokens },
      params.cache,
    ),
  } as BetaMessage
}

function ensureTextBlockStarted(
  textStarted: boolean,
  textContentIndex: number,
): BetaRawMessageStreamEvent | undefined {
  if (textStarted) return undefined
  return {
    type: 'content_block_start',
    index: textContentIndex,
    content_block: {
      type: 'text',
      text: '',
    },
  } as BetaRawMessageStreamEvent
}

function getToolKey(event: ResponsesStreamEvent): string | undefined {
  return event.item?.call_id ?? event.item_id ?? event.item?.id
}

export async function* createAnthropicStreamFromResponses(input: {
  reader: ReadableStreamDefaultReader<Uint8Array>
  model: string
}): AsyncGenerator<BetaRawMessageStreamEvent, BetaMessage, void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let started = false
  let textStarted = false
  let textStopped = false
  const textContentIndex = 0
  let nextContentIndex = 1
  let promptTokens = 0
  let completionTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let emittedAnyContent = false
  let responseId = 'responses-compat'
  let finalStopReason: BetaMessage['stop_reason'] = 'end_turn'
  const toolStates = new Map<string, ToolCallState>()
  const toolOrder: string[] = []
  // Server-side web search synthesis state: tracks web_search_call output items
  // (mapped to server_tool_use blocks) and url_citation annotations (collected
  // into synthesized web_search_tool_result blocks at stream end).
  const webSearchStates = new Map<string, WebSearchCallState>()
  let lastWebSearchCallId: string | undefined
  const citations: Array<{ url: string; title: string }> = []
  const seenCitationUrls = new Set<string>()

  const addCitation = (url: unknown, title?: unknown) => {
    if (
      typeof url !== 'string' ||
      url.length === 0 ||
      seenCitationUrls.has(url)
    ) {
      return
    }
    seenCitationUrls.add(url)
    citations.push({ url, title: typeof title === 'string' ? title : '' })
  }

  // Citations arrive differently per provider: OpenAI streams
  // response.output_text.annotation.added events; DeepSeek never does and
  // only attaches annotations to the finished message item / final response
  // object (and may list sources on the web_search_call action).
  const collectFromAnnotations = (annotations?: ResponsesAnnotation[]) => {
    for (const annotation of annotations ?? []) {
      if (annotation?.type === 'url_citation') {
        addCitation(annotation.url, annotation.title)
      }
    }
  }
  const collectFromItem = (item?: ResponsesItem) => {
    if (!item) return
    for (const source of item.action?.sources ?? []) {
      if (typeof source === 'string') addCitation(source)
      else addCitation(source?.url, source?.title)
    }
    for (const part of item.content ?? []) {
      collectFromAnnotations(part?.annotations)
    }
  }

  try {
  while (true) {
    const { done, value } = await input.reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parsed = parseSSEEvents(buffer)
    buffer = parsed.remainder

    for (const rawEvent of parsed.events) {
      for (const data of rawEvent.data) {
        if (!data || data === '[DONE]') continue
        const event = JSON.parse(data) as ResponsesStreamEvent
        if (!event || typeof event !== 'object') {
          throw new Error(
            `[responsesCompat] invalid stream event: ${String(data).slice(0, 500)}`,
          )
        }

        const eventType = normalizeEventType(event, rawEvent.event)
        if (eventType === 'error' || eventType === 'response.failed') throw streamAPIError(event)
        responseId =
          event.response?.id ?? event.response_id ?? event.item?.id ?? responseId

        const usage = getUsage(event)
        if (!started) {
          started = true
          promptTokens = usage?.input_tokens ?? 0
          completionTokens = usage?.output_tokens ?? 0
          yield {
            type: 'message_start',
            message: {
              id: responseId,
              type: 'message',
              role: 'assistant',
              model: input.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: mapUsageToAnthropic(
                { input_tokens: promptTokens, output_tokens: 0 },
                { read: cacheReadTokens, write: cacheWriteTokens },
              ),
            },
          } as BetaRawMessageStreamEvent
        }

        if (usage?.input_tokens !== undefined) promptTokens = usage.input_tokens
        if (usage?.output_tokens !== undefined) completionTokens = usage.output_tokens
        const details = usage?.input_tokens_details
        if (details?.cached_tokens !== undefined && details.cached_tokens > 0) cacheReadTokens = details.cached_tokens
        if (details?.cache_write_tokens !== undefined && details.cache_write_tokens > 0) cacheWriteTokens = details.cache_write_tokens

        if (eventType === 'response.output_text.annotation.added') {
          // Streamed url_citation annotations (OpenAI-style). Collected
          // deduped by url for the synthesized web_search_tool_result blocks
          // emitted at stream end.
          if (event.annotation) collectFromAnnotations([event.annotation])
          continue
        }

        // DeepSeek streams no annotation events — citations only show up on
        // the finished message item's content parts (and search sources on
        // the web_search_call action), so harvest every completed item.
        if (eventType === 'response.output_item.done') {
          collectFromItem(event.item)
        }

        if (eventType === 'response.output_text.delta') {
          const textDelta = event.delta ?? event.text ?? ''
          if (textDelta) {
            const startEvent = ensureTextBlockStarted(textStarted, textContentIndex)
            if (startEvent) {
              textStarted = true
              yield startEvent
            }
            yield {
              type: 'content_block_delta',
              index: textContentIndex,
              delta: {
                type: 'text_delta',
                text: textDelta,
              },
            } as BetaRawMessageStreamEvent
            emittedAnyContent = true
          }
          continue
        }

        if (
          eventType === 'response.output_item.added' &&
          event.item?.type === 'web_search_call'
        ) {
          const key =
            event.item.id ?? event.item_id ?? `web_search_${webSearchStates.size}`
          if (!webSearchStates.has(key)) {
            const anthropicIndex = nextContentIndex++
            const id = event.item.id ?? key
            webSearchStates.set(key, { anthropicIndex, id, stopped: false })
            lastWebSearchCallId = id
            yield {
              type: 'content_block_start',
              index: anthropicIndex,
              content_block: {
                type: 'server_tool_use',
                id,
                name: 'web_search',
                input: {},
              },
            } as BetaRawMessageStreamEvent
            emittedAnyContent = true
          }
          continue
        }

        if (
          eventType === 'response.output_item.done' &&
          event.item?.type === 'web_search_call'
        ) {
          // The query is only guaranteed to be complete once the item is done,
          // so the input_json_delta is emitted here rather than on added.
          // (The response.web_search_call.* lifecycle events are redundant with
          // the output_item events and are ignored.)
          const key =
            event.item.id ?? event.item_id ?? `web_search_${webSearchStates.size}`
          let state = webSearchStates.get(key)
          if (!state) {
            // Some providers skip output_item.added — synthesize the start.
            const anthropicIndex = nextContentIndex++
            const id = event.item.id ?? key
            state = { anthropicIndex, id, stopped: false }
            webSearchStates.set(key, state)
            yield {
              type: 'content_block_start',
              index: anthropicIndex,
              content_block: {
                type: 'server_tool_use',
                id,
                name: 'web_search',
                input: {},
              },
            } as BetaRawMessageStreamEvent
            emittedAnyContent = true
          }
          lastWebSearchCallId = state.id
          yield {
            type: 'content_block_delta',
            index: state.anthropicIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({
                query: event.item.action?.query ?? '',
              }),
            },
          } as BetaRawMessageStreamEvent
          if (!state.stopped) {
            yield {
              type: 'content_block_stop',
              index: state.anthropicIndex,
            } as BetaRawMessageStreamEvent
            state.stopped = true
          }
          continue
        }

        if (
          eventType === 'response.output_item.added' &&
          event.item?.type === 'function_call'
        ) {
          const key = getToolKey(event) ?? `tool_${toolOrder.length}`
          if (!toolStates.has(key)) {
            const anthropicIndex = nextContentIndex++
            toolStates.set(key, {
              anthropicIndex,
              id: event.item.call_id ?? key,
              name: event.item.name ?? '',
              arguments: '',
              stopped: false,
            })
            toolOrder.push(key)
            yield {
              type: 'content_block_start',
              index: anthropicIndex,
              content_block: {
                type: 'tool_use',
                id: event.item.call_id ?? key,
                name: event.item.name ?? '',
                input: '',
              },
            } as BetaRawMessageStreamEvent
          }
          continue
        }

        if (
          eventType === 'response.function_call_arguments.delta' ||
          eventType === 'response.output_item.delta'
        ) {
          const key = getToolKey(event)
          const state = key ? toolStates.get(key) : undefined
          const partialJson = event.delta ?? event.arguments
          if (state && partialJson) {
            state.arguments += partialJson
            yield {
              type: 'content_block_delta',
              index: state.anthropicIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: partialJson,
              },
            } as BetaRawMessageStreamEvent
            emittedAnyContent = true
          }
          continue
        }

        if (
          eventType === 'response.output_item.done' &&
          event.item?.type === 'function_call'
        ) {
          const key = getToolKey(event)
          const state = key ? toolStates.get(key) : undefined
          if (state) {
            if (event.item.name) state.name = event.item.name
            if (event.item.arguments && event.item.arguments !== state.arguments) {
              const prefixLength = state.arguments.length
              const suffix = event.item.arguments.slice(prefixLength)
              if (suffix) {
                state.arguments = event.item.arguments
                yield {
                  type: 'content_block_delta',
                  index: state.anthropicIndex,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: suffix,
                  },
                } as BetaRawMessageStreamEvent
              }
            }
            if (!state.stopped) {
              yield {
                type: 'content_block_stop',
                index: state.anthropicIndex,
              } as BetaRawMessageStreamEvent
              state.stopped = true
            }
          }
          finalStopReason = 'tool_use'
          continue
        }

        if (
          eventType === 'response.completed' ||
          eventType === 'response.incomplete'
        ) {
          finalStopReason = mapResponsesStopReason(event)

          // The final event carries the full response object — harvest
          // citations from providers (e.g. DeepSeek) that only attach them
          // here, and register any web_search_call items that never appeared
          // as streamed output_item events so they still get result blocks.
          for (const outputItem of event.response?.output ?? []) {
            collectFromItem(outputItem)
            if (
              outputItem?.type === 'web_search_call' &&
              typeof outputItem.id === 'string' &&
              !webSearchStates.has(outputItem.id) &&
              !Array.from(webSearchStates.values()).some(
                state => state.id === outputItem.id,
              )
            ) {
              webSearchStates.set(outputItem.id, {
                anthropicIndex: -1,
                id: outputItem.id,
                stopped: true,
              })
            }
          }

          if (!emittedAnyContent) {
            const startEvent = ensureTextBlockStarted(textStarted, textContentIndex)
            if (startEvent) {
              textStarted = true
              yield startEvent
            }
            yield {
              type: 'content_block_stop',
              index: textContentIndex,
            } as BetaRawMessageStreamEvent
            textStopped = true
          }

          if (textStarted && !textStopped) {
            yield {
              type: 'content_block_stop',
              index: textContentIndex,
            } as BetaRawMessageStreamEvent
            textStopped = true
          }

          for (const key of toolOrder) {
            const state = toolStates.get(key)
            if (state && !state.stopped) {
              yield {
                type: 'content_block_stop',
                index: state.anthropicIndex,
              } as BetaRawMessageStreamEvent
              state.stopped = true
            }
          }

          if (webSearchStates.size > 0 || citations.length > 0) {
            // Synthesize the web_search_tool_result blocks the Anthropic API
            // would have produced: one per server-side search, so the tool's
            // "Did N searches" count matches reality even when the provider
            // returns no citations at all (DeepSeek streams no annotation
            // events). Citations can't be attributed to individual calls —
            // attach them all to the first block.
            const states = Array.from(webSearchStates.values())
            const resultOwners: WebSearchCallState[] =
              states.length > 0
                ? states
                : [
                    {
                      anthropicIndex: -1,
                      id: lastWebSearchCallId ?? `web_search_${nextContentIndex}`,
                      stopped: true,
                    },
                  ]
            let citationsAttached = false
            for (const state of resultOwners) {
              const anthropicIndex = nextContentIndex++
              yield {
                type: 'content_block_start',
                index: anthropicIndex,
                content_block: {
                  type: 'web_search_tool_result',
                  tool_use_id: state.id,
                  content: !citationsAttached
                    ? citations.map(citation => ({
                        type: 'web_search_result',
                        title: citation.title,
                        url: citation.url,
                        encrypted_content: '',
                        page_age: null,
                      }))
                    : [],
                },
              } as BetaRawMessageStreamEvent
              citationsAttached = true
              yield {
                type: 'content_block_stop',
                index: anthropicIndex,
              } as BetaRawMessageStreamEvent
            }
          }

          yield {
            type: 'message_delta',
            delta: {
              stop_reason: finalStopReason,
              stop_sequence: null,
            },
            usage: {
              ...mapUsageToAnthropic(
                { input_tokens: promptTokens, output_tokens: completionTokens },
                { read: cacheReadTokens, write: cacheWriteTokens },
              ),
              // Best effort: Responses usage has no server-tool breakdown, but
              // consumers expect it once a search was synthesized.
              ...(webSearchStates.size > 0 || citations.length > 0
                ? {
                    server_tool_use: {
                      web_search_requests: 1,
                      web_fetch_requests: 0,
                    },
                  }
                : {}),
            },
          } as BetaRawMessageStreamEvent

          yield {
            type: 'message_stop',
          } as BetaRawMessageStreamEvent

          return makeBetaMessage({
            id: responseId,
            model: input.model,
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            stopReason: finalStopReason,
            cache: { read: cacheReadTokens, write: cacheWriteTokens },
          })
        }
      }
    }
  }

  throw new APIConnectionError({ message:
    `[responsesCompat] stream ended unexpectedly before message_stop for model=${input.model}`,
  })
  } finally {
    void input.reader.cancel().catch(() => {})
    try { input.reader.releaseLock() } catch {}
  }
}

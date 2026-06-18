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

type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
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
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
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

function getToolDefinitions(tools?: BetaToolUnion[]): OpenAIChatRequest['tools'] {
  if (!tools || tools.length === 0) return undefined
  const mapped = tools.flatMap(tool => {
    const record = tool as unknown as Record<string, unknown>
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
        const content = result.content
        messages.push({
          role: 'tool',
          tool_call_id: toolUseId,
          content: typeof content === 'string' ? content : JSON.stringify(content),
        })
      }

      const text = contentToText(
        blocks.filter(block => block.type !== 'tool_result') as unknown as BetaMessageParam['content'],
      )
      if (text) messages.push({ role: 'user', content: text })
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

  return {
    model: targetModel,
    messages,
    temperature: input.temperature,
    max_tokens: maxTokens,
    ...(getToolDefinitions(input.tools)
      ? { tools: getToolDefinitions(input.tools) }
      : {}),
    ...(input.tool_choice?.type === 'tool'
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

export async function createOpenAICompatStream(
  config: OpenAICompatConfig,
  request: OpenAIChatRequest,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await (config.fetch ?? globalThis.fetch)(
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
  let emittedAnyContent = false
  // DeepSeek reasoning_content tracking
  let reasoningStarted = false
  let reasoningContentIndex: number | null = null
  let reasoningClosed = false
  const toolCallState = new Map<number, { id: string; name: string; arguments: string }>()

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
            nextContentIndex = Math.max(nextContentIndex, anthropicIndex)
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
              input_tokens: promptTokens,
              output_tokens: completionTokens,
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
              input_tokens: promptTokens,
              output_tokens: completionTokens,
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

export function mapOpenAIUsageToAnthropic(usage?: {
  prompt_tokens?: number
  completion_tokens?: number
}): BetaUsage | undefined {
  if (!usage) return undefined
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  } as BetaUsage
}

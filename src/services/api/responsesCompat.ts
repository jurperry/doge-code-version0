import type {
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { contentToText, joinBaseUrl, toBlocks } from './openaiCompat.js'

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

type ResponsesMessageInputItem = {
  type: 'message'
  role: 'user' | 'assistant'
  content: ResponsesInputText[]
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

type ResponsesTool = {
  type: 'function'
  name: string
  description?: string
  parameters?: unknown
  strict?: boolean
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
  max_output_tokens?: number
}

type ResponsesUsage = {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

type ResponsesItem = {
  id?: string
  type?: string
  name?: string
  call_id?: string
  arguments?: string
  status?: string
}

type ResponsesStreamEvent = {
  type?: string
  response?: {
    id?: string
    model?: string
    usage?: ResponsesUsage
    status?: string
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
}

type ToolCallState = {
  anthropicIndex: number
  id: string
  name: string
  arguments: string
  stopped: boolean
}

function getToolDefinitions(tools?: BetaToolUnion[]): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const mapped = tools.flatMap(tool => {
    const record = tool as unknown as Record<string, unknown>
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
}): ResponsesRequest {
  const configuredModel = process.env.ANTHROPIC_MODEL?.trim()
  const targetModel = configuredModel || input.model
  const convertedInput: ResponsesInputItem[] = []

  for (const message of input.messages) {
    if (message.role === 'user') {
      const blocks = toBlocks(message.content)

      const toolResults = blocks.filter(block => block.type === 'tool_result')
      for (const result of toolResults) {
        const toolUseId =
          typeof result.tool_use_id === 'string' ? result.tool_use_id : undefined
        const content = result.content
        convertedInput.push({
          type: 'function_call_output',
          call_id: toolUseId,
          output: typeof content === 'string' ? content : JSON.stringify(content),
        })
      }

      const text = contentToText(
        blocks.filter(block => block.type !== 'tool_result') as unknown as BetaMessageParam['content'],
      )
      if (text) {
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
    maxOutputTokens > 8192 &&
    process.env.ANTHROPIC_BASE_URL?.includes('deepseek')
  ) {
    maxOutputTokens = 8192
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
          tool_choice: {
            type: 'function' as const,
            name: input.tool_choice.name,
          },
        }
      : input.tool_choice?.type === 'auto'
        ? { tool_choice: 'auto' as const }
        : {}),
  }
}

export async function createResponsesCompatStream(
  config: ResponsesCompatConfig,
  request: ResponsesRequest,
  signal?: AbortSignal,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await (config.fetch ?? globalThis.fetch)(
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

  if (!response.ok || !response.body) {
    let responseText = ''
    try {
      responseText = await response.text()
    } catch {
      responseText = ''
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

function mapUsageToAnthropic(usage: ResponsesUsage): BetaUsage {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  } as BetaUsage
}

function makeBetaMessage(params: {
  id: string
  model: string
  inputTokens: number
  outputTokens: number
  stopReason: BetaMessage['stop_reason']
}): BetaMessage {
  return {
    id: params.id,
    type: 'message',
    role: 'assistant',
    model: params.model,
    content: [],
    stop_reason: params.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
    },
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
  let emittedAnyContent = false
  let responseId = 'responses-compat'
  let finalStopReason: BetaMessage['stop_reason'] = 'end_turn'
  const toolStates = new Map<string, ToolCallState>()
  const toolOrder: string[] = []

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
              usage: mapUsageToAnthropic({
                input_tokens: promptTokens,
                output_tokens: 0,
              }),
            },
          } as BetaRawMessageStreamEvent
        }

        if (usage?.input_tokens !== undefined) promptTokens = usage.input_tokens
        if (usage?.output_tokens !== undefined) completionTokens = usage.output_tokens

        if (
          eventType === 'response.output_text.delta' ||
          eventType === 'response.output_text.annotation.added'
        ) {
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
          eventType === 'response.incomplete' ||
          eventType === 'response.failed'
        ) {
          finalStopReason = mapResponsesStopReason(event)

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

          yield {
            type: 'message_delta',
            delta: {
              stop_reason: finalStopReason,
              stop_sequence: null,
            },
            usage: mapUsageToAnthropic({
              input_tokens: promptTokens,
              output_tokens: completionTokens,
            }),
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
          })
        }
      }
    }
  }

  throw new Error(
    `[responsesCompat] stream ended unexpectedly before message_stop for model=${input.model}`,
  )
}

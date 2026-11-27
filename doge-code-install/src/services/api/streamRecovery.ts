import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import type { BetaRawMessageStreamEvent as Event } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { streamAPIError } from './streamErrors.js'

type Source = AsyncIterable<Event> & { controller?: AbortController }

/** A retry may replay only before a complete tool block has been dispatched. */
export async function* recoverStream(
  acquire: (failure?: unknown, discardPartial?: boolean, continuation?: boolean) => AsyncGenerator<SystemAPIErrorMessage, Source | undefined>,
): AsyncGenerator<Event | SystemAPIErrorMessage> {
  let failure: unknown
  let continuation = false
  while (true) {
    const source = yield* acquire(failure, failure !== undefined && !continuation, continuation)
    if (continuation) {
      // query.ts retains the executed tool and consumes its result before the
      // next API request. Reissuing the original prompt would execute it twice.
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: {} } as Event
      yield { type: 'message_stop' } as Event
      return
    }
    if (!source) throw new Error('Stream acquisition returned no stream')
    const toolIndices = new Set<number>()
    let toolCompleted = false
    try {
      for await (const event of source) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') toolIndices.add(event.index)
        if (event.type === 'content_block_stop' && toolIndices.has(event.index)) toolCompleted = true
        yield event
        if (event.type === 'message_stop') return
      }
      throw new APIConnectionError({ message: 'Stream ended before message_stop' })
    } catch (error) {
      // Authentication/configuration API errors keep their real status. Raw
      // reader resets and truncated JSON are connection failures.
      failure = error
      if (error instanceof APIError && !(error instanceof APIConnectionError) && error.status === undefined && error.error) {
        failure = streamAPIError(error.error, error.headers)
      } else if (error instanceof TypeError || error instanceof SyntaxError) {
        failure = new APIConnectionError({ message: `Stream connection failed: ${error.message}`, cause: error })
      }
      continuation = toolCompleted
    } finally {
      source.controller?.abort()
    }
  }
}

import type { LocalJSXCommandContext } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { recordTranscript } from '../../utils/sessionStorage.js'

/** Both REPL and QueryEngine apply setMessages updaters synchronously.
 * Capture their current history rather than a detached workflow's old snapshot.
 * Growing-array persistence keeps intervening turns and concurrent workflows
 * on the main transcript chain, without exposing transcript-only text to API. */
export async function appendWorkflowTranscript(
  context: Pick<LocalJSXCommandContext, 'setMessages'>,
  message: Message,
): Promise<void> {
  let transcript: Message[] = []
  context.setMessages(previous => {
    transcript = [...previous, message]
    return transcript
  })
  await recordTranscript(transcript)
}

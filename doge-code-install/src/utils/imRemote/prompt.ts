import { hasAgentTeamsKeyword } from '../agentTeamsKeywords.js'
import { enableAgentSwarmsForSession } from '../agentSwarmsEnabled.js'

/** Prepare remote input before either session builds its per-turn tool pool.
 * Each explicit request expands again, including sessions already opted in.
 * Keep the caller's original text for the desktop user-message echo. */
export function prepareRemotePrompt(text: string): string {
  const trimmed = text.trim()
  const explicit = /^\/agent-teams(?:\s|$)/.test(trimmed)
  const keyword = hasAgentTeamsKeyword(trimmed)
  if (explicit || keyword) {
    enableAgentSwarmsForSession()
    if (keyword) return `/agent-teams ${trimmed}`
    return trimmed
  }
  return text
}

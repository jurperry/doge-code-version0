/**
 * Centralized utilities for parsing slash commands
 */

export type ParsedSlashCommand = {
  commandName: string
  args: string
  isMcp: boolean
}

/**
 * Parses a slash command input string into its component parts
 *
 * @param input - The raw input string (should start with '/')
 * @returns Parsed command name, args, and MCP flag, or null if invalid
 *
 * @example
 * parseSlashCommand('/search foo bar')
 * // => { commandName: 'search', args: 'foo bar', isMcp: false }
 *
 * @example
 * parseSlashCommand('/mcp:tool (MCP) arg1 arg2')
 * // => { commandName: 'mcp:tool (MCP)', args: 'arg1 arg2', isMcp: true }
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmedInput = input.trim()

  // Check if input starts with '/'
  if (!trimmedInput.startsWith('/')) {
    return null
  }

  // Only consume the separator. The remaining arguments may be a multiline
  // workflow request and must not be split/rejoined or have their indentation lost.
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmedInput)
  if (!match) return null
  let commandName = match[1]!
  let args = match[2] ?? ''
  const marker = /^\(MCP\)(?:\s+|$)/.exec(args)
  const isMcp = !!marker
  if (marker) {
    commandName += ' (MCP)'
    args = args.slice(marker[0].length)
  }

  return {
    commandName,
    args,
    isMcp,
  }
}

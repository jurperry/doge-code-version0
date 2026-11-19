import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Lexer, type Token, type Tokens } from 'marked'
import { getErrnoCode } from '../utils/errors.js'

function topicPath(item: Tokens.ListItem, directory: string): string | undefined {
  // The index format uses a single bullet starting with a link to a topic file.
  if (item.raw.trimEnd().includes('\n')) return undefined
  const firstBlock = item.tokens[0]
  if (!firstBlock || !('tokens' in firstBlock)) return undefined
  const [link, ...description]: Token[] = firstBlock.tokens ?? []
  if (link?.type !== 'link' || !link.raw.includes('](')) return undefined
  if (description.some(token => token.type === 'link' || token.raw.includes(']('))) return undefined

  let target: string
  try {
    target = decodeURIComponent(link.href.split(/[?#]/, 1)[0])
  } catch {
    return undefined
  }
  const segments = target.split(/[\\/]/)
  if (!/\.md$/i.test(target) || !segments[0] || segments.includes('..') || target.includes(':')) return undefined
  return join(directory, ...segments)
}

async function keepTopic(item: Tokens.ListItem, directory: string): Promise<boolean> {
  const path = topicPath(item, directory)
  if (!path) return true
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    const code = getErrnoCode(error)
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

/** Exclude missing topic pointers from the model context without changing the index on disk. */
export async function omitMissingMemoryTopics(path: string, content: string): Promise<string> {
  if (!content.includes('](')) return content
  const directory = dirname(path)
  const sections = await Promise.all(Lexer.lex(content, { gfm: false }).map(async token => {
    if (token.type !== 'list' || token.ordered) return { content: token.raw, changed: false }
    const items: Tokens.ListItem[] = token.items
    const kept = await Promise.all(items.map(item => keepTopic(item, directory)))
    if (kept.every(Boolean)) return { content: token.raw, changed: false }
    return { content: items.filter((_, index) => kept[index]).map(item => item.raw).join(''), changed: true }
  }))
  return sections.some(section => section.changed) ? sections.map(section => section.content).join('') : content
}

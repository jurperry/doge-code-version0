/**
 * Resolve file_uuid attachments on inbound bridge user messages.
 *
 * Web composer uploads via cookie-authed /api/{org}/upload, sends file_uuid
 * alongside the message. Here we fetch each via GET /api/oauth/files/{uuid}/content
 * (oauth-authed, same store), write to ~/.claude/uploads/{sessionId}/, and
 * return @path refs to prepend. Claude's Read tool takes it from there.
 *
 * Best-effort: any failure (no token, network, non-2xx, disk) logs debug and
 * skips that attachment. The message still reaches Claude, just without @path.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { basename, isAbsolute, join } from 'path'
import { z } from 'zod/v4'
import { getSessionId } from '../bootstrap/state.js'
import type { PastedContent } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { lazySchema } from '../utils/lazySchema.js'
import { getBridgeAccessToken, getBridgeBaseUrl } from './bridgeConfig.js'

const DOWNLOAD_TIMEOUT_MS = 30_000

function debug(msg: string): void {
  logForDebugging(`[bridge:inbound-attach] ${msg}`)
}

const attachmentSchema = lazySchema(() =>
  z.object({
    file_uuid: z.string(),
    file_name: z.string(),
  }),
)
const attachmentsArraySchema = lazySchema(() => z.array(attachmentSchema()))

export type InboundAttachment = z.infer<ReturnType<typeof attachmentSchema>>

/** Pull file_attachments off a loosely-typed inbound message. */
export function extractInboundAttachments(msg: unknown): InboundAttachment[] {
  if (typeof msg !== 'object' || msg === null || !('file_attachments' in msg)) {
    return []
  }
  const parsed = attachmentsArraySchema().safeParse(msg.file_attachments)
  return parsed.success ? parsed.data : []
}

/**
 * Strip path components and keep only filename-safe chars. file_name comes
 * from the network (web composer), so treat it as untrusted even though the
 * composer controls it.
 */
function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || 'attachment'
}

function uploadsDir(): string {
  return join(getClaudeConfigHomeDir(), 'uploads', getSessionId())
}

/**
 * Fetch + write one attachment. Returns the absolute path on success,
 * undefined on any failure.
 */
async function resolveOne(att: InboundAttachment): Promise<string | undefined> {
  const token = getBridgeAccessToken()
  if (!token) {
    debug('skip: no oauth token')
    return undefined
  }

  let data: Buffer
  try {
    // getOauthConfig() (via getBridgeBaseUrl) throws on a non-allowlisted
    // CLAUDE_CODE_CUSTOM_OAUTH_URL — keep it inside the try so a bad
    // FedStart URL degrades to "no @path" instead of crashing print.ts's
    // reader loop (which has no catch around the await).
    const url = `${getBridgeBaseUrl()}/api/oauth/files/${encodeURIComponent(att.file_uuid)}/content`
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      validateStatus: () => true,
    })
    if (response.status !== 200) {
      debug(`fetch ${att.file_uuid} failed: status=${response.status}`)
      return undefined
    }
    data = Buffer.from(response.data)
  } catch (e) {
    debug(`fetch ${att.file_uuid} threw: ${e}`)
    return undefined
  }

  // uuid-prefix makes collisions impossible across messages and within one
  // (same filename, different files). 8 chars is enough — this isn't security.
  const safeName = sanitizeFileName(att.file_name)
  const prefix = (
    att.file_uuid.slice(0, 8) || randomUUID().slice(0, 8)
  ).replace(/[^a-zA-Z0-9_-]/g, '_')
  const dir = uploadsDir()
  const outPath = join(dir, `${prefix}-${safeName}`)

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(outPath, data)
  } catch (e) {
    debug(`write ${outPath} failed: ${e}`)
    return undefined
  }

  debug(`resolved ${att.file_uuid} → ${outPath} (${data.length} bytes)`)
  return outPath
}

/**
 * Resolve all attachments on an inbound message to a prefix string of
 * @path refs. Empty string if none resolved.
 */
export async function resolveInboundAttachments(
  attachments: InboundAttachment[],
): Promise<string> {
  if (attachments.length === 0) return ''
  debug(`resolving ${attachments.length} attachment(s)`)
  const paths = await Promise.all(attachments.map(resolveOne))
  const ok = paths.filter((p): p is string => p !== undefined)
  if (ok.length === 0) return ''
  // Quoted form — extractAtMentionedFiles truncates unquoted @refs at the
  // first space, which breaks any home dir with spaces (/Users/John Smith/).
  return ok.map(p => `@"${p}"`).join(' ') + ' '
}

/**
 * Prepend @path refs to content, whichever form it's in.
 * Targets the LAST text block — processUserInputBase reads inputString
 * from processedBlocks[processedBlocks.length - 1], so putting refs in
 * block[0] means they're silently ignored for [text, image] content.
 */
export function prependPathRefs(
  content: string | Array<ContentBlockParam>,
  prefix: string,
): string | Array<ContentBlockParam> {
  if (!prefix) return content
  if (typeof content === 'string') return prefix + content
  const i = content.findLastIndex(b => b.type === 'text')
  if (i !== -1) {
    const b = content[i]!
    if (b.type === 'text') {
      return [
        ...content.slice(0, i),
        { ...b, text: prefix + b.text },
        ...content.slice(i + 1),
      ]
    }
  }
  // No text block — append one at the end so it's last.
  return [...content, { type: 'text', text: prefix.trimEnd() }]
}

/**
 * Convenience: extract + resolve + prepend. No-op when the message has no
 * file_attachments field (fast path — no network, returns same reference).
 */
export async function resolveAndPrepend(
  msg: unknown,
  content: string | Array<ContentBlockParam>,
): Promise<string | Array<ContentBlockParam>> {
  const attachments = extractInboundAttachments(msg)
  if (attachments.length === 0) return content
  const prefix = await resolveInboundAttachments(attachments)
  return prependPathRefs(content, prefix)
}

const imagePathsSchema = lazySchema(() => z.array(z.string()))

/**
 * Pull image_paths off a loosely-typed stdin user message. Embedding shells
 * (e.g. the desktop app) that already have the image on disk set this field,
 * aligned by image-block order, so the model is pointed at the original file
 * instead of a cache copy.
 */
function extractStdinImagePaths(msg: unknown): string[] {
  if (typeof msg !== 'object' || msg === null || !('image_paths' in msg)) {
    return []
  }
  const parsed = imagePathsSchema().safeParse(msg.image_paths)
  return parsed.success ? parsed.data : []
}

/**
 * Move inline base64 image blocks from a headless stdin user message into
 * pastedContents, so they ride the interactive pipeline: storeImages() writes
 * each one to the session image-cache and the model is told the path via the
 * isMeta `[Image: source: <path>]` message. Without this the model sees the
 * pixels but has no file to point Read/Bash at (it cannot "edit the image").
 *
 * `msg.image_paths` entries are validated (absolute + exists) and used as
 * sourcePath, which both points the model at the caller's original file and
 * skips nothing — a cache copy is still written, matching TUI drag-drop.
 * Non-base64 blocks (url/file sources) and empty payloads stay in content
 * untouched. Same content reference returned when there is nothing to move.
 */
export function materializeStdinImageBlocks(
  msg: unknown,
  content: string | Array<ContentBlockParam>,
): {
  content: string | Array<ContentBlockParam>
  pastedContents?: Record<number, PastedContent>
} {
  if (!Array.isArray(content)) return { content }
  const provided = extractStdinImagePaths(msg)
  const pastedContents: Record<number, PastedContent> = {}
  const kept: ContentBlockParam[] = []
  let nextId = 1
  let imageIndex = 0
  for (const block of content) {
    if (block.type === 'image') {
      const source = block.source
      if (source.type === 'base64' && source.data) {
        const declared = provided[imageIndex]?.trim()
        const sourcePath =
          declared && isAbsolute(declared) && existsSync(declared)
            ? declared
            : undefined
        pastedContents[nextId] = {
          id: nextId,
          type: 'image',
          content: source.data,
          mediaType: source.media_type ?? 'image/png',
          filename: 'stdin image',
          sourcePath,
        }
        nextId++
        imageIndex++
        continue
      }
      // url/file-sourced image block (or empty payload): count it for
      // image_paths alignment but leave it in content verbatim
      imageIndex++
      kept.push(block)
      continue
    }
    kept.push(block)
  }
  if (nextId === 1) return { content }
  debug(`moved ${nextId - 1} stdin image block(s) into pastedContents`)
  return { content: kept, pastedContents }
}

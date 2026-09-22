import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  materializeStdinImageBlocks,
  prependPathRefs,
} from './inboundAttachments.js'
import { mergeQueuedPastedContents } from '../types/textInputTypes.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'stdin-image-test-'))
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const IMG = (data = 'aGVsbG8=') => ({
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data },
})

describe('materializeStdinImageBlocks', () => {
  test('string content passes through untouched', () => {
    const out = materializeStdinImageBlocks({}, 'hello')
    expect(out.content).toBe('hello')
    expect(out.pastedContents).toBeUndefined()
  })

  test('array without images passes through same reference', () => {
    const content = [{ type: 'text' as const, text: 'hi' }]
    const out = materializeStdinImageBlocks({}, content)
    expect(out.content).toBe(content)
    expect(out.pastedContents).toBeUndefined()
  })

  test('image blocks move into pastedContents, text stays in content', () => {
    const out = materializeStdinImageBlocks(
      {},
      [
        { type: 'text', text: 'edit this' },
        IMG(),
        IMG('d29ybGQ='),
      ],
    )
    expect(out.content).toEqual([{ type: 'text', text: 'edit this' }])
    const entries = Object.values(out.pastedContents ?? {})
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      type: 'image',
      content: 'aGVsbG8=',
      mediaType: 'image/png',
    })
    expect(entries[0]!.sourcePath).toBeUndefined()
    expect(entries[1]!.content).toBe('d29ybGQ=')
    // ids renumbered from 1 without gaps
    expect(entries.map(e => e.id)).toEqual([1, 2])
  })

  test('image_paths entry is used as sourcePath when the file exists', () => {
    const real = join(tmpRoot, 'real.png')
    writeFileSync(real, 'png')
    const out = materializeStdinImageBlocks(
      { image_paths: [real] },
      [{ type: 'text', text: 'x' }, IMG()],
    )
    expect(Object.values(out.pastedContents ?? {})[0]!.sourcePath).toBe(real)
  })

  test('missing / relative / non-image_paths entries fall back to cache', () => {
    const missing = join(tmpRoot, 'nope.png')
    const cases = [missing, 'relative/img.png', 42] // 42 makes zod reject the whole array
    for (const bad of cases) {
      const out = materializeStdinImageBlocks({ image_paths: [bad] }, [IMG()])
      expect(Object.values(out.pastedContents ?? {})[0]!.sourcePath).toBeUndefined()
    }
  })

  test('alignment counts non-base64 image blocks without consuming them', () => {
    const real = join(tmpRoot, 'second.png')
    writeFileSync(real, 'png')
    const urlBlock = {
      type: 'image' as const,
      source: { type: 'url' as const, url: 'https://x/y.png' },
    }
    const out = materializeStdinImageBlocks(
      { image_paths: ['ignored-first', real] },
      [urlBlock, IMG()],
    )
    // url block kept verbatim in content, base64 one moved, aligned to index 1
    expect(out.content).toEqual([urlBlock])
    expect(Object.values(out.pastedContents ?? {})[0]!.sourcePath).toBe(real)
  })

  test('empty-payload image block stays in content', () => {
    const empty = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: '' },
    }
    const out = materializeStdinImageBlocks({}, [empty])
    expect(out.content).toEqual([empty])
    expect(out.pastedContents).toBeUndefined()
  })
})

describe('mergeQueuedPastedContents', () => {
  test('all undefined returns undefined', () => {
    expect(mergeQueuedPastedContents([undefined, undefined])).toBeUndefined()
  })

  test('re-numbers ids across maps to avoid collisions', () => {
    const a = { 1: { id: 1, type: 'image', content: 'aaa' } }
    const b = {
      1: { id: 1, type: 'image', content: 'bbb' },
      2: { id: 2, type: 'text', content: 'note' },
    }
    const merged = mergeQueuedPastedContents([a, undefined, b])!
    expect(Object.keys(merged).sort()).toEqual(['1', '2', '3'])
    expect(merged[1]!.content).toBe('aaa')
    expect(merged[2]!.content).toBe('bbb')
    expect(merged[2]!.id).toBe(2)
    expect(merged[3]!.content).toBe('note')
  })
})

describe('prependPathRefs regression', () => {
  test('targets the last text block', () => {
    const out = prependPathRefs(
      [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'last' },
      ],
      '@"x" ',
    )
    expect(out).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: '@\"x\" last' },
    ])
  })
})

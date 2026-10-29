import { afterEach, describe, expect, test } from 'bun:test'
import React, { type RefObject, useState } from 'react'
import { Stream } from 'stream'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import { AppStateProvider } from '../state/AppState.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import instances from '../ink/instances.js'
import { cellAt } from '../ink/screen.js'
import { Box, render, Text } from '../ink.js'
import { createUserMessage } from '../utils/messages.js'
import { FullscreenLayout } from './FullscreenLayout.js'
import { ScrollKeybindingHandler } from './ScrollKeybindingHandler.js'
import { VirtualMessageList } from './VirtualMessageList.js'

const ROWS = 24
const BOTTOM_ROW = ROWS - 1

class FakeStdout extends Stream {
  frames: string[] = []
  columns = 40
  rows = ROWS
  isTTY = true

  write(chunk: string | Uint8Array): boolean {
    this.frames.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }
}

class FakeStdin extends Stream {
  private pending: string[] = []
  isTTY = true
  isRaw = false

  setRawMode(enabled: boolean) {
    this.isRaw = enabled
    return this
  }

  setEncoding(_encoding: string) { return this }
  resume() { return this }
  pause() { return this }
  ref() {}
  unref() {}

  read(): string | null {
    return this.pending.shift() ?? null
  }

  pushKeys(keys: string) {
    this.pending.push(keys)
    this.emit('readable')
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await sleep(20)
  }
}

const previousEnv = new Map<string, string | undefined>()
const envKeys = ['CLAUDE_CODE_NO_FLICKER', 'CLAUDE_CODE_DISABLE_MOUSE', 'CLAUDE_CODE_DISABLE_MOUSE_CLICKS', 'TMUX']
for (const key of envKeys) previousEnv.set(key, process.env[key])
const wasInteractive = getIsInteractive()

let activeInstance: { unmount: () => void; cleanup: () => void } | null = null

afterEach(async () => {
  activeInstance?.unmount()
  activeInstance?.cleanup()
  activeInstance = null
  for (const key of envKeys) {
    const value = previousEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setIsInteractive(wasInteractive)
  await sleep(0)
})

type Harness = Awaited<ReturnType<typeof mountLayout>>

async function mountLayout({ count = 100, fullscreen = true, wrapped = false, virtual = false, wideLine = false }: { count?: number; fullscreen?: boolean; wrapped?: boolean; virtual?: boolean; wideLine?: boolean } = {}) {
  setIsInteractive(true)
  if (fullscreen) delete process.env.CLAUDE_CODE_NO_FLICKER
  else process.env.CLAUDE_CODE_NO_FLICKER = '0'
  delete process.env.TMUX
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS

  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const scrollRef: RefObject<ScrollBoxHandle | null> = React.createRef<ScrollBoxHandle>()
  const scrollEvents: boolean[] = []

  let setMessageCount: (count: number) => void = () => {}
  function Harness() {
    const [messageCount, setCount] = useState(count)
    const { rows, columns } = useTerminalSize()
    setMessageCount = setCount
    const layout = (
      <Box flexDirection="column" height={rows} width={columns} flexShrink={0}>
        <FullscreenLayout
          header={<Text>TOP</Text>}
          scrollRef={scrollRef}
          onScroll={sticky => { scrollEvents.push(sticky) }}
          scrollable={virtual ? (
            <VirtualMessageList
              messages={Array.from({ length: messageCount }, (_, index) => createUserMessage({
                content: `M${String(index).padStart(3, '0')}`,
                uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
              }))}
              scrollRef={scrollRef}
              columns={columns}
              itemKey={message => message.uuid}
              renderItem={(_, index) => <Text>M{String(index).padStart(3, '0')}</Text>}
            />
          ) : (
            <Box flexDirection="column">
              {wideLine && <Text>{'W'.repeat(39)}Z</Text>}
              {Array.from({ length: messageCount }, (_, index) => (
                <Text key={index}>M{String(index).padStart(3, '0')}</Text>
              ))}
            </Box>
          )}
          bottom={<Text>BOTTOM</Text>}
        />
      </Box>
    )
    return wrapped ? (
      <AppStateProvider>
        <KeybindingSetup>
          <ScrollKeybindingHandler
            scrollRef={scrollRef}
            isActive={fullscreen}
            onScroll={sticky => { scrollEvents.push(sticky) }}
          />
          {layout}
        </KeybindingSetup>
      </AppStateProvider>
    ) : layout
  }

  const instance = await render(<Harness />, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  activeInstance = instance
  const ink = instances.get(stdout) as any
  if (fullscreen) ink.setAltScreenActive(true, true)
  ink.onRender()
  await sleep(40)
  return {
    stdout,
    stdin,
    scrollRef,
    scrollEvents,
    ink,
    rerender: async (nextCount: number) => {
      setMessageCount(nextCount)
      await sleep(20)
    },
  }
}

function screenLines(harness: Harness): string[] {
  const screen = harness.ink.frontFrame.screen
  return Array.from({ length: screen.height }, (_, row) =>
    Array.from({ length: screen.width }, (_, col) => cellAt(screen, col, row)?.char ?? ' ').join('').trimEnd(),
  )
}

async function sendMouse(harness: Harness, sequence: string) {
  harness.stdin.pushKeys(sequence)
  await sleep(60)
}

describe('FullscreenLayout three-region viewport', () => {
  test('pins header and bottom while history, scrollbar, and streaming follow scroll state', async () => {
    const harness = await mountLayout()
    await until(() => screenLines(harness).some(line => line.includes('M099')), 'initial tail did not render')

    expect(screenLines(harness)[0]).toBe('TOP')
    expect(screenLines(harness)[BOTTOM_ROW]).toBe('BOTTOM')
    expect(screenLines(harness).join('\n')).not.toContain('M000')
    expect(screenLines(harness).some(line => line.includes('█') || line.includes('│'))).toBe(true)

    harness.scrollRef.current!.scrollTo(0)
    await until(() => screenLines(harness).some(line => line.includes('M000')), 'scrollTo(0) did not show the first message')
    expect(screenLines(harness)[0]).toBe('TOP')
    expect(screenLines(harness)[BOTTOM_ROW]).toBe('BOTTOM')
    expect(screenLines(harness).join('\n')).not.toContain('M099')

    expect(harness.scrollRef.current!.isSticky()).toBe(false)
    await harness.rerender(110)
    await sleep(80)
    expect(harness.scrollRef.current!.isSticky()).toBe(false)
    expect(screenLines(harness).join('\n')).toContain('M000')
    expect(screenLines(harness).join('\n')).not.toContain('M109')

    harness.scrollRef.current!.scrollToBottom()
    await until(() => screenLines(harness).some(line => line.includes('M109')), 'scrollToBottom did not reach the new tail')
    await harness.rerender(120)
    await until(() => screenLines(harness).some(line => line.includes('M119')), 'sticky mode did not follow appended content')
    expect(screenLines(harness)[0]).toBe('TOP')
    expect(screenLines(harness)[BOTTOM_ROW]).toBe('BOTTOM')
  })

  test('keeps the three regions intact after terminal resize', async () => {
    const harness = await mountLayout()
    harness.stdout.columns = 60
    harness.stdout.rows = 30
    harness.stdout.emit('resize')
    harness.ink.onRender()
    await until(() => screenLines(harness)[29] === 'BOTTOM', 'resize did not reflow the fixed regions')
    expect(screenLines(harness)[0]).toBe('TOP')
    expect(screenLines(harness).join('\n')).toContain('M099')
  })

  test('drops the fixed header on an extremely short terminal without losing the input region', async () => {
    const harness = await mountLayout()
    harness.stdout.rows = 12
    harness.stdout.emit('resize')
    harness.ink.onRender()
    await until(() => screenLines(harness)[11] === 'BOTTOM', 'short terminal did not keep the bottom region')
    expect(screenLines(harness).join('\n')).not.toContain('TOP')
    expect(screenLines(harness).some(line => line.includes('M099'))).toBe(true)
  })

  test('scrolls the middle viewport with real SGR wheel input', async () => {
    const harness = await mountLayout({ wrapped: true })
    const before = harness.scrollRef.current!.getScrollTop() + harness.scrollRef.current!.getPendingDelta()
    await sendMouse(harness, '\x1b[<64;10;5M')
    const afterUp = harness.scrollRef.current!.getScrollTop() + harness.scrollRef.current!.getPendingDelta()
    expect(afterUp).toBeLessThan(before)
    expect(screenLines(harness)[0]).toBe('TOP')
    expect(screenLines(harness)[BOTTOM_ROW]).toBe('BOTTOM')

    await sendMouse(harness, '\x1b[<65;10;5M')
    const afterDown = harness.scrollRef.current!.getScrollTop() + harness.scrollRef.current!.getPendingDelta()
    expect(afterDown).toBeGreaterThan(afterUp)
  })

  test('drags the scrollbar thumb without starting text selection or click dispatch', async () => {
    const harness = await mountLayout({ wrapped: true })
    await until(() => screenLines(harness)[ROWS - 2]?.endsWith('█') === true, 'bottom thumb did not render')

    await sendMouse(harness, '\x1b[<0;40;23M')
    await sendMouse(harness, '\x1b[<32;40;3M')
    await until(() => screenLines(harness).some(line => line.includes('M000')), 'thumb drag did not reach the first message')
    await sendMouse(harness, '\x1b[<0;40;3m')

    expect(harness.scrollRef.current!.getScrollTop()).toBe(0)
    expect(harness.ink.selection.isDragging).toBe(false)
    expect(harness.ink.hasTextSelection()).toBe(false)
    expect(screenLines(harness)[0]).toBe('TOP')
    expect(screenLines(harness)[BOTTOM_ROW]).toBe('BOTTOM')
    expect(harness.scrollEvents).toContain(false)
  })

  test('reserves the scrollbar column so full-width history keeps its last character', async () => {
    const harness = await mountLayout({ count: 60, wideLine: true })
    harness.scrollRef.current!.scrollTo(0)
    await until(() => screenLines(harness).some(line => line.includes('M000')), 'wide-line history did not scroll to the top')
    const lines = screenLines(harness)
    expect(lines.some(line => /^Z\s*[│█]$/.test(line))).toBe(true)
    expect(lines.some(line => line.endsWith('█') || line.endsWith('│'))).toBe(true)
    expect(lines[0]).toBe('TOP')
    expect(screenLines(harness)[BOTTOM_ROW]).toBe('BOTTOM')
  })

  test('virtual message list keeps long-session history scrollable inside the middle region', async () => {
    const harness = await mountLayout({ count: 300, virtual: true })
    await until(() => screenLines(harness).some(line => line.includes('M299')), 'virtual list tail did not render')
    expect(screenLines(harness)[0]).toBe('TOP')
    expect(screenLines(harness)[BOTTOM_ROW]).toBe('BOTTOM')
    expect(screenLines(harness).some(line => line.includes('│') || line.includes('█'))).toBe(true)

    for (let attempt = 0; attempt < 20 && !screenLines(harness).some(line => line.includes('M000')); attempt++) {
      harness.scrollRef.current!.scrollTo(0)
      await sleep(50)
    }
    expect(screenLines(harness).some(line => line.includes('M000'))).toBe(true)
    expect(screenLines(harness)[0]).toBe('TOP')
    expect(screenLines(harness)[BOTTOM_ROW]).toBe('BOTTOM')

    harness.scrollRef.current!.scrollToBottom()
    await until(() => screenLines(harness).some(line => line.includes('M299')), 'virtual list did not return to the tail')
  })

  test('legacy mode keeps sequential output and does not duplicate the fixed header', async () => {
    const harness = await mountLayout({ count: 2, fullscreen: false })
    const output = screenLines(harness).join('\n')
    expect(output).not.toContain('TOP')
    expect(output.indexOf('M000')).toBeLessThan(output.indexOf('BOTTOM'))
    expect(harness.scrollRef.current).toBeNull()
  })
})

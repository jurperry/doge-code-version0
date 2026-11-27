import React, { type RefObject, useCallback, useRef, useSyncExternalStore } from 'react'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { MouseEvent } from '../ink/events/mouse-event.js'
import { Box, Text } from '../ink.js'

type ScrollMetrics = {
  scrollHeight: number
  viewportHeight: number
  scrollTop: number
  pendingDelta: number
  sticky: boolean
}

export type ScrollbarGeometry = ScrollMetrics & {
  maxScroll: number
  effectiveScrollTop: number
  thumbHeight: number
  thumbTop: number
  visible: boolean
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

export function computeScrollbarGeometry(metrics: ScrollMetrics): ScrollbarGeometry {
  const viewportHeight = Math.max(0, Math.floor(metrics.viewportHeight))
  const scrollHeight = Math.max(0, Math.floor(metrics.scrollHeight))
  const maxScroll = Math.max(0, scrollHeight - viewportHeight)
  const visible = viewportHeight > 0 && maxScroll > 0
  const effectiveScrollTop = metrics.sticky
    ? maxScroll
    : clamp(Math.floor(metrics.scrollTop + metrics.pendingDelta), 0, maxScroll)
  const thumbHeight = visible
    ? Math.min(viewportHeight, Math.max(1, Math.floor(viewportHeight * viewportHeight / scrollHeight)))
    : 0
  const travel = Math.max(0, viewportHeight - thumbHeight)
  const thumbTop = visible && travel > 0
    ? Math.round(travel * effectiveScrollTop / maxScroll)
    : 0
  return {
    ...metrics,
    viewportHeight,
    scrollHeight,
    maxScroll,
    effectiveScrollTop,
    thumbHeight,
    thumbTop,
    visible,
  }
}

export function scrollTopForThumbRow(
  row: number,
  grabOffset: number,
  geometry: ScrollbarGeometry,
): number {
  const travel = geometry.viewportHeight - geometry.thumbHeight
  if (!geometry.visible || travel <= 0) return 0
  const thumbTop = clamp(Math.floor(row - grabOffset), 0, travel)
  return Math.round(thumbTop * geometry.maxScroll / travel)
}

function readGeometry(handle: ScrollBoxHandle | null): ScrollbarGeometry {
  return computeScrollbarGeometry({
    scrollHeight: handle?.getScrollHeight() ?? 0,
    viewportHeight: handle?.getViewportHeight() ?? 0,
    scrollTop: handle?.getScrollTop() ?? 0,
    pendingDelta: handle?.getPendingDelta() ?? 0,
    sticky: handle?.isSticky() ?? false,
  })
}

function snapshot(handle: ScrollBoxHandle | null): string {
  if (!handle) return '0|0|0|0'
  return [
    handle.getViewportHeight(),
    handle.getScrollHeight(),
    handle.getScrollTop() + handle.getPendingDelta(),
    handle.isSticky() ? 1 : 0,
  ].join('|')
}

type Props = {
  scrollRef?: RefObject<ScrollBoxHandle | null>
  paddingTop?: number
  onScroll?: (sticky: boolean, handle: ScrollBoxHandle) => void
}

export function ScrollBar({ scrollRef, paddingTop = 0, onScroll }: Props): React.ReactNode {
  const subscribe = useCallback(
    (listener: () => void) => scrollRef?.current?.subscribeToMetrics(listener) ?? (() => {}),
    [scrollRef],
  )
  const getSnapshot = useCallback(() => snapshot(scrollRef?.current ?? null), [scrollRef])
  useSyncExternalStore(subscribe, getSnapshot)
  const geometry = readGeometry(scrollRef?.current ?? null)
  const dragRef = useRef<{ grabOffset: number } | null>(null)

  const scrollTo = useCallback((target: number) => {
    const handle = scrollRef?.current
    if (!handle) return
    const current = readGeometry(handle)
    if (!current.visible) return
    const next = clamp(target, 0, current.maxScroll)
    const atBottom = next >= current.maxScroll
    if (atBottom && handle.isSticky()) return
    if (!atBottom && !handle.isSticky() && Math.abs(next - current.effectiveScrollTop) < 1) return
    if (atBottom) {
      handle.scrollToBottom()
    } else {
      handle.scrollTo(next)
    }
    onScroll?.(atBottom, handle)
  }, [scrollRef, onScroll])

  const onMouseDown = useCallback((event: MouseEvent) => {
    const handle = scrollRef?.current
    if (!handle) return
    const current = readGeometry(handle)
    if (!current.visible) return
    const row = event.localRow - paddingTop
    const travel = current.viewportHeight - current.thumbHeight
    if (row < 0 || row >= current.viewportHeight || travel <= 0) return
    event.preventDefault()
    event.stopPropagation()
    const onThumb = row >= current.thumbTop && row < current.thumbTop + current.thumbHeight
    const grabOffset = onThumb
      ? row - current.thumbTop
      : Math.floor(current.thumbHeight / 2)
    dragRef.current = { grabOffset }
    scrollTo(scrollTopForThumbRow(row, grabOffset, current))
  }, [scrollRef, paddingTop, scrollTo])

  const onMouseMove = useCallback((event: MouseEvent) => {
    const drag = dragRef.current
    const handle = scrollRef?.current
    if (!drag || !handle) return
    event.preventDefault()
    event.stopPropagation()
    scrollTo(scrollTopForThumbRow(
      event.localRow - paddingTop,
      drag.grabOffset,
      readGeometry(handle),
    ))
  }, [scrollRef, paddingTop, scrollTo])

  const endDrag = useCallback((event: MouseEvent) => {
    if (!dragRef.current) return
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = null
  }, [])

  if (!geometry.visible) return null

  return (
    <Box
      width={1}
      flexShrink={0}
      paddingTop={paddingTop}
      flexDirection="column"
      noSelect
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseCancel={endDrag}
    >
      {Array.from({ length: geometry.viewportHeight }, (_, row) => {
        const isThumb = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight
        return (
          <Text key={row} color={isThumb ? 'claude' : undefined} dimColor={!isThumb}>
            {isThumb ? '█' : '│'}
          </Text>
        )
      })}
    </Box>
  )
}

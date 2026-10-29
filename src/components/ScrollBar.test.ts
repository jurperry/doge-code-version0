import { describe, expect, test } from 'bun:test'
import { computeScrollbarGeometry, scrollTopForThumbRow } from './ScrollBar.js'

const metrics = (overrides = {}) => ({
  scrollHeight: 100,
  viewportHeight: 10,
  scrollTop: 0,
  pendingDelta: 0,
  sticky: false,
  ...overrides,
})

describe('computeScrollbarGeometry', () => {
  test('hides the scrollbar when all content fits', () => {
    const geometry = computeScrollbarGeometry(metrics({ scrollHeight: 10 }))
    expect(geometry.visible).toBe(false)
    expect(geometry.maxScroll).toBe(0)
    expect(geometry.thumbHeight).toBe(0)
    expect(geometry.thumbTop).toBe(0)
  })

  test('sizes and positions the thumb from real viewport metrics', () => {
    const geometry = computeScrollbarGeometry(metrics({ scrollHeight: 40, scrollTop: 15 }))
    expect(geometry).toMatchObject({
      visible: true,
      maxScroll: 30,
      effectiveScrollTop: 15,
      thumbHeight: 2,
      thumbTop: 4,
    })
  })

  test('keeps the thumb at least one row and clamps both ends', () => {
    const top = computeScrollbarGeometry(metrics({ scrollHeight: 1000, scrollTop: -20 }))
    const bottom = computeScrollbarGeometry(metrics({ scrollHeight: 1000, scrollTop: 2000 }))
    expect(top.thumbHeight).toBe(1)
    expect(top.thumbTop).toBe(0)
    expect(bottom.thumbHeight).toBe(1)
    expect(bottom.thumbTop).toBe(9)
  })

  test('includes pending wheel delta and clamps it to the scroll range', () => {
    const geometry = computeScrollbarGeometry(metrics({ scrollTop: 85, pendingDelta: 20 }))
    expect(geometry.effectiveScrollTop).toBe(90)
    expect(geometry.thumbTop).toBe(9)
  })

  test('sticky mode displays the live bottom even before the renderer catches up', () => {
    const geometry = computeScrollbarGeometry(metrics({ sticky: true, pendingDelta: -5 }))
    expect(geometry.effectiveScrollTop).toBe(90)
    expect(geometry.thumbTop).toBe(9)
  })

  test('handles one-row and empty viewports without division by zero', () => {
    expect(computeScrollbarGeometry(metrics({ viewportHeight: 1, scrollHeight: 2 }))).toMatchObject({
      visible: true,
      thumbHeight: 1,
      thumbTop: 0,
    })
    expect(computeScrollbarGeometry(metrics({ viewportHeight: 0 })).visible).toBe(false)
    expect(computeScrollbarGeometry(metrics({ viewportHeight: -3 })).visible).toBe(false)
  })
})

describe('scrollTopForThumbRow', () => {
  test('maps track coordinates to absolute content rows', () => {
    const geometry = computeScrollbarGeometry(metrics({ scrollHeight: 40 }))
    expect(scrollTopForThumbRow(4, 0, geometry)).toBe(15)
    expect(scrollTopForThumbRow(5, 1, geometry)).toBe(15)
  })

  test('supports centered track clicks and clamps dragged coordinates', () => {
    const geometry = computeScrollbarGeometry(metrics())
    const grabOffset = 0
    expect(scrollTopForThumbRow(4, grabOffset, geometry)).toBe(40)
    expect(scrollTopForThumbRow(-100, grabOffset, geometry)).toBe(0)
    expect(scrollTopForThumbRow(100, grabOffset, geometry)).toBe(90)
  })

  test('returns zero when there is no usable thumb travel', () => {
    expect(scrollTopForThumbRow(10, 0, computeScrollbarGeometry(metrics({ scrollHeight: 10 })))).toBe(0)
    expect(scrollTopForThumbRow(10, 0, computeScrollbarGeometry(metrics({ viewportHeight: 1, scrollHeight: 2 })))).toBe(0)
  })
})

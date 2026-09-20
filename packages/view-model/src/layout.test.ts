import { describe, expect, it } from 'vitest'
import { aggregateEdges, measureBox } from './layout.js'

describe('measureBox', () => {
  it('grows with row count and never measures the DOM', () => {
    const one = measureBox(1, 20, true)
    const five = measureBox(5, 20, true)
    expect(five.height).toBeGreaterThan(one.height)
    expect(five.width).toBe(one.width)
  })
  it('widens for a longer label', () => {
    expect(measureBox(1, 60, false).width).toBeGreaterThan(measureBox(1, 10, false).width)
  })
  it('has a minimum width so a tiny box is still clickable', () => {
    expect(measureBox(0, 1, false).width).toBeGreaterThanOrEqual(120)
  })
})

describe('aggregateEdges', () => {
  it('rolls edges up to the nearest visible ancestor and counts them', () => {
    const visibleBoxOf = (id: string) => (id.startsWith('a.') ? 'A' : id.startsWith('b.') ? 'B' : null)
    const result = aggregateEdges(
      [
        { from: 'a.one', to: 'b.one', kind: 'imports' },
        { from: 'a.two', to: 'b.two', kind: 'imports' },
        { from: 'a.one', to: 'a.two', kind: 'imports' },  // internal, dropped
        { from: 'a.one', to: 'hidden.x', kind: 'imports' }, // endpoint hidden, dropped
      ],
      visibleBoxOf,
    )
    expect(result).toEqual([{ from: 'A', to: 'B', count: 2 }])
  })
})

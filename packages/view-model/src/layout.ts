import type { Edge } from '@arcdiff/model'
import { compareIds } from '@arcdiff/model'

export interface BoxSize { width: number; height: number }

const HEADER_HEIGHT = 28
const ROW_HEIGHT = 18
const FOOTER_HEIGHT = 34
const CHAR_WIDTH = 7.2
const PADDING_X = 24
const MIN_WIDTH = 120

/**
 * Box dimensions from row count and label length, NEVER from the DOM.
 * elkjs needs sizes as input, so measuring rendered nodes would force a
 * measure -> layout -> re-measure loop that is both slow and prone to
 * oscillating when a relayout changes what is on screen.
 */
export function measureBox(
  rowCount: number, longestLabel: number, hasFooter: boolean,
): BoxSize {
  return {
    width: Math.max(MIN_WIDTH, Math.ceil(longestLabel * CHAR_WIDTH) + PADDING_X),
    height: HEADER_HEIGHT + rowCount * ROW_HEIGHT + (hasFooter ? FOOTER_HEIGHT : 0),
  }
}

/**
 * Roll every edge up to the nearest visible box. An edge whose endpoints land
 * in the same box is internal and dropped; one with a hidden endpoint is
 * dropped too, because drawing it would point at nothing.
 */
export function aggregateEdges(
  edges: readonly Edge[],
  visibleBoxOf: (id: string) => string | null,
): { from: string; to: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const edge of edges) {
    const from = visibleBoxOf(edge.from)
    const to = visibleBoxOf(edge.to)
    if (from === null || to === null || from === to) continue
    const key = `${from}\u0000${to}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('\u0000')
      return { from: from!, to: to!, count }
    })
    .sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to))
}
